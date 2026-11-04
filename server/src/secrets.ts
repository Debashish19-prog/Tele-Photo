import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Telegram session string is full access to the account, so it is never stored in the clear.
 * The key lives in its own owner-only file, which keeps a copied database from being enough.
 */
export class Sealer {
  private readonly key: Buffer;

  constructor(dataDir: string) {
    const path = join(dataDir, 'secret.key');
    if (existsSync(path)) {
      this.key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
      if (this.key.length !== 32) throw new Error(`${path} is not a valid 256-bit key`);
    } else {
      this.key = randomBytes(32);
      writeFileSync(path, this.key.toString('base64'), { mode: 0o600 });
    }
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** Browser tokens are stored hashed, so reading the database does not yield a usable cookie. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
