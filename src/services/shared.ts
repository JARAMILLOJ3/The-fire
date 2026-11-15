import { sanitizeStockQuantity } from '../utils/inventory';

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62_ALPHABET[bytes[i] % BASE62_ALPHABET.length];
  }
  return result;
}

export function clampString(val: string, maxLen: number): string {
  return val.trim().slice(0, maxLen);
}

export function clampNumber(val: number): number {
  return sanitizeStockQuantity(val);
}

export function makeCleanId(prefix: string): string {
  return `${prefix}_${Date.now()}_${randomBase62(8)}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

export function generateAccessCode(): string {
  return `tf_${randomBase62(18)}`;
}
