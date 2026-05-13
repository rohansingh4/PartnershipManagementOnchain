# Hyperledger Fabric — Agreement Chaincode Learning Guide

Everything you need to understand this chaincode, test it properly, and deploy it.

---

## Table of Contents

1. [Data Storage Architecture](#1-data-storage-architecture)
2. [World State](#2-world-state)
3. [Private Data Collections (PDC)](#3-private-data-collections-pdc)
4. [Attribute-Based Access Control (ABAC)](#4-attribute-based-access-control-abac)
5. [Chaincode Events](#5-chaincode-events)
6. [CouchDB Rich Queries](#6-couchdb-rich-queries)
7. [History and Provenance](#7-history-and-provenance)
8. [Pagination](#8-pagination)
9. [Testing Strategy](#9-testing-strategy)
10. [Deployment Script Structure](#10-deployment-script-structure)
11. [Function Invocation Reference](#11-function-invocation-reference)

---

## 1. Data Storage Architecture

Understanding WHERE data lives is the most important mental model in Fabric.

```
┌─────────────────────────────────────────────────────────────┐
│                     HYPERLEDGER FABRIC                       │
│                                                             │
│  ┌──────────────┐        ┌──────────────────────────────┐  │
│  │   ORDERER    │        │         PEER                 │  │
│  │              │        │                              │  │
│  │  Blockchain  │◄───────│  ┌────────────────────────┐ │  │
│  │  (immutable  │  blocks│  │    World State DB       │ │  │
│  │   log)       │        │  │  (CouchDB / LevelDB)   │ │  │
│  │              │        │  │  current state of keys  │ │  │
│  │  Stores:     │        │  └────────────────────────┘ │  │
│  │  - tx data   │        │                              │  │
│  │  - PDC hash  │        │  ┌────────────────────────┐ │  │
│  │  - events    │        │  │  Private Data DB        │ │  │
│  │              │        │  │  (separate, per-org)    │ │  │
│  └──────────────┘        │  │  NOT in blocks!         │ │  │
│                          │  └────────────────────────┘ │  │
│                          └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

| Storage | Where | Who sees it | Immutable? |
|---|---|---|---|
| World State | CouchDB on every peer | All channel members | No (can be updated) |
| Blockchain log | Block files on every peer | All channel members | Yes (append-only) |
| Private Data | Private DB on authorized peers only | Only orgs in PDC policy | No (but hash on ledger is) |
| Transient data | In-memory only, during one tx | Only the invoked peer | Never persisted |

**Key insight:** World State is a cache. The blockchain is the truth. When a peer crashes and restarts, it rebuilds World State by replaying every block. This is why you cannot "delete" history — you can only `deleteState()` which marks the key as gone in World State, but the old value is still in every historic block.

---

## 2. World State

Every `putState(key, value)` call writes to the peer's CouchDB/LevelDB. The key is a string, the value is a byte array. By convention we store JSON.

### The transaction model

1. **Simulate** — peer executes chaincode against a _read-write set_, not the live DB. It records which keys were read (with their versions) and what the new values should be.
2. **Order** — the orderer sequences transactions into blocks.
3. **Validate + Commit** — each peer validates the read-write set against the current ledger (MVCC check: did any read key change since simulation?). If valid, it commits the new values.

This means two transactions that read the same key and both try to update it will conflict — only the first one commits. This is Fabric's MVCC (Multi-Version Concurrency Control).

### Common pitfalls

```js
// WRONG: loop + getState + putState in one tx — high MVCC collision risk
for (const id of ids) {
  const data = await ctx.stub.getState(id); // adds id to read set
  // ... modify ...
  await ctx.stub.putState(id, newData); // adds id to write set
}
// If another tx touched any of these keys between propose and commit → whole tx rejected

// RIGHT: push updates through events or design keys to avoid contention
```

---

## 3. Private Data Collections (PDC)

This is the most misunderstood feature. Read this carefully.

### The problem PDC solves

In a channel with Org1 and Org2, every transaction is visible to both. What if Org1 has confidential pricing terms they want Org2 to be able to _verify_ but not _read_? PDC solves this.

### How it works — step by step

```
1. Client (Org1 app)
   ├── Creates transaction proposal
   ├── Passes sensitive data via --transient flag
   │   (transient data is NEVER in the proposal that gets signed/ordered)
   └── Sends proposal to Org1 peer

2. Org1 peer
   ├── Executes chaincode: ctx.stub.getTransient() reads the transient map
   ├── Calls ctx.stub.putPrivateData('Org1AgreementPrivate', key, value)
   │   ├── Value is stored in Org1's private DB (NOT in the block)
   │   └── SHA256 hash of the value IS written to the block
   └── Returns endorsement

3. Orderer
   └── Orders the transaction — only sees the hash, never the actual data

4. All peers receive the block
   ├── Org1 peer: validates + stores private data in private DB
   └── Org2 peer: validates + stores the HASH only (cannot read private data)

5. Later: Org2 can call getPrivateDataHash('Org1AgreementPrivate', key)
   └── Gets the hash → can verify Org1's data matches without seeing contents
```

### The collections_config.json

```json
[
  {
    "name": "Org1AgreementPrivate",
    "policy": "OR('Org1MSP.member')",      ← who can READ and WRITE this collection
    "requiredPeerCount": 0,               ← min peers that must get data before tx commits
    "maxPeerCount": 1,                    ← max peers to distribute data to
    "blockToLive": 0,                     ← 0 = keep forever; N = purge after N blocks
    "memberOnlyRead": true,               ← non-members cannot even query the hash (Fabric 2.x)
    "memberOnlyWrite": true               ← non-members cannot write to this collection
  },
  {
    "name": "SharedAgreementTerms",
    "policy": "OR('Org1MSP.member', 'Org2MSP.member')",  ← both orgs can access
    "requiredPeerCount": 1,
    "maxPeerCount": 3,
    "blockToLive": 0,
    "memberOnlyRead": true,
    "memberOnlyWrite": false              ← any org can write (but read still restricted)
  }
]
```

**requiredPeerCount vs maxPeerCount:**
- `requiredPeerCount: 0` means the transaction commits even if private data gossip hasn't reached all peers yet. Good for Org1-only collections where Org2 doesn't need the data.
- `requiredPeerCount: 1` means at least 1 peer besides the endorser must acknowledge receipt before commit. Use this for shared collections so both orgs are guaranteed to have the data.

### Transient data — the key mechanism

```js
// Client-side (Node.js SDK or CLI)
// The transient field accepts base64-encoded JSON values
export TERMS=$(echo -n '{"agreementId":"ag1","price":9999}' | base64 | tr -d '\n')
peer chaincode invoke ... --transient "{\"terms\":\"$TERMS\"}" \
  -c '{"function":"addConfidentialTerms","Args":[]}'

// Chaincode-side
async addConfidentialTerms(ctx) {
  const transientMap = ctx.stub.getTransient();
  // transientMap is Map<string, Uint8Array>
  // Keys must match what the client passed in --transient
  const terms = JSON.parse(transientMap.get('terms').toString());
  await ctx.stub.putPrivateData('Org1AgreementPrivate', terms.agreementId, ...);
}
```

**Why transient?** The transaction proposal (which gets written to the block) must not contain sensitive data. Transient data rides alongside the proposal in a separate field that is stripped before ordering. This is a protocol-level guarantee — the orderer physically never receives transient data.

### Implicit private collections (Fabric 2.x new feature)

Fabric 2.x added implicit organization-scoped collections that you get for free without defining them in collections_config.json:

```js
// Automatically available for every org — no config needed
await ctx.stub.putPrivateData('_implicit_org_Org1MSP', key, data);
await ctx.stub.getPrivateData('_implicit_org_Org1MSP', key);
```

Use explicit collections (like we have) when you need shared access between orgs. Use implicit when you need purely org-scoped private storage.

### Common PDC mistakes

```js
// WRONG (the original contract's bug): uses putState instead of putPrivateData
// This puts data on the PUBLIC ledger — completely defeats the purpose
await ctx.stub.putState(parsedData.id, Buffer.from(JSON.stringify(parsedData)));

// CORRECT
await ctx.stub.putPrivateData('Org1AgreementPrivate', parsedData.id, ...);

// WRONG: passing private data as a regular argument
async addTerms(ctx, sensitiveTerms) { ... }
// This writes sensitiveTerms to the block as part of the transaction args — visible forever

// CORRECT: always use transient for sensitive data
async addTerms(ctx) {
  const terms = ctx.stub.getTransient().get('terms');
  ...
}
```

---

## 4. Attribute-Based Access Control (ABAC)

### How attributes get into certificates

When you register a user with fabric-ca, you assign attributes:

```bash
fabric-ca-client register \
  --id.name "alice" \
  --id.secret "alicepw" \
  --id.type "client" \
  --id.attrs "department=financial:ecert,role=approver:ecert" \
  --tls.certfiles $CA_TLS_CERT
```

The `:ecert` suffix embeds the attribute in the enrollment certificate. Without it, the attribute exists in the CA but won't be in the cert, so `assertAttributeValue` won't find it.

### Reading attributes in chaincode

```js
// ctx.clientIdentity is provided by fabric-contract-api — no extra import needed
const cid = ctx.clientIdentity;

cid.getMSPID()                              // "Org1MSP"
cid.getID()                                 // full X.509 DN string
cid.getAttributeValue('department')         // "financial" or null
cid.assertAttributeValue('department', 'financial')  // true / false
```

### Combining ABAC with MSP checks

```js
// Check both org membership AND role
if (ctx.clientIdentity.getMSPID() !== 'Org1MSP') {
  throw new Error('Only Org1 members can do this');
}
if (!ctx.clientIdentity.assertAttributeValue('role', 'approver')) {
  throw new Error('Only approvers can do this');
}
```

### Role hierarchy you can build

| Check | API call |
|---|---|
| Which org is the caller from? | `getMSPID()` |
| Which specific user is the caller? | `getID()` |
| Does the caller have attribute X=Y? | `assertAttributeValue('X','Y')` |
| What is the value of attribute X? | `getAttributeValue('X')` |

---

## 5. Chaincode Events

Events let your application react to on-chain changes without polling.

### Setting events in chaincode

```js
// setEvent(name, payload) — called during a transaction
// Only one event per transaction (last call wins)
ctx.stub.setEvent('AgreementCreated', Buffer.from(JSON.stringify({ id: 'ag1' })));
```

Events are written into the block alongside the transaction. They are not separate from the ledger — they are part of the block data.

### Subscribing to events in client application (Node.js SDK)

```js
// This is what you'll wire up in the API layer (next step)
const gateway = new Gateway();
await gateway.connect(ccp, { wallet, identity: 'appUser' });
const network = await gateway.getNetwork('mychannel');

// Listen to specific chaincode events
const listener = async (event) => {
  const agreementData = JSON.parse(event.payload.toString());
  console.log(`Event: ${event.eventName}`, agreementData);
};

await network.addBlockListener(listener);
// or more specifically:
const contract = network.getContract('agreement');
await contract.addContractListener(listener);
```

### Events vs queries — when to use which

- **Event** → something happened, notify subscribers reactively (webhook pattern)
- **Query** → you need current state or history on-demand

---

## 6. CouchDB Rich Queries

Rich queries use MongoDB-style selectors directly against CouchDB. They are NOT available with LevelDB (the default in many test configs). Your network uses CouchDB, so you're good.

### Query string format

```js
// Simple equality
const query = JSON.stringify({ selector: { status: 'APPROVED' } });

// Multiple conditions (implicit AND)
const query = JSON.stringify({
  selector: {
    status: 'PENDING',
    createdByMSP: 'Org1MSP'
  }
});

// Comparison operators
const query = JSON.stringify({
  selector: {
    amount: { '$gt': 1000 }
  }
});

// Sort (index must exist for this to work efficiently)
const query = JSON.stringify({
  selector: { status: 'PENDING' },
  sort: [{ createdAt: 'asc' }]
});
```

### Important: Rich queries are non-deterministic

Rich queries run against the current state of CouchDB at execution time. Two peers might get different results if one is slightly behind. **Never use rich queries to determine what you write in the same transaction** — it breaks determinism and your tx may fail validation.

```js
// WRONG: read via rich query then write based on result
const results = await ctx.stub.getQueryResult(...);
// ... then putState based on those results — this is non-deterministic!

// RIGHT: use getState(key) for deterministic reads when you'll write in same tx
```

### Range queries (always deterministic)

```js
// Get all keys from "" to "" = everything
await ctx.stub.getStateByRange('', '');

// Key prefix pattern: all keys starting with "agreement_"
await ctx.stub.getStateByRange('agreement_', 'agreement_~');
// '~' is ASCII 126, higher than all printable chars — effective prefix scan
```

---

## 7. History and Provenance

`getHistoryForKey(key)` returns every version a key has ever had, including deletes.

```js
// Returns array of:
{
  txId: "abc123",
  timestamp: { seconds: "1715000000", nanos: 0 },
  isDelete: "false",
  value: { id: "ag1", status: "PENDING", ... }
}
```

**Why this is powerful:** Even after `deleteState(key)`, the history shows every prior value. The blockchain is immutable — you can always audit who changed what and when.

**Limitation:** History is only available if the peer was running when those transactions were committed. If a peer joined the channel after block N, it won't have history for transactions before N.

---

## 8. Pagination

Rich queries without pagination can return thousands of records and OOM your peer. Always paginate in production.

```js
// First page
const result = await contract.getAgreementsWithPagination(
  ctx,
  JSON.stringify({ selector: { status: 'APPROVED' } }),
  '10',    // pageSize as string
  ''       // empty bookmark = first page
);

const { data, metadata } = JSON.parse(result);
// metadata.bookmark is a cursor for the next page

// Next page
const nextResult = await contract.getAgreementsWithPagination(
  ctx,
  JSON.stringify({ selector: { status: 'APPROVED' } }),
  '10',
  metadata.bookmark   // pass the bookmark from previous call
);
```

Bookmarks are opaque strings managed by CouchDB — do not parse or construct them, just pass them through.

---

## 9. Testing Strategy

Three levels, use in order:

### Level 1 — Unit Tests (Jest, no Docker)

What you have in `test/agreement.test.js`. The trick is mocking `ctx.stub` and `ctx.clientIdentity`.

```bash
npm test
```

This tests all the business logic, ABAC rules, error cases, and private data flows without any Fabric infrastructure. Run this on every code change.

**What mocks can't test:**
- Actual CouchDB query execution (mock always returns empty iterator)
- MVCC conflicts
- TLS, endorsement policy enforcement
- Actual private data gossip

### Level 2 — Peer CLI Integration Tests (Docker network required)

After deploying chaincode (see Section 10), test every function using the peer CLI.

**Set up your environment variables once (put in a script):**

```bash
export FABRIC_CFG_PATH=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/config
export ORDERER_CA=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/crypto-config/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem

# Org1 peer context
setOrg1() {
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="Org1MSP"
  export CORE_PEER_ADDRESS=localhost:7051
  export CORE_PEER_MSPCONFIGPATH=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/crypto-config/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp
  export CORE_PEER_TLS_ROOTCERT_FILE=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt
}

# Org2 peer context
setOrg2() {
  export CORE_PEER_TLS_ENABLED=true
  export CORE_PEER_LOCALMSPID="Org2MSP"
  export CORE_PEER_ADDRESS=localhost:9051
  export CORE_PEER_MSPCONFIGPATH=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/crypto-config/peerOrganizations/org2.example.com/users/Admin@org2.example.com/msp
  export CORE_PEER_TLS_ROOTCERT_FILE=/home/rohan/Projects/PartnershipManagementOnchain/Blockchain/artifacts/channel/crypto-config/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt
}

export PEER0_ORG1_CA=$CORE_PEER_TLS_ROOTCERT_FILE
```

**Invoke (write) — requires endorsement from both orgs:**

```bash
setOrg1
peer chaincode invoke \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $ORDERER_CA \
  -C mychannel -n agreement \
  --peerAddresses localhost:7051 --tlsRootCertFiles $PEER0_ORG1_CA \
  --peerAddresses localhost:9051 --tlsRootCertFiles $PEER0_ORG2_CA \
  -c '{"function":"createAgreement","Args":["{\"id\":\"ag1\",\"title\":\"Test Deal\"}"]}'
```

**Query (read — no ordering, no endorsement from other org):**

```bash
setOrg1
peer chaincode query \
  -C mychannel -n agreement \
  -c '{"function":"getAgreement","Args":["ag1"]}'
```

**Invoke with transient data (private data):**

```bash
setOrg1
TERMS=$(echo -n '{"agreementId":"ag1","price":9999,"currency":"USD"}' | base64 | tr -d '\n')
peer chaincode invoke \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $ORDERER_CA \
  -C mychannel -n agreement \
  --peerAddresses localhost:7051 --tlsRootCertFiles $PEER0_ORG1_CA \
  --peerAddresses localhost:9051 --tlsRootCertFiles $PEER0_ORG2_CA \
  --transient "{\"terms\":\"$TERMS\"}" \
  -c '{"function":"addConfidentialTerms","Args":[]}'
```

**Read private data (only from Org1 peer):**

```bash
setOrg1
peer chaincode query \
  -C mychannel -n agreement \
  -c '{"function":"getConfidentialTerms","Args":["ag1"]}'
```

**Verify private data hash (from Org2 peer — no direct access to data):**

```bash
setOrg2
peer chaincode query \
  -C mychannel -n agreement \
  -c '{"function":"getConfidentialTermsHash","Args":["ag1"]}'
```

### Level 3 — Application Tests (SDK)

After the API layer is built, test end-to-end with the Node.js fabric-network SDK. This is covered when you get to the API step.

---

## 10. Deployment Script Structure

The Fabric 2.x lifecycle has 5 phases. All 5 must complete before a chaincode can be invoked.

```
┌──────────────────────────────────────────────────────────────────┐
│                  Fabric 2.x Chaincode Lifecycle                  │
│                                                                  │
│  1. PACKAGE     → creates agreement.tar.gz (done once)          │
│  2. INSTALL     → install on each peer (Org1 + Org2)            │
│  3. APPROVE     → each org approves (governance step)           │
│  4. CHECK       → verify all orgs have approved                 │
│  5. COMMIT      → one org commits to the channel                │
│                                                                  │
│  For upgrades: repeat 1-5 with --sequence incremented           │
└──────────────────────────────────────────────────────────────────┘
```

### Phase 1 — Package

```bash
# Run from artifacts/ directory
peer lifecycle chaincode package chaincode/agreement/agreement.tar.gz \
  --path ./chaincode/agreement \
  --lang node \
  --label agreement_1.0
```

The label (`agreement_1.0`) is human-readable only. Fabric generates a hash-based package ID.

### Phase 2 — Install on each peer

```bash
# Install on Org1 peer
setOrg1
peer lifecycle chaincode install chaincode/agreement/agreement.tar.gz

# Install on Org2 peer
setOrg2
peer lifecycle chaincode install chaincode/agreement/agreement.tar.gz

# Get the package ID (same for both since same tar.gz)
setOrg1
peer lifecycle chaincode queryinstalled
# Output: Installed chaincodes on peer:
# Package ID: agreement_1.0:abc123..., Label: agreement_1.0

export CC_PACKAGE_ID=agreement_1.0:abc123...   # copy from above output
```

### Phase 3 — Approve for each org

```bash
# Approve for Org1
setOrg1
peer lifecycle chaincode approveformyorg \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $ORDERER_CA \
  --channelID mychannel \
  --name agreement \
  --version 1.0 \
  --package-id $CC_PACKAGE_ID \
  --sequence 1 \
  --collections-config ./chaincode/agreement/collections_config.json

# Approve for Org2
setOrg2
peer lifecycle chaincode approveformyorg \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $ORDERER_CA \
  --channelID mychannel \
  --name agreement \
  --version 1.0 \
  --package-id $CC_PACKAGE_ID \
  --sequence 1 \
  --collections-config ./chaincode/agreement/collections_config.json
```

**Important:** If you use private data collections, you MUST pass `--collections-config` in both `approveformyorg` and `commit`. If you forget it in approve but add it in commit, the commit will fail because the approved definition doesn't match.

### Phase 4 — Check commit readiness

```bash
setOrg1
peer lifecycle chaincode checkcommitreadiness \
  --channelID mychannel \
  --name agreement \
  --version 1.0 \
  --sequence 1 \
  --collections-config ./chaincode/agreement/collections_config.json \
  --output json
```

Expected output (both orgs must be `true`):
```json
{
  "approvals": {
    "Org1MSP": true,
    "Org2MSP": true
  }
}
```

### Phase 5 — Commit

```bash
setOrg1
peer lifecycle chaincode commit \
  -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile $ORDERER_CA \
  --channelID mychannel \
  --name agreement \
  --version 1.0 \
  --sequence 1 \
  --collections-config ./chaincode/agreement/collections_config.json \
  --peerAddresses localhost:7051 \
  --tlsRootCertFiles $PEER0_ORG1_CA \
  --peerAddresses localhost:9051 \
  --tlsRootCertFiles $PEER0_ORG2_CA
```

**Verify commit:**
```bash
peer lifecycle chaincode querycommitted --channelID mychannel --name agreement
```

### Upgrading the chaincode

After code changes:
1. Change `--version` to `1.1` (or whatever) AND increment `--sequence` to `2`
2. Re-package → re-install on each peer → re-approve with new version+sequence → re-commit
3. The old version continues running until commit completes

```bash
# Upgrade sequence example
peer lifecycle chaincode package agreement_v1.1.tar.gz --path ./chaincode/agreement --lang node --label agreement_1.1
# ... install, approve with --version 1.1 --sequence 2 ... commit
```

---

## 11. Function Invocation Reference

All arguments to chaincode functions are strings. JSON must be passed as a JSON-encoded string argument.

### Public Agreement Functions

| Function | Type | Args | Notes |
|---|---|---|---|
| `createAgreement` | invoke | `agreementData` (JSON string) | Fires `AgreementCreated` event |
| `approveAgreement` | invoke | `agreementId` | Must be PENDING status |
| `updateAgreement` | invoke | `agreementData` (JSON string) | Must include `id` field |
| `deleteAgreement` | invoke | `id` | Fires `AgreementDeleted` event |
| `getAgreement` | query | `id` | Returns JSON string |
| `agreementExists` | query | `id` | Returns boolean |
| `createBulkAgreements` | invoke | `data` (JSON array string) | Each item needs `id` |

### ABAC Functions

| Function | Type | Args | Requirement |
|---|---|---|---|
| `createRestrictedAgreement` | invoke | `agreementData` | Caller needs `department=financial` cert attribute |

### Private Data Functions

| Function | Type | Transient | Collection | Notes |
|---|---|---|---|---|
| `addConfidentialTerms` | invoke | `terms` (JSON with `agreementId`) | `Org1AgreementPrivate` | Only Org1 |
| `addSharedConfidentialTerms` | invoke | `terms` (JSON with `agreementId`) | `SharedAgreementTerms` | Org1 + Org2 |
| `getConfidentialTerms` | query | — | `Org1AgreementPrivate` | Only Org1 peer |
| `getSharedConfidentialTerms` | query | — | `SharedAgreementTerms` | Org1 or Org2 |
| `getConfidentialTermsHash` | query | — | `Org1AgreementPrivate` | Any peer, returns hex hash |

### Query Functions

| Function | Type | Args | Notes |
|---|---|---|---|
| `getAllAgreements` | query | — | Range scan, all keys |
| `queryAgreementsByStatus` | query | `status` | CouchDB only |
| `queryAgreements` | query | `queryString` (CouchDB selector JSON) | CouchDB only |
| `getAgreementsWithPagination` | query | `queryString`, `pageSize`, `bookmark` | Returns data + metadata |
| `getAgreementHistory` | query | `id` | All historic values for key |

### Quick CLI test sequence

```bash
# 1. Create
peer chaincode invoke ... -c '{"function":"createAgreement","Args":["{\"id\":\"ag1\",\"title\":\"Deal\",\"amount\":5000}"]}'

# 2. Read
peer chaincode query ... -c '{"function":"getAgreement","Args":["ag1"]}'

# 3. Add private terms
TERMS=$(echo -n '{"agreementId":"ag1","price":9999}' | base64 | tr -d '\n')
peer chaincode invoke ... --transient "{\"terms\":\"$TERMS\"}" \
  -c '{"function":"addConfidentialTerms","Args":[]}'

# 4. Read private terms (Org1 only)
peer chaincode query ... -c '{"function":"getConfidentialTerms","Args":["ag1"]}'

# 5. Verify hash from Org2 (switch to Org2 env)
peer chaincode query ... -c '{"function":"getConfidentialTermsHash","Args":["ag1"]}'

# 6. Approve
peer chaincode invoke ... -c '{"function":"approveAgreement","Args":["ag1"]}'

# 7. Query by status
peer chaincode query ... -c '{"function":"queryAgreementsByStatus","Args":["APPROVED"]}'

# 8. Get history
peer chaincode query ... -c '{"function":"getAgreementHistory","Args":["ag1"]}'
```

---

## What's Next

```
Current:  Chaincode (this folder) ✓
Next:     Deployment scripts (scripts/ folder)
After:    API layer (Node.js + fabric-network SDK)
          ├── Wallet management
          ├── Gateway connection
          ├── Transaction submission
          └── Event listeners
```

The scripts folder will wrap everything in Section 10 into shell scripts:
- `deployCC.sh` — package + install + approve + commit
- `invokeCC.sh` — parameterized invoke helper
- `upgradeCC.sh` — bump version + sequence and redeploy
