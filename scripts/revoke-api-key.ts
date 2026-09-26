/**
 * Revoke an API key by name. Sets `revoked_at` so the key is rejected by the
 * auth middleware from the next request onward.
 *
 *   npx tsx scripts/revoke-api-key.ts <name>
 */
import { loadEnv } from '../src/config/env.js';
import { openDb } from '../src/storage/db.js';
import { ApiKeyStore } from '../src/auth/apiKeyStore.js';

async function main(): Promise<void> {
  const name = process.argv[2];
  if (!name) {
    console.error('usage: revoke-api-key.ts <name>');
    process.exit(1);
  }
  const env = loadEnv();
  const db = await openDb({ dbPath: env.DATABASE_PATH });
  const store = new ApiKeyStore(db);
  const ok = store.revoke(name);
  db.close();

  if (!ok) {
    console.error(`no active key named "${name}" found.`);
    process.exit(2);
  }
  console.log(`[ok] key "${name}" revoked.`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
