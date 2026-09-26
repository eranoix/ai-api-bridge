import lockfile from 'proper-lockfile';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LockOptions {
  /** Max times to retry acquiring the lock. */
  retries?: number;
  /** Min wait between retries (ms). */
  minTimeout?: number;
  /** Max wait between retries (ms). */
  maxTimeout?: number;
  /** Consider the lock stale if older than this (ms). */
  staleMs?: number;
}

/**
 * Run `fn` while holding an exclusive lock on `targetPath`.
 *
 * proper-lockfile creates `<targetPath>.lock` directory; this works
 * cross-platform (Linux, macOS, Windows) and handles stale locks from
 * dead processes.
 */
export async function withLock<T>(
  targetPath: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  // proper-lockfile requires the target file to exist. If it doesn't yet
  // (e.g. first-ever credentials write), use a sibling .lock-anchor file.
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
    // Use a sibling anchor we own; safe to create.
    const dir = path.dirname(targetPath);
    await fs.mkdir(dir, { recursive: true });
    const anchor = path.join(dir, `.${path.basename(targetPath)}.lock-anchor`);
    await fs.writeFile(anchor, '', { flag: 'a' }); // touch
    return anchor;
  }
}
