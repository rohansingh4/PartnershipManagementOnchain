'use strict';

const Agreement = require('../lib/agreement');

// ─── Mock Factories ──────────────────────────────────────────────────────────

function makeStub(initialState = new Map()) {
  const worldState = new Map(initialState);
  const privateState = new Map();

  return {
    worldState,
    privateState,
    getState: jest.fn(async (key) => {
      const val = worldState.get(key);
      return val != null ? Buffer.from(val) : Buffer.from('');
    }),
    putState: jest.fn(async (key, value) => {
      worldState.set(key, value.toString());
    }),
    deleteState: jest.fn(async (key) => {
      worldState.delete(key);
    }),
    getPrivateData: jest.fn(async (collection, key) => {
      const val = privateState.get(`${collection}::${key}`);
      return val != null ? Buffer.from(val) : Buffer.from('');
    }),
    putPrivateData: jest.fn(async (collection, key, value) => {
      privateState.set(`${collection}::${key}`, value.toString());
    }),
    getPrivateDataHash: jest.fn(async () => Buffer.from('fakehash1234')),
    getTransient: jest.fn(() => new Map()),
    setEvent: jest.fn(),
    getTxID: jest.fn(() => 'mock-tx-id-001'),
    getStateByRange: jest.fn(async () => makeIterator([])),
    getQueryResult: jest.fn(async () => makeIterator([])),
    getHistoryForKey: jest.fn(async () => makeIterator([])),
    getQueryResultWithPagination: jest.fn(async () => ({
      iterator: makeIterator([]),
      metadata: { fetchedRecordsCount: 0, bookmark: '' }
    }))
  };
}

function makeClientIdentity(attrs = {}, mspId = 'Org1MSP') {
  return {
    getID: jest.fn(() => 'x509::/CN=testuser/O=org1/'),
    getMSPID: jest.fn(() => mspId),
    assertAttributeValue: jest.fn((attr, val) => attrs[attr] === val),
    getAttributeValue: jest.fn((attr) => attrs[attr] ?? null)
  };
}

function makeCtx(initialState = new Map(), attrs = {}, mspId = 'Org1MSP') {
  return {
    stub: makeStub(initialState),
    clientIdentity: makeClientIdentity(attrs, mspId)
  };
}

function makeIterator(items) {
  let idx = 0;
  return {
    next: jest.fn(async () => {
      if (idx >= items.length) return { done: true };
      const item = items[idx++];
      return {
        done: false,
        value: {
          key: item.key,
          value: Buffer.from(JSON.stringify(item.record ?? item)),
          txId: item.txId ?? 'tx1',
          timestamp: item.timestamp ?? null,
          is_delete: item.is_delete ?? false
        }
      };
    }),
    close: jest.fn(async () => {})
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let contract;
beforeEach(() => { contract = new Agreement(); });

// ── createAgreement ──
describe('createAgreement', () => {
  it('stores agreement with PENDING status and fires event', async () => {
    const ctx = makeCtx();
    await contract.createAgreement(ctx, JSON.stringify({ id: 'ag1', title: 'Deal' }));

    const [key, val] = ctx.stub.putState.mock.calls[0];
    expect(key).toBe('ag1');
    const saved = JSON.parse(val.toString());
    expect(saved.status).toBe('PENDING');
    expect(saved.createdBy).toBeTruthy();
    expect(ctx.stub.setEvent).toHaveBeenCalledWith('AgreementCreated', expect.any(Buffer));
  });

  it('throws when id is missing', async () => {
    const ctx = makeCtx();
    await expect(contract.createAgreement(ctx, JSON.stringify({ title: 'No ID' })))
      .rejects.toThrow('must have an id');
  });

  it('throws when agreement already exists', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1', status: 'PENDING' })]]);
    const ctx = makeCtx(state);
    await expect(contract.createAgreement(ctx, JSON.stringify({ id: 'ag1' })))
      .rejects.toThrow('already exists');
  });
});

// ── approveAgreement ──
describe('approveAgreement', () => {
  it('sets status to APPROVED and fires event', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1', status: 'PENDING' })]]);
    const ctx = makeCtx(state);

    await contract.approveAgreement(ctx, 'ag1');

    const saved = JSON.parse(ctx.stub.putState.mock.calls[0][1].toString());
    expect(saved.status).toBe('APPROVED');
    expect(ctx.stub.setEvent).toHaveBeenCalledWith('AgreementApproved', expect.any(Buffer));
  });

  it('throws when agreement does not exist', async () => {
    const ctx = makeCtx();
    await expect(contract.approveAgreement(ctx, 'missing')).rejects.toThrow('does not exist');
  });

  it('throws when agreement is not PENDING', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1', status: 'APPROVED' })]]);
    const ctx = makeCtx(state);
    await expect(contract.approveAgreement(ctx, 'ag1')).rejects.toThrow('must be PENDING');
  });
});

// ── deleteAgreement ──
describe('deleteAgreement', () => {
  it('deletes existing agreement', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1' })]]);
    const ctx = makeCtx(state);
    await contract.deleteAgreement(ctx, 'ag1');
    expect(ctx.stub.deleteState).toHaveBeenCalledWith('ag1');
  });

  it('throws when agreement does not exist', async () => {
    const ctx = makeCtx();
    await expect(contract.deleteAgreement(ctx, 'ghost')).rejects.toThrow('does not exist');
  });
});

// ── ABAC ──
describe('createRestrictedAgreement', () => {
  it('allows user with department=financial', async () => {
    const ctx = makeCtx(new Map(), { department: 'financial' });
    await expect(
      contract.createRestrictedAgreement(ctx, JSON.stringify({ id: 'r1' }))
    ).resolves.not.toThrow();
  });

  it('denies user without correct department attribute', async () => {
    const ctx = makeCtx(new Map(), { department: 'engineering' });
    await expect(
      contract.createRestrictedAgreement(ctx, JSON.stringify({ id: 'r2' }))
    ).rejects.toThrow('Access denied');
  });

  it('denies user with no attributes at all', async () => {
    const ctx = makeCtx();
    await expect(
      contract.createRestrictedAgreement(ctx, JSON.stringify({ id: 'r3' }))
    ).rejects.toThrow('Access denied');
  });
});

// ── Private Data ──
describe('addConfidentialTerms', () => {
  it('writes to private collection using transient data', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1', status: 'PENDING' })]]);
    const ctx = makeCtx(state);
    const terms = { agreementId: 'ag1', price: 5000, currency: 'USD' };
    ctx.stub.getTransient.mockReturnValue(
      new Map([['terms', Buffer.from(JSON.stringify(terms))]])
    );

    await contract.addConfidentialTerms(ctx);

    expect(ctx.stub.putPrivateData).toHaveBeenCalledWith(
      'Org1AgreementPrivate',
      'ag1',
      expect.any(Buffer)
    );
    // Verify the stored data contains the price
    const storedRaw = ctx.stub.putPrivateData.mock.calls[0][2];
    expect(JSON.parse(storedRaw.toString()).price).toBe(5000);
  });

  it('throws when transient field is missing', async () => {
    const ctx = makeCtx();
    await expect(contract.addConfidentialTerms(ctx)).rejects.toThrow('Transient field "terms"');
  });

  it('throws when underlying agreement does not exist', async () => {
    const ctx = makeCtx();
    ctx.stub.getTransient.mockReturnValue(
      new Map([['terms', Buffer.from(JSON.stringify({ agreementId: 'ghost' }))]])
    );
    await expect(contract.addConfidentialTerms(ctx)).rejects.toThrow('does not exist');
  });
});

describe('getConfidentialTermsHash', () => {
  it('returns hex hash of private data', async () => {
    const ctx = makeCtx();
    const result = await contract.getConfidentialTermsHash(ctx, 'ag1');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── Bulk ──
describe('createBulkAgreements', () => {
  it('creates all agreements in array', async () => {
    const ctx = makeCtx();
    const input = [{ id: 'b1', title: 'First' }, { id: 'b2', title: 'Second' }];
    await contract.createBulkAgreements(ctx, JSON.stringify(input));
    expect(ctx.stub.putState).toHaveBeenCalledTimes(2);
  });

  it('throws when input is not an array', async () => {
    const ctx = makeCtx();
    await expect(contract.createBulkAgreements(ctx, JSON.stringify({ id: 'x' })))
      .rejects.toThrow('must be a JSON array');
  });
});

// ── getAgreement ──
describe('getAgreement', () => {
  it('returns agreement JSON string', async () => {
    const state = new Map([['ag1', JSON.stringify({ id: 'ag1', status: 'PENDING' })]]);
    const ctx = makeCtx(state);
    const result = await contract.getAgreement(ctx, 'ag1');
    expect(JSON.parse(result).id).toBe('ag1');
  });

  it('throws when agreement does not exist', async () => {
    const ctx = makeCtx();
    await expect(contract.getAgreement(ctx, 'missing')).rejects.toThrow('does not exist');
  });
});
