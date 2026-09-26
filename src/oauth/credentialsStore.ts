import { promises as fs } from 'node:fs';
import { atomicWrite, ensureDir } from '../utils/atomicWrite.js';
import path from 'node:path';
import type { CredentialsFile, TokenSet } from './types.js';

export class CredentialsStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<TokenSet> {
    const raw = await fs.readFile(this.filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return assertTokenSet(parsed);
  }

  /**
   * Write the full credentials file atomically. Never a partial update, so a
   * crash cannot leave mixed-generation accessToken / refreshToken pairs.
   */
  async write(tokens: TokenSet): Promise<void> {
    await ensureDir(path.dirname(this.filePath));
    const file: CredentialsFile = { claudeAiOauth: { ...tokens } };
    await atomicWrite(this.filePath, JSON.stringify(file, null, 2), { mode: 0o600 });
  }
}

function assertTokenSet(value: unknown): TokenSet {
  if (typeof value !== 'object' || value === null) {
    throw new Error('credentials file: expected object at root');
  }
  const root = value as { claudeAiOauth?: unknown };
  if (typeof root.claudeAiOauth !== 'object' || root.claudeAiOauth === null) {
    throw new Error('credentials file: missing claudeAiOauth object');
  }
  const t = root.claudeAiOauth as Record<string, unknown>;
  if (typeof t.accessToken !== 'string' || t.accessToken.length === 0) {
    throw new Error('credentials file: accessToken missing or empty');
  }
  if (typeof t.refreshToken !== 'string' || t.refreshToken.length === 0) {
    throw new Error('credentials file: refreshToken missing or empty');
  }
  if (typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt)) {
    throw new Error('credentials file: expiresAt missing or invalid');
  }
  const set: TokenSet = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  };
  if (Array.isArray(t.scopes)) set.scopes = t.scopes.filter((s): s is string => typeof s === 'string');
  if (typeof t.subscriptionType === 'string') set.subscriptionType = t.subscriptionType;
  return set;
}
