import { promises as fs } from 'node:fs';
import path from 'node:path';

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
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}
