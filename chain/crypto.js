import { createHash } from 'node:crypto';

export const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const LAMPORTS_PER_BKC = 1_000_000_000n;
export const BKCX_DECIMALS = 6;
export const BKC_DECIMALS = 9;

export function sha256(...parts) {
  const h = createHash('sha256');
  for (const p of parts) {
    if (p == null) continue;
    if (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof Uint8Array) h.update(p);
    else h.update(String(p));
  }
  return h.digest();
}

export function toBase58(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const size = Math.ceil(bytes.length * 1.37) + 1;
  const b = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b[k];
      b[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }
  let out = '1'.repeat(zeros);
  for (let i = size - length; i < size; i++) out += B58[b[i]];
  return out;
}

export function pubkeyFromSeed(seed) {
  return toBase58(sha256('bkc-pubkey', seed).subarray(0, 32));
}

export function blockhashFrom(slot, parentHash) {
  return toBase58(sha256('blockhash', String(slot), parentHash || 'genesis'));
}

export function makeSignature(slot, index, payload) {
  const a = sha256('sig-a', String(slot), String(index), payload);
  const b = sha256('sig-b', a, payload);
  return toBase58(Buffer.concat([a, b]));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
