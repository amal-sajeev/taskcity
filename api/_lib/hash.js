import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

// scrypt is built into Node so we avoid an external bcrypt dep. Cost factor
// N=16384 with r=8/p=1 (defaults) gives ~50ms hash on modern CPUs which is
// painful enough for brute force without holding up signup.
const KEYLEN = 64;
const COST = 16384;

export async function hashPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 6) {
    throw new Error('password_too_short');
  }
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(pw, salt, KEYLEN, { N: COST });
  return `scrypt$${COST}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(pw, stored) {
  if (!pw || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  const derived = await scryptAsync(pw, salt, expected.length, { N });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}
