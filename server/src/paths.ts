import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Every path is derived from the account id and the content hash, never from a name the user
 * supplied, so a hostile filename cannot reach the filesystem.
 */
export class Paths {
  readonly incomingDir: string;
  readonly tmpDir: string;
  private readonly previewsDir: string;

  constructor(readonly dataDir: string) {
    this.incomingDir = join(dataDir, 'incoming');
    this.tmpDir = join(dataDir, 'tmp');
    this.previewsDir = join(dataDir, 'previews');
    for (const dir of [dataDir, this.incomingDir, this.tmpDir, this.previewsDir]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** The original, held only until Telegram has confirmed it. */
  incoming(accountId: number, sha256: string): string {
    return join(this.incomingDir, `${accountId}-${sha256}`);
  }

  thumb(accountId: number, sha256: string): string {
    return join(this.previewsDir, String(accountId), sha256.slice(0, 2), `${sha256}.thumb.webp`);
  }

  preview(accountId: number, sha256: string): string {
    return join(this.previewsDir, String(accountId), sha256.slice(0, 2), `${sha256}.preview.webp`);
  }

  ensureParent(path: string): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
}
