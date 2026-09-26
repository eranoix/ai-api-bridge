import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Write data to `filePath` atomically: write to a sibling tmp file, fsync, then
 * rename. Kill -9 mid-write never leaves the destination corrupted.
 */
export async function atomicWrite(
  filePath: string,
  data: string | Buffer,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Date.now()}`);

  const mode = opts.mode ?? 0o600;

  const fh = await fs.open(tmpPath, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }

  try {
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup if rename fails
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Ensure a directory exists (recursively). No-op if already present.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
