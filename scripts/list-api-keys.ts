/**
 * List all API keys (active and revoked).
 *
 *   npx tsx scripts/list-api-keys.ts
 */
import { loadEnv } from '../src/config/env.js';
import { openDb } from '../src/storage/db.js';
import { ApiKeyStore } from '../src/auth/apiKeyStore.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = await openDb({ dbPath: env.DATABASE_PATH });
  const store = new ApiKeyStore(db);
  const rows = store.list();
  db.close();

  if (rows.length === 0) {
    console.log('(no API keys yet — create one with `npx tsx scripts/create-api-key.ts <name>`)');
    return;
  }

  console.log('');
  console.log('id  enabled  name                 prefix          created                last used               revoked');
  console.log('--  -------  -------------------  --------------  ---------------------  ---------------------  ---------------------');
  for (const r of rows) {
    const enabled = r.revokedAt ? 'no '  : r.enabled ? 'yes' : 'no ';
    const created = new Date(r.createdAt).toISOString().slice(0, 19);
    const lastUsed = r.lastUsedAt ? new Date(r.lastUsedAt).toISOString().slice(0, 19) : '—';
    const revoked = r.revokedAt ? new Date(r.revokedAt).toISOString().slice(0, 19) : '—';
    console.log(
      `${String(r.id).padEnd(2)}  ${enabled}      ${r.name.padEnd(19)}  ${r.keyPrefix.padEnd(14)}  ${created}    ${lastUsed.padEnd(21)}  ${revoked}`,
    );
  }
  console.log('');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
