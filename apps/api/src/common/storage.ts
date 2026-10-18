import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';

/**
 * File storage for recordings and attachments. Files are encrypted (AES-256-GCM, the organization data key) before
 * they touch the disk. Local disk now (STORAGE_DIR, default ./storage next to the API); an S3 / MinIO driver plugs in
 * behind the same three calls when UBOS is hosted.
 */
const ROOT = () => resolve(process.env.STORAGE_DIR ?? join(process.cwd(), 'storage'));
const key = () => Buffer.from(process.env.ENCRYPTION_KEY ?? '', 'hex');
const safe = (k: string) => {
  if (!/^[A-Za-z0-9/_.-]+$/.test(k) || k.includes('..')) throw new Error('Invalid storage key');
  return join(ROOT(), k);
};

export const storage = {
  async put(k: string, data: Buffer) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const file = safe(k);
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.concat([Buffer.from('UB1'), iv, c.getAuthTag(), enc]));
  },
  async get(k: string): Promise<Buffer> {
    const raw = await fs.readFile(safe(k));
    if (raw.subarray(0, 3).toString() !== 'UB1') throw new Error('Unknown file format');
    const d = createDecipheriv('aes-256-gcm', key(), raw.subarray(3, 15));
    d.setAuthTag(raw.subarray(15, 31));
    return Buffer.concat([d.update(raw.subarray(31)), d.final()]);
  },
  async remove(k: string) { await fs.rm(safe(k), { force: true }); },

  /** Resumable uploads: chunks go to a temporary (unencrypted, private) part file until complete. */
  async appendPart(k: string, offset: number, chunk: Buffer) {
    const file = `${safe(k)}.part`;
    await fs.mkdir(dirname(file), { recursive: true });
    const size = await fs.stat(file).then((s) => s.size).catch(() => 0);
    if (offset !== size) return size; // out of order: tell the client where to continue
    await fs.appendFile(file, chunk);
    return size + chunk.length;
  },
  async partSize(k: string) { return fs.stat(`${safe(k)}.part`).then((s) => s.size).catch(() => 0); },
  async finishPart(k: string) {
    const file = `${safe(k)}.part`;
    const data = await fs.readFile(file);
    await this.put(k, data);
    await fs.rm(file, { force: true });
    return data.length;
  },
};
