/**
 * OAuth diagnostic CLI; `--refresh` also probes the refresh endpoint.
 * SAFE: does NOT consume any tokens against the chat endpoint.
 */
import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { CredentialsStore } from '../src/oauth/credentialsStore.js';
import { HttpRefreshClient } from '../src/oauth/refreshClient.js';
import { TokenManager } from '../src/oauth/TokenManager.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const wantRefresh = process.argv.includes('--refresh');

  const credPath = path.resolve(env.CREDENTIALS_PATH);
  console.log(`credentials: ${credPath}`);

  const store = new CredentialsStore(credPath);
  if (!(await store.exists())) {
    console.error('\n[fail] credentials file does not exist.');
    console.error('       Run: npx tsx scripts/bootstrap-credentials.ts');
    process.exit(2);
  }

  const refreshClient = new HttpRefreshClient({
    tokenUrl: env.ANTHROPIC_OAUTH_TOKEN_URL,
    clientId: env.CLAUDE_CLIENT_ID,
  });
  const tm = new TokenManager({ credentialsStore: store, refreshClient });

  const status = await tm.getStatus();
  console.log('\nstatus:');
  console.log(`  accessTokenValid:     ${status.accessTokenValid}`);
  console.log(`  expiresAt:            ${new Date(status.expiresAt).toISOString()}`);
  console.log(`  expiresInSeconds:     ${status.expiresInSeconds}`);
  console.log(`  isLongLived:          ${status.isLongLived}`);
  console.log(`  circuitBreakerState:  ${status.circuitBreakerState}`);

  if (!wantRefresh) {
    if (!status.accessTokenValid) {
      console.error('\n[warn] access token is expired. Re-run with --refresh to refresh it.');
      process.exit(1);
    }
    console.log('\n[ok] credentials look healthy.');
    return;
  }

  console.log('\nattempting refresh probe...');
  const before = await store.read();
  try {
    const fresh = await tm.forceRefresh();
    const rotated = fresh.refreshToken !== before.refreshToken;
    console.log(`[ok] refresh succeeded; refresh_token rotated: ${rotated}`);
    console.log(`     new expiresAt: ${new Date(fresh.expiresAt).toISOString()}`);
  } catch (err) {
    console.error('[fail] refresh failed:', (err as Error).message);
    process.exit(3);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
