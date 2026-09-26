/**
 * Create a new API key:
 *   npx tsx scripts/create-api-key.ts <name> [--rpm <n>] [--tpm <n>] [--daily <n>]
 * The plaintext is printed ONCE and cannot be recovered.
 */
import { loadEnv } from '../src/config/env.js';
import { openDb } from '../src/storage/db.js';
import { ApiKeyStore } from '../src/auth/apiKeyStore.js';

interface Args {
  name: string;
  rpm?: number;
  tpm?: number;
  daily?: number;
}

function parseArgs(argv: string[]): Args {
  const name = argv[0];
  if (!name || name.startsWith('--')) {
    console.error('usage: create-api-key.ts <name> [--rpm N] [--tpm N] [--daily N]');
    process.exit(1);
  }
  const out: Args = { name };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!v) continue;
    if (k === '--rpm') out.rpm = Number(v);
    else if (k === '--tpm') out.tpm = Number(v);
    else if (k === '--daily') out.daily = Number(v);
    i++;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const db = await openDb({ dbPath: env.DATABASE_PATH });
  const store = new ApiKeyStore(db);

  const createOpts: Parameters<ApiKeyStore['create']>[0] = { name: args.name };
  if (args.rpm !== undefined) createOpts.rateLimitRpm = args.rpm;
  if (args.tpm !== undefined) createOpts.rateLimitTpm = args.tpm;
  if (args.daily !== undefined) createOpts.dailyTokenBudget = args.daily;

  const result = await store.create(createOpts);
  db.close();

  console.log('');
  console.log('=========================================================');
  console.log('  API KEY CREATED — copy this NOW, it will not be shown again');
  console.log('=========================================================');
  console.log('');
  console.log(`  ${result.plaintext}`);
  console.log('');
  console.log(`  name:       ${result.row.name}`);
  console.log(`  prefix:     ${result.row.keyPrefix}...`);
  console.log(`  rate limit: ${result.row.rateLimitRpm} req/min · ${result.row.rateLimitTpm} tok/min`);
  if (result.row.dailyTokenBudget) {
    console.log(`  daily cap:  ${result.row.dailyTokenBudget} tokens`);
  }
  console.log('');
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
