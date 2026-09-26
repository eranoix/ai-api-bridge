import Database from 'better-sqlite3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Db = Database.Database;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export interface OpenDbOptions {
  dbPath: string;
  /** Set to true in tests to skip mkdir/migrations. */
  readonly?: boolean;
}

export async function openDb(opts: OpenDbOptions): Promise<Db> {
  await fs.mkdir(path.dirname(opts.dbPath), { recursive: true });

  const db = new Database(opts.dbPath, { readonly: opts.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (!opts.readonly) {
    await applyMigrations(db);
  }

  return db;
}

async function applyMigrations(db: Db): Promise<void> {
  db.exec(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name TEXT PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );
  const applied = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM _migrations')
      .all()
      .map((r) => r.name),
  );
  const insert = db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)');
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(file, Date.now());
    })();
  }
}
