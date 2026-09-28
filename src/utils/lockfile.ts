import lockfile from 'proper-lockfile';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LockOptions {
  retries?: number;
  minTimeout?: number;
  maxTimeout?: number;
  staleMs?: number;
}

export async function withLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const anchorPath = await ensureLockTarget(targetPath);

  const release = await lockfile.lock(anchorPath, {
    retries: {
      retries: opts.retries ?? 20,
      minTimeout: opts.minTimeout ?? 50,
      maxTimeout: opts.maxTimeout ?? 500,
      factor: 1.5,
    },
    stale: opts.staleMs ?? 30_000,
    realpath: false,
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => {
      // Best-effort: lock may have already been released by stale-detection.
    });
  }
}

async function ensureLockTarget(targetPath: string): Promise<string> {
  try {
    await fs.access(targetPath);
    return targetPath;
  } catch {
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
    const anchor = path.join(dir, `.${path.basename(targetPath)}.lock-anchor`);
    await fs.writeFile(anchor, '', { flag: 'a' });
    return anchor;
  }
}
