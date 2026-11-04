import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { copyFile, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CodeResult,
  type EnsureLibraryResult,
  type LoginSuccess,
  OriginalMissingError,
  type PutPhotoInput,
  type ScannedPhoto,
  type StorageBackend,
  type StorageContext,
  UserFacingError,
} from './types.js';

export const FAKE_CODE = '12345';
export const FAKE_PASSWORD = 'hunter2';

/**
 * Stands in for Telegram during development and tests, and keeps files on local disk.
 * Nothing stored here is backed up anywhere, which is why the UI shows a banner in this mode.
 * A phone number ending in 2 behaves like an account with two-step verification turned on.
 */
export class FakeStorage implements StorageBackend {
  readonly kind = 'fake' as const;
  private readonly root: string;
  private readonly logins = new Map<string, { phone: string; awaitingPassword: boolean }>();
  private nextMessageId = 1;

  /** Tests set these to rehearse failures. */
  failNextPut: Error | null = null;
  putDelayMs = 0;
  /** Test hook that receives the arguments of every stored photo. */
  onPut: ((input: PutPhotoInput) => void) | null = null;
  fetchCount = 0;

  constructor(dataDir: string) {
    this.root = join(dataDir, 'fake-telegram');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private dir(ctx: { session: string }): string {
    const dir = join(this.root, encodeURIComponent(ctx.session));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  async sendLoginCode(phone: string): Promise<{ loginId: string; delivery: 'app' | 'other' }> {
    const loginId = randomUUID();
    this.logins.set(loginId, { phone, awaitingPassword: false });
    return { loginId, delivery: 'app' };
  }

  private success(phone: string): LoginSuccess {
    return {
      status: 'ok',
      session: `fake:${phone}`,
      user: { id: phone.replace(/\D/g, ''), firstName: 'Demo', lastName: 'User', username: 'demo', phone },
    };
  }

  async submitLoginCode(loginId: string, code: string): Promise<CodeResult> {
    const login = this.logins.get(loginId);
    if (!login) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    if (code !== FAKE_CODE) throw new UserFacingError('CODE_INVALID', 'That code is not correct.');
    if (login.phone.endsWith('2')) {
      login.awaitingPassword = true;
      return { status: 'needs-password', hint: 'demo hint' };
    }
    this.logins.delete(loginId);
    return this.success(login.phone);
  }

  async submitLoginPassword(loginId: string, password: string): Promise<LoginSuccess> {
    const login = this.logins.get(loginId);
    if (!login?.awaitingPassword) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    if (password !== FAKE_PASSWORD) throw new UserFacingError('PASSWORD_INVALID', 'That password is not correct.');
    this.logins.delete(loginId);
    return this.success(login.phone);
  }

  async ensureLibrary(session: string): Promise<EnsureLibraryResult> {
    const dir = this.dir({ session });
    const existing = (await readdir(dir)).length > 0;
    return { library: { channelId: encodeURIComponent(session), accessHash: '0' }, existing };
  }

  async putPhoto(ctx: StorageContext, input: PutPhotoInput, onProgress: (fraction: number) => void): Promise<{ messageId: number }> {
    this.onPut?.(input);
    if (this.failNextPut) {
      const err = this.failNextPut;
      this.failNextPut = null;
      throw err;
    }
    const steps = this.putDelayMs > 0 ? 10 : 1;
    for (let i = 1; i <= steps; i++) {
      if (this.putDelayMs > 0) await new Promise((r) => setTimeout(r, this.putDelayMs / steps));
      onProgress(i / steps);
    }
    const dir = this.dir(ctx);
    let messageId = this.nextMessageId++;
    for (const name of await readdir(dir)) {
      if (name.endsWith('.json')) messageId = Math.max(messageId, Number.parseInt(name, 10) + 1);
    }
    this.nextMessageId = messageId + 1;
    await copyFile(input.path, join(dir, String(messageId)));
    const scanned: ScannedPhoto = {
      messageId, filename: input.filename, size: input.size, mime: input.mime, caption: input.caption,
      date: Math.floor(Date.now() / 1000),
    };
    await writeFile(join(dir, `${messageId}.json`), JSON.stringify(scanned));
    return { messageId };
  }

  async getPhoto(ctx: StorageContext, messageId: number): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }> {
    this.fetchCount++;
    const path = join(this.dir(ctx), String(messageId));
    const info = await stat(path).catch(() => null);
    if (!info) throw new OriginalMissingError();
    return { size: info.size, stream: createReadStream(path) };
  }

  async deletePhotos(ctx: StorageContext, messageIds: number[]): Promise<void> {
    const dir = this.dir(ctx);
    for (const id of messageIds) {
      await rm(join(dir, String(id)), { force: true });
      await rm(join(dir, `${id}.json`), { force: true });
    }
  }

  async *scanLibrary(ctx: StorageContext): AsyncIterable<ScannedPhoto> {
    const dir = this.dir(ctx);
    const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
    for (const name of names) yield JSON.parse(await readFile(join(dir, name), 'utf8')) as ScannedPhoto;
  }

  async revokeSession(): Promise<void> {}

  async close(): Promise<void> {}

  /** Lets a test confirm nothing is left behind after a permanent delete. */
  async storedCount(session: string): Promise<number> {
    return (await readdir(this.dir({ session }))).filter((n) => n.endsWith('.json')).length;
  }
}
