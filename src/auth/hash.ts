import { scrypt as scryptCb, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto';

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Hash format: scrypt$N$r$p$saltBase64$hashBase64
 * scrypt is built into Node (no native dep); keys are 256-bit random tokens,
 * so brute force is infeasible regardless of hash cost.
 */

const N = 16384; // CPU/memory cost
const r = 8;
const p = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export async function hashApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptAsync(plaintext, salt, KEY_LEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyApiKey(plaintext: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const nVal = Number(nStr);
  const rVal = Number(rStr);
  const pVal = Number(pStr);
  if (!Number.isFinite(nVal) || !Number.isFinite(rVal) || !Number.isFinite(pVal)) return false;

  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scryptAsync(plaintext, salt, expected.length, {
    N: nVal,
    r: rVal,
    p: pVal,
  });

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Generate a fresh API key plaintext, formatted as `sk-priv-<base64url>`.
 */
export function generateApiKey(byteLen = 32): string {
  return `sk-priv-${randomBytes(byteLen).toString('base64url')}`;
}

export function keyPrefix(plaintext: string, prefixLen = 12): string {
  return plaintext.slice(0, prefixLen);
}
