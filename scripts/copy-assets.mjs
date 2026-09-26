#!/usr/bin/env node
// tsc only emits .js from .ts, so non-source files (SQL migrations, etc.)
// must be copied here after the build.
import { promises as fs } from 'node:fs';
import path from 'node:path';

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const sp = path.join(src, entry.name);
    const dp = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(sp, dp);
    else await fs.copyFile(sp, dp);
  }
}

await copyDir('src/storage/migrations', 'dist/storage/migrations');
console.log('[build] copied src/storage/migrations -> dist/storage/migrations');
