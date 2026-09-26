import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialsStore } from '../../../src/oauth/credentialsStore.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-store-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('CredentialsStore', () => {
  it('round-trips a token set', async () => {
    const file = path.join(tmpDir, 'creds.json');
    const store = new CredentialsStore(file);
    const tokens = {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: 1_700_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    };
    await store.write(tokens);
    const back = await store.read();
    expect(back).toEqual(tokens);
  });

  it('creates parent directories on write', async () => {
    const file = path.join(tmpDir, 'nested', 'deeper', 'creds.json');
    const store = new CredentialsStore(file);
    await store.write({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 });
    const back = await store.read();
    expect(back.accessToken).toBe('a');
  });

  it('rejects malformed files', async () => {
    const file = path.join(tmpDir, 'bad.json');
    await fs.writeFile(file, '{"not_what_we_expected": true}');
    const store = new CredentialsStore(file);
    await expect(store.read()).rejects.toThrow(/claudeAiOauth/);
  });

  it('rejects when accessToken is missing', async () => {
    const file = path.join(tmpDir, 'bad2.json');
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: 1 } }));
    const store = new CredentialsStore(file);
    await expect(store.read()).rejects.toThrow(/accessToken/);
  });

  it('exists() reports correctly', async () => {
    const file = path.join(tmpDir, 'maybe.json');
    const store = new CredentialsStore(file);
    expect(await store.exists()).toBe(false);
    await store.write({ accessToken: 'a', refreshToken: 'b', expiresAt: 1 });
    expect(await store.exists()).toBe(true);
  });

  it('overwrite is atomic — no .tmp.* left over on success', async () => {
    const file = path.join(tmpDir, 'creds.json');
    const store = new CredentialsStore(file);
    await store.write({ accessToken: 'v1', refreshToken: 'r1', expiresAt: 100 });
    await store.write({ accessToken: 'v2', refreshToken: 'r2', expiresAt: 200 });
    const entries = await fs.readdir(tmpDir);
    expect(entries.some((e) => e.includes('.tmp.'))).toBe(false);
    expect((await store.read()).accessToken).toBe('v2');
  });
});
