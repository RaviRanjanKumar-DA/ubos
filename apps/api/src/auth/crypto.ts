import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'crypto';

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const randomCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

function key() {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) throw new Error('ENCRYPTION_KEY must be 32 bytes of hex');
  return Buffer.from(hex, 'hex');
}

/** AES-256-GCM for secrets at rest (TOTP secrets now, integration credentials later). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
