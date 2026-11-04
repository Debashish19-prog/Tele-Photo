import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { FakeStorage } from '../src/storage/fake.js';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'tp-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string): Config {
  return {
    host: '127.0.0.1', port: 0, dataDir, webDist: join(dataDir, 'no-web'), storage: 'fake',
    telegramApiId: null, telegramApiHash: null, cookieSecure: false, trashRetentionDays: 30, allowedPhones: null,
  };
}

export async function makeJpeg(options: { color?: string; width?: number; height?: number; date?: string; camera?: string; orientation?: number } = {}): Promise<Buffer> {
  const { color = '#336699', width = 64, height = 48, date, camera, orientation } = options;
  let image = sharp({ create: { width, height, channels: 3, background: color } }).jpeg({ quality: 90 });
  if (date || camera) {
    image = image.withExif({
      IFD0: camera ? { Make: 'Canon', Model: camera } : {},
      IFD2: date ? { DateTimeOriginal: date } : {},
    });
  }
  if (orientation) image = image.withMetadata({ orientation });
  return image.toBuffer();
}

/** A running server plus a tiny client, so tests go through real HTTP and real multipart streaming. */
export class TestServer {
  base = '';
  cookie = '';
  storage!: FakeStorage;
  app!: Awaited<ReturnType<typeof buildApp>>['app'];
  ctx!: Awaited<ReturnType<typeof buildApp>>['ctx'];
  readonly ownsDir: boolean;

  constructor(readonly dir: string = mkdtempSync(join(tmpdir(), 'tp-app-')), ownsDir = true) {
    this.ownsDir = ownsDir;
  }

  async start(storage?: FakeStorage, overrides: Partial<Config> = {}): Promise<this> {
    this.storage = storage ?? new FakeStorage(this.dir);
    const built = await buildApp({ ...testConfig(this.dir), ...overrides }, this.storage);
    this.app = built.app;
    this.ctx = built.ctx;
    await this.ctx.queue.start();
    this.base = await this.app.listen({ host: '127.0.0.1', port: 0 });
    return this;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  async destroy(): Promise<void> {
    await this.stop();
    if (this.ownsDir) rmSync(this.dir, { recursive: true, force: true });
  }

  fetch(path: string, init: RequestInit = {}, cookie = this.cookie): Promise<Response> {
    return fetch(this.base + path, { ...init, headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) } });
  }

  post(path: string, body: unknown, cookie = this.cookie): Promise<Response> {
    return this.fetch(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, cookie);
  }

  async json<T = any>(path: string, cookie = this.cookie): Promise<T> {
    const res = await this.fetch(path, {}, cookie);
    if (!res.ok) throw new Error(`${path} returned ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  /** Signs in and returns the cookie. Sets it as the default the first time. */
  async signIn(phone = '+15550000001'): Promise<string> {
    const { loginId } = (await (await this.post('/api/auth/phone', { phone }, '')).json()) as { loginId: string };
    const res = await this.post('/api/auth/code', { loginId, code: '12345' }, '');
    if (!res.ok) throw new Error(`sign in failed: ${await res.text()}`);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]!;
    if (!this.cookie) this.cookie = cookie;
    return cookie;
  }

  async upload(bytes: Uint8Array, filename = 'photo.jpg', cookie = this.cookie, lastModified?: string): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([bytes]), filename);
    const query = lastModified ? `?lastModified=${encodeURIComponent(lastModified)}` : '';
    return this.fetch(`/api/uploads${query}`, { method: 'POST', body: form }, cookie);
  }

  async uploadOk(bytes: Uint8Array, filename = 'photo.jpg', cookie = this.cookie, lastModified?: string): Promise<number> {
    const res = await this.upload(bytes, filename, cookie, lastModified);
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { id: number }).id;
  }

  async grid(query = '', cookie = this.cookie): Promise<[number, number, number, string, number, string][]> {
    return (await this.json(`/api/photos${query}`, cookie)).items;
  }
}
