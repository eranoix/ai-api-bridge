/**
 * Copies the OAuth credentials file from the standard Claude Code location
 * (`<homedir>/.claude/.credentials.json`) into the project's runtime location
 * (CREDENTIALS_PATH from .env).
 *
 * Run once after `claude login` on the same machine, or after dropping a
 * `claude setup-token` long-lived token into the source file.
 *
 *   npx tsx scripts/bootstrap-credentials.ts
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { CredentialsStore } from '../src/oauth/credentialsStore.js';
import type { TokenSet } from '../src/oauth/types.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const source = path.join(os.homedir(), '.claude', '.credentials.json');
  const dest = path.resolve(env.CREDENTIALS_PATH);

  console.log(`source: ${source}`);
  console.log(`dest:   ${dest}`);

  try {
    await fs.access(source);
  } catch {
    console.error(`\n[error] Source credentials not found at ${source}`);
    console.error('       Run `claude login` (or `claude setup-token`) first.');
    process.exit(1);
  }

  const raw = await fs.readFile(source, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('[error] Source file is not valid JSON.');
    process.exit(1);
  }

  const tokens = validate(parsed);
  const store = new CredentialsStore(dest);
  await store.write(tokens);

  const expiresIn = Math.max(0, Math.floor((tokens.expiresAt - Date.now()) / 1000));
  console.log(`\n[ok] credentials copied; access token valid for ${expiresIn}s`);
}

function validate(value: unknown): TokenSet {
  const root = value as { claudeAiOauth?: unknown };
  if (!root || typeof root.claudeAiOauth !== 'object' || root.claudeAiOauth === null) {
    throw new Error('source credentials missing claudeAiOauth');
  }
  const t = root.claudeAiOauth as Record<string, unknown>;
  if (typeof t.accessToken !== 'string') throw new Error('accessToken missing');
  if (typeof t.refreshToken !== 'string') throw new Error('refreshToken missing');
  if (typeof t.expiresAt !== 'number') throw new Error('expiresAt missing');
  const out: TokenSet = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken,
    expiresAt: t.expiresAt,
  };
  if (Array.isArray(t.scopes)) {
    out.scopes = t.scopes.filter((s): s is string => typeof s === 'string');
  }
  if (typeof t.subscriptionType === 'string') {
    out.subscriptionType = t.subscriptionType;
  }
  return out;
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
