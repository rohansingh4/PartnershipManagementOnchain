'use strict';

const { Contract } = require('fabric-contract-api');

// Collection names must exactly match collections_config.json
const COLLECTION_ORG1 = 'Org1AgreementPrivate';
const COLLECTION_SHARED = 'SharedAgreementTerms';

class Agreement extends Contract {

  // ─── World State: Public Agreement Lifecycle ─────────────────────────────

  async createAgreement(ctx, agreementData) {
    const agreement = JSON.parse(agreementData);
    if (!agreement.id) throw new Error('Agreement must have an id field');

    const exists = await this.agreementExists(ctx, agreement.id);
    if (exists) throw new Error(`Agreement ${agreement.id} already exists`);

    agreement.status = 'PENDING';
    agreement.createdAt = new Date().toISOString();
    agreement.createdBy = ctx.clientIdentity.getID();
    agreement.createdByMSP = ctx.clientIdentity.getMSPID();

    const data = Buffer.from(JSON.stringify(agreement));
    await ctx.stub.putState(agreement.id, data);

    // Events are written to the block — subscribers (SDK/apps) receive them
    ctx.stub.setEvent('AgreementCreated', data);
    return ctx.stub.getTxID();
  }

  async approveAgreement(ctx, agreementId) {
    const raw = await ctx.stub.getState(agreementId);
    if (!raw || raw.length === 0) throw new Error(`Agreement ${agreementId} does not exist`);

    const agreement = JSON.parse(raw.toString());
    if (agreement.status !== 'PENDING') {
      throw new Error(`Agreement ${agreementId} must be PENDING to approve, current status: ${agreement.status}`);
    }

    agreement.status = 'APPROVED';
    agreement.approvedBy = ctx.clientIdentity.getID();
    agreement.approvedAt = new Date().toISOString();

    const data = Buffer.from(JSON.stringify(agreement));
    await ctx.stub.putState(agreementId, data);

    ctx.stub.setEvent('AgreementApproved', Buffer.from(JSON.stringify({ id: agreementId })));
    return ctx.stub.getTxID();
  }

  async updateAgreement(ctx, agreementData) {
    const update = JSON.parse(agreementData);
    if (!update.id) throw new Error('Agreement must have an id field');

    const exists = await this.agreementExists(ctx, update.id);
    if (!exists) throw new Error(`Agreement ${update.id} does not exist`);

    update.updatedAt = new Date().toISOString();
    update.updatedBy = ctx.clientIdentity.getID();

    await ctx.stub.putState(update.id, Buffer.from(JSON.stringify(update)));
    return ctx.stub.getTxID();
  }

  async deleteAgreement(ctx, id) {
    const exists = await this.agreementExists(ctx, id);
    if (!exists) throw new Error(`Agreement ${id} does not exist`);
    await ctx.stub.deleteState(id);
    ctx.stub.setEvent('AgreementDeleted', Buffer.from(JSON.stringify({ id })));
    return ctx.stub.getTxID();
  }

  async getAgreement(ctx, id) {
    const data = await ctx.stub.getState(id);
    if (!data || data.length === 0) throw new Error(`Agreement ${id} does not exist`);
    return data.toString();
  }

  async agreementExists(ctx, id) {
    const data = await ctx.stub.getState(id);
    return !!(data && data.length > 0);
  }

  // ─── ABAC: Attribute-Based Access Control ────────────────────────────────
  //
  // Attributes are embedded in the user's enrollment certificate by the CA.
  // fabric-ca enrolls users with --id.attrs "department=financial:ecert"
  // The :ecert suffix means the attribute is included in the signing cert.
  // ctx.clientIdentity is available automatically — no extra import needed.

  async createRestrictedAgreement(ctx, agreementData) {
    if (!ctx.clientIdentity.assertAttributeValue('department', 'financial')) {
      throw new Error(
        `Access denied: caller MSP=${ctx.clientIdentity.getMSPID()} ` +
        `does not have department=financial attribute`
      );
    }

    const agreement = JSON.parse(agreementData);
    if (!agreement.id) throw new Error('Agreement must have an id field');

    const exists = await this.agreementExists(ctx, agreement.id);
    if (exists) throw new Error(`Agreement ${agreement.id} already exists`);

    agreement.restricted = true;
    agreement.status = 'PENDING';
    agreement.createdBy = ctx.clientIdentity.getID();
    agreement.createdByMSP = ctx.clientIdentity.getMSPID();
    agreement.createdAt = new Date().toISOString();

    await ctx.stub.putState(agreement.id, Buffer.from(JSON.stringify(agreement)));
    return ctx.stub.getTxID();
  }

  // ─── Private Data Collections ─────────────────────────────────────────────
  //
  // Private data is NEVER stored on the main ledger or in blocks.
  // It lives in a separate private database on authorized peers only.
  // The block only records the HASH of private data for tamper-detection.
  //
  // Transient data is the mechanism clients use to pass private data to the
  // chaincode WITHOUT it appearing in the transaction proposal (which gets
  // written to the block). It is only available during the transaction.
  //
  // Flow:
  //   Client SDK → --transient '{"terms":"<base64>"}' → peer (not gossiped, not logged)
  //   Chaincode   → ctx.stub.getTransient()            → reads the in-memory transient map
  //   Chaincode   → ctx.stub.putPrivateData(...)       → writes to private DB of authorized orgs

  async addConfidentialTerms(ctx) {
    const transientMap = ctx.stub.getTransient();

    if (!transientMap.has('terms')) {
      throw new Error('Transient field "terms" is required (pass via --transient flag)');
    }

    // transientMap.get() returns Uint8Array/Buffer — call toString() to decode
    const terms = JSON.parse(transientMap.get('terms').toString());
    if (!terms.agreementId) throw new Error('terms must include agreementId');

    const exists = await this.agreementExists(ctx, terms.agreementId);
    if (!exists) throw new Error(`Agreement ${terms.agreementId} does not exist`);

    // Only Org1 peers store this data (defined in collections_config.json)
    await ctx.stub.putPrivateData(
      COLLECTION_ORG1,
      terms.agreementId,
      Buffer.from(JSON.stringify(terms))
    );
    return ctx.stub.getTxID();
  }

  async addSharedConfidentialTerms(ctx) {
    const transientMap = ctx.stub.getTransient();

    if (!transientMap.has('terms')) {
      throw new Error('Transient field "terms" is required');
    }

    const terms = JSON.parse(transientMap.get('terms').toString());
    if (!terms.agreementId) throw new Error('terms must include agreementId');

    // Both Org1 and Org2 peers store this data
    await ctx.stub.putPrivateData(
      COLLECTION_SHARED,
      terms.agreementId,
      Buffer.from(JSON.stringify(terms))
    );
    return ctx.stub.getTxID();
  }

  async getConfidentialTerms(ctx, agreementId) {
    const data = await ctx.stub.getPrivateData(COLLECTION_ORG1, agreementId);
    if (!data || data.length === 0) {
      throw new Error(`No confidential terms found for agreement ${agreementId}`);
    }
    return data.toString();
  }

  async getSharedConfidentialTerms(ctx, agreementId) {
    const data = await ctx.stub.getPrivateData(COLLECTION_SHARED, agreementId);
    if (!data || data.length === 0) {
      throw new Error(`No shared terms found for agreement ${agreementId}`);
    }
    return data.toString();
  }

  // Org2 can verify Org1's private data is authentic without seeing the contents.
  // The hash is stored on the main ledger during putPrivateData — any org can read it.
  async getConfidentialTermsHash(ctx, agreementId) {
    const hash = await ctx.stub.getPrivateDataHash(COLLECTION_ORG1, agreementId);
    if (!hash || hash.length === 0) {
      throw new Error(`No private data hash found for agreement ${agreementId}`);
    }
    return Buffer.from(hash).toString('hex');
  }

  // ─── Bulk Operations ──────────────────────────────────────────────────────

  async createBulkAgreements(ctx, data) {
    const agreements = JSON.parse(data);
    if (!Array.isArray(agreements)) throw new Error('Input must be a JSON array');

    for (const agreement of agreements) {
      if (!agreement.id) throw new Error('Each agreement must have an id field');
      agreement.status = 'PENDING';
      agreement.createdAt = new Date().toISOString();
      await ctx.stub.putState(agreement.id, Buffer.from(JSON.stringify(agreement)));
    }

    return ctx.stub.getTxID();
  }

  // ─── Rich Queries (CouchDB only — not LevelDB) ───────────────────────────

  async getAllAgreements(ctx) {
    const iterator = await ctx.stub.getStateByRange('', '');
    return JSON.stringify(await this._collectResults(iterator, false));
  }

  async queryAgreementsByStatus(ctx, status) {
    const queryString = JSON.stringify({ selector: { status } });
    const iterator = await ctx.stub.getQueryResult(queryString);
    return JSON.stringify(await this._collectResults(iterator, false));
  }

  async queryAgreements(ctx, queryString) {
    const iterator = await ctx.stub.getQueryResult(queryString);
    return JSON.stringify(await this._collectResults(iterator, false));
  }

  async getAgreementsWithPagination(ctx, queryString, pageSize, bookmark) {
    const { iterator, metadata } = await ctx.stub.getQueryResultWithPagination(
      queryString,
      parseInt(pageSize, 10),
      bookmark
    );
    const results = await this._collectResults(iterator, false);
    return JSON.stringify({
      data: results,
      metadata: {
        recordsCount: metadata.fetchedRecordsCount,
        bookmark: metadata.bookmark
      }
    });
  }

  // Returns full mutation history for a key (all txs that ever wrote/deleted it)
  async getAgreementHistory(ctx, id) {
    const iterator = await ctx.stub.getHistoryForKey(id);
    return JSON.stringify(await this._collectResults(iterator, true));
  }

  // ─── Internal Helper ──────────────────────────────────────────────────────

  async _collectResults(iterator, isHistory) {
    const results = [];
    try {
      while (true) {
        const res = await iterator.next();

        // IMPORTANT: check done BEFORE accessing res.value — when done=true,
        // value is undefined and accessing .value.toString() will crash.
        if (res.done) break;

        let parsed;
        try {
          parsed = JSON.parse(res.value.value.toString('utf8'));
        } catch (_) {
          parsed = res.value.value.toString('utf8');
        }

        if (isHistory) {
          results.push({
            txId: res.value.txId,
            timestamp: res.value.timestamp,
            isDelete: res.value.is_delete ? res.value.is_delete.toString() : 'false',
            value: parsed
          });
        } else {
          results.push({ key: res.value.key, record: parsed });
        }
      }
    } finally {
      await iterator.close();
    }
    return results;
  }
}

module.exports = Agreement;
