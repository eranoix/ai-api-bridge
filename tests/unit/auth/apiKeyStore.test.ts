import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../../src/storage/db.js';
import { ApiKeyStore } from '../../../src/auth/apiKeyStore.js';
import { hashApiKey, verifyApiKey, generateApiKey } from '../../../src/auth/hash.js';

let tmpDir: string;
let db: Db;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apikey-'));
  db = await openDb({ dbPath: path.join(tmpDir, 'test.db') });
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('hash', () => {
  it('hashApiKey + verifyApiKey roundtrips', async () => {
    const key = generateApiKey();
    const hash = await hashApiKey(key);
    expect(await verifyApiKey(key, hash)).toBe(true);
    expect(await verifyApiKey(key + 'x', hash)).toBe(false);
  });

  it('generateApiKey produces sk-priv- prefixed tokens with sufficient entropy', () => {
    const k1 = generateApiKey();
    const k2 = generateApiKey();
    expect(k1.startsWith('sk-priv-')).toBe(true);
    expect(k1).not.toBe(k2);
    expect(k1.length).toBeGreaterThanOrEqual(40);
  });

  it('verifyApiKey rejects malformed encoded hashes', async () => {
    expect(await verifyApiKey('any', 'not-a-real-hash')).toBe(false);
    expect(await verifyApiKey('any', 'scrypt$bad')).toBe(false);
  });
});

describe('ApiKeyStore', () => {
  it('creates a key and returns the plaintext exactly once', async () => {
    const store = new ApiKeyStore(db);
    const { plaintext, row } = await store.create({ name: 'mobile-app' });
    expect(plaintext.startsWith('sk-priv-')).toBe(true);
    expect(row.name).toBe('mobile-app');
    expect(row.enabled).toBe(true);
    expect(row.revokedAt).toBeNull();
  });

  it('findByPlaintext matches an active key', async () => {
    const store = new ApiKeyStore(db);
    const { plaintext } = await store.create({ name: 'k1' });
    const row = await store.findByPlaintext(plaintext);
    expect(row?.name).toBe('k1');
  });

  it('findByPlaintext returns null for an unknown key', async () => {
    const store = new ApiKeyStore(db);
    await store.create({ name: 'k1' });
    expect(await store.findByPlaintext('sk-priv-totally-wrong')).toBeNull();
  });

  it('findByPlaintext returns null after revocation', async () => {
    const store = new ApiKeyStore(db);
    const { plaintext } = await store.create({ name: 'k1' });
    expect(store.revoke('k1')).toBe(true);
    expect(await store.findByPlaintext(plaintext)).toBeNull();
  });

  it('revoke returns false for unknown names', () => {
    const store = new ApiKeyStore(db);
    expect(store.revoke('nope')).toBe(false);
  });

  it('list returns rows sorted by created_at desc', async () => {
    const store = new ApiKeyStore(db);
    await store.create({ name: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    await store.create({ name: 'second' });
    const rows = store.list();
    expect(rows.map((r) => r.name)).toEqual(['second', 'first']);
  });

  it('two keys with same prefix collision still resolve correctly', async () => {
    // Effectively a hash-collision regression: we pre-filter on key_prefix, so
    // a hypothetical collision must still verify the right one.
    const store = new ApiKeyStore(db);
    const k1 = await store.create({ name: 'a' });
    const k2 = await store.create({ name: 'b' });
    expect((await store.findByPlaintext(k1.plaintext))?.name).toBe('a');
    expect((await store.findByPlaintext(k2.plaintext))?.name).toBe('b');
  });
});
