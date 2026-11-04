import { closeSync, existsSync, ftruncateSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCaption, parseCaption } from '../src/caption.js';
import { MAX_PHOTO_BYTES } from '../src/config.js';
import { generatePreviews } from '../src/media.js';
import { FAKE_CODE, FAKE_PASSWORD, FakeStorage } from '../src/storage/fake.js';
import { OriginalMissingError, RateLimitedError, SessionRevokedError } from '../src/storage/types.js';
import { makeJpeg, sha256, TestServer } from './helpers.js';

describe('Tele-Photo API', () => {
  let s: TestServer;

  beforeEach(async () => {
    s = await new TestServer().start();
  });
  afterEach(async () => {
    await s.destroy();
  });

  describe('sign-in and access', () => {
    it('refuses every private route without a session', async () => {
      const routes: [string, string][] = [
        ['GET', '/api/photos'], ['GET', '/api/photos/1'], ['GET', '/api/photos/1/thumb'], ['GET', '/api/photos/1/preview'],
        ['GET', '/api/photos/1/original'], ['GET', '/api/photos/zip?ids=1'], ['PATCH', '/api/photos'],
        ['POST', '/api/photos/delete-permanently'], ['POST', '/api/trash/empty'], ['GET', '/api/library'],
        ['POST', '/api/library/rescan'], ['GET', '/api/albums'], ['POST', '/api/albums'], ['GET', '/api/albums/1'],
        ['PATCH', '/api/albums/1'], ['DELETE', '/api/albums/1'], ['POST', '/api/albums/1/photos'],
        ['POST', '/api/albums/1/photos/remove'], ['POST', '/api/uploads'], ['GET', '/api/uploads/status'],
        ['POST', '/api/uploads/retry'], ['DELETE', '/api/uploads/1'], ['POST', '/api/auth/disconnect'],
      ];
      for (const [method, path] of routes) {
        const hasBody = method !== 'GET' && method !== 'DELETE' && path !== '/api/uploads';
        const res = await s.fetch(path, { method, ...(hasBody ? { body: '{}', headers: { 'content-type': 'application/json' } } : {}) }, '');
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });

    it('rejects a wrong code, then accepts the right one', async () => {
      const { loginId } = await (await s.post('/api/auth/phone', { phone: '+15550000001' }, '')).json() as { loginId: string };
      const wrong = await s.post('/api/auth/code', { loginId, code: '000' }, '');
      expect(wrong.status).toBe(400);
      expect(((await wrong.json()) as any).error.code).toBe('CODE_INVALID');
      expect((await s.post('/api/auth/code', { loginId, code: FAKE_CODE }, '')).ok).toBe(true);
    });

    it('goes through two-step verification when the account uses it', async () => {
      const { loginId } = await (await s.post('/api/auth/phone', { phone: '+15550000002' }, '')).json() as { loginId: string };
      const step = await (await s.post('/api/auth/code', { loginId, code: FAKE_CODE }, '')).json() as any;
      expect(step).toEqual({ status: 'password', hint: 'demo hint' });
      expect((await s.post('/api/auth/password', { loginId, password: 'nope' }, '')).status).toBe(400);
      const ok = await s.post('/api/auth/password', { loginId, password: FAKE_PASSWORD }, '');
      expect(ok.ok).toBe(true);
      expect(ok.headers.get('set-cookie')).toMatch(/HttpOnly/i);
      expect(ok.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);
    });

    it('limits sign-in attempts, since each one can send someone a code', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await s.post('/api/auth/phone', { phone: '+15550000009' }, '')).status);
      expect(statuses.slice(0, 10).every((code) => code === 200)).toBe(true);
      expect(statuses.at(-1)).toBe(429);
    });

    it('only lets listed phone numbers sign in when an allowlist is set', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tp-allow-'));
      const limited = await new TestServer(dir).start(undefined, { allowedPhones: new Set(['+15551112222']) });
      try {
        expect((await limited.post('/api/auth/phone', { phone: '+1 555 999 0000' }, '')).status).toBe(403);
        expect((await limited.post('/api/auth/phone', { phone: '+1 (555) 111-2222' }, '')).status).toBe(200);
      } finally {
        await limited.destroy();
      }
    });

    it('rejects malformed phone numbers', async () => {
      expect((await s.post('/api/auth/phone', { phone: 'not a number' }, '')).status).toBe(400);
    });

    it('never stores the Telegram session or browser token in the clear', async () => {
      const cookie = await s.signIn();
      const token = cookie.split('=')[1]!;
      const row = s.ctx.repo.db.prepare('SELECT session_sealed FROM accounts').get() as { session_sealed: string };
      expect(row.session_sealed).not.toContain('fake:');
      expect(s.ctx.sealer.open(row.session_sealed)).toBe('fake:+15550000001');
      const sessions = s.ctx.repo.db.prepare('SELECT token_hash FROM browser_sessions').all() as { token_hash: string }[];
      expect(sessions.some((r) => r.token_hash === token)).toBe(false);
    });

    it('signs out only this browser', async () => {
      const a = await s.signIn();
      const b = await s.signIn();
      expect((await s.post('/api/auth/logout', {}, a)).ok).toBe(true);
      expect((await s.fetch('/api/photos', {}, a)).status).toBe(401);
      expect((await s.fetch('/api/photos', {}, b)).status).toBe(200);
    });

    it('disconnect removes the Telegram session and every browser', async () => {
      const a = await s.signIn();
      const b = await s.signIn();
      expect((await s.post('/api/auth/disconnect', {}, a)).ok).toBe(true);
      expect((await s.fetch('/api/photos', {}, b)).status).toBe(401);
      const row = s.ctx.repo.db.prepare('SELECT session_sealed FROM accounts').get() as { session_sealed: string | null };
      expect(row.session_sealed).toBeNull();
    });

    it('keeps one library per Telegram account, and strangers cannot touch it', async () => {
      const alice = await s.signIn('+15550000001');
      const bob = await s.signIn('+15550000003');
      const id = await s.uploadOk(await makeJpeg(), 'alice.jpg', alice);
      await s.ctx.queue.drain();

      for (const suffix of ['', '/thumb', '/preview', '/original']) {
        expect((await s.fetch(`/api/photos/${id}${suffix}`, {}, bob)).status, suffix).toBe(404);
      }
      expect((await s.fetch(`/api/photos/zip?ids=${id}`, {}, bob)).status).toBe(404);

      // Writes aimed at someone else's photo must do nothing.
      await s.fetch('/api/photos', { method: 'PATCH', body: JSON.stringify({ ids: [id], trashed: true, favorite: true }), headers: { 'content-type': 'application/json' } }, bob);
      const row = s.ctx.repo.getPhoto(s.ctx.repo.getAccountByTelegramId('15550000001')!.id, id)!;
      expect(row.trashed_at).toBeNull();
      expect(row.favorite).toBe(0);

      await s.post('/api/photos/delete-permanently', { ids: [id] }, bob);
      expect((await s.fetch(`/api/photos/${id}`, {}, alice)).status).toBe(200);

      const { id: albumId } = await (await s.post('/api/albums', { title: 'mine' }, bob)).json() as { id: number };
      await s.post(`/api/albums/${albumId}/photos`, { ids: [id] }, bob);
      expect(await s.grid(`?album=${albumId}`, bob)).toEqual([]);
      expect(await s.grid('', bob)).toEqual([]);
      expect((await s.grid('', alice)).length).toBe(1);
    });
  });

  describe('keeping photos intact', () => {
    it('stores exactly the bytes it received and hands back exactly those bytes', async () => {
      await s.signIn();
      const original = await makeJpeg({ width: 800, height: 600, date: '2021:03:14 09:26:53', camera: 'EOS R5' });
      const id = await s.uploadOk(original, 'IMG_0001.jpg');
      await s.ctx.queue.drain();

      const detail = await s.json(`/api/photos/${id}`);
      expect(detail.status).toBe('stored');
      expect(detail.sha256).toBe(sha256(original));
      expect(detail.size).toBe(original.length);

      const res = await s.fetch(`/api/photos/${id}/original?download=1`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('content-disposition')).toContain('attachment');
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      const downloaded = new Uint8Array(await res.arrayBuffer());
      expect(sha256(downloaded)).toBe(sha256(original));
    });

    it('does not keep the original on local disk once Telegram has it', async () => {
      await s.signIn();
      await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      expect(readdirSync(s.ctx.paths.incomingDir)).toEqual([]);
    });

    it('sends each photo to storage as a single file', async () => {
      await s.signIn();
      const seen: string[] = [];
      s.storage.onPut = (input) => seen.push(input.filename);
      await s.uploadOk(await makeJpeg({ color: '#111111' }), 'one.jpg');
      await s.uploadOk(await makeJpeg({ color: '#222222' }), 'two.jpg');
      await s.ctx.queue.drain();
      expect(seen.sort()).toEqual(['one.jpg', 'two.jpg']);
    });

    it('serves a photo that has not reached Telegram yet from the local copy', async () => {
      await s.signIn();
      s.storage.putDelayMs = 400;
      const original = await makeJpeg({ color: '#445566' });
      const id = await s.uploadOk(original);
      const res = await s.fetch(`/api/photos/${id}/original`);
      expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(original));
      await s.ctx.queue.drain();
    });

    it('does not read local previews back as the original', async () => {
      await s.signIn();
      const original = await makeJpeg({ width: 3000, height: 2000 });
      const id = await s.uploadOk(original);
      await s.ctx.queue.drain();
      const preview = new Uint8Array(await (await s.fetch(`/api/photos/${id}/preview`)).arrayBuffer());
      expect(sha256(preview)).not.toBe(sha256(original));
      const meta = await sharp(preview).metadata();
      expect(meta.format).toBe('webp');
    });
  });

  describe('what gets accepted', () => {
    beforeEach(async () => {
      await s.signIn();
    });

    it('rejects non-images, whatever they are named', async () => {
      const res = await s.upload(Buffer.from('this is not an image at all, sorry'.repeat(10)), 'fake.jpg');
      expect(res.status).toBe(415);
      expect(((await res.json()) as any).error.code).toBe('NOT_A_PHOTO');
      expect(readdirSync(s.ctx.paths.tmpDir)).toEqual([]);
      expect(await s.grid()).toEqual([]);
    });

    it('rejects a video named like a photo', async () => {
      const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(200)]);
      expect((await s.upload(mp4, 'clip.jpg')).status).toBe(415);
    });

    it('rejects an empty file', async () => {
      expect((await s.upload(new Uint8Array(0))).status).toBe(400);
    });

    it('rejects an oversized upload from its declared size, before reading the body', async () => {
      expect(MAX_PHOTO_BYTES).toBe(2_097_152_000);
      const url = new URL(s.base);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: url.hostname, port: url.port, path: '/api/uploads', method: 'POST',
            headers: {
              cookie: s.cookie,
              'content-type': 'multipart/form-data; boundary=x',
              'content-length': String(MAX_PHOTO_BYTES + 1024 * 1024),
            },
          },
          (res) => {
            res.resume();
            expect(res.headers.connection).toBe('close');
            resolve(res.statusCode!);
            req.destroy();
          },
        );
        req.on('error', reject);
        req.write('--x'); // Almost nothing is sent. The answer has to come from the header alone.
      });
      expect(status).toBe(413);
    });

    it('accepts the common web formats', async () => {
      const base = sharp({ create: { width: 40, height: 30, channels: 3, background: '#a33' } });
      const samples: [string, Buffer, string][] = [
        ['a.png', await base.clone().png().toBuffer(), 'image/png'],
        ['a.webp', await base.clone().webp().toBuffer(), 'image/webp'],
        ['a.gif', await base.clone().gif().toBuffer(), 'image/gif'],
        ['a.avif', await base.clone().avif().toBuffer(), 'image/avif'],
        ['a.tiff', await base.clone().tiff().toBuffer(), 'image/tiff'],
      ];
      for (const [name, bytes, mime] of samples) {
        const id = await s.uploadOk(bytes, name);
        const detail = await s.json(`/api/photos/${id}`);
        expect(detail.mime, name).toBe(mime);
        expect(detail.previewState, name).toBe('ready');
      }
      await s.ctx.queue.drain();
    });

    it('still stores an image it cannot decode, with a placeholder instead of a thumbnail', async () => {
      // A JPEG header on garbage: looks like a photo, cannot be decoded. Losing it would be worse.
      const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7)]);
      const id = await s.uploadOk(broken, 'damaged.jpg');
      await s.ctx.queue.drain();
      const detail = await s.json(`/api/photos/${id}`);
      expect(detail.status).toBe('stored');
      expect(detail.previewState).toBe('unavailable');
      expect((await s.fetch(`/api/photos/${id}/thumb`)).status).toBe(404);
      const back = new Uint8Array(await (await s.fetch(`/api/photos/${id}/original`)).arrayBuffer());
      expect(sha256(back)).toBe(sha256(broken));
    });

    it('recognises the same photo uploaded twice and stores it once', async () => {
      const bytes = await makeJpeg();
      const first = await s.upload(bytes, 'a.jpg');
      expect(first.status).toBe(201);
      await s.ctx.queue.drain();
      const second = await s.upload(bytes, 'copy-of-a.jpg');
      expect(second.status).toBe(200);
      expect(((await second.json()) as any).duplicate).toBe(true);
      expect((await s.grid()).length).toBe(1);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(1);
      expect(readdirSync(s.ctx.paths.tmpDir)).toEqual([]);
    });

    it('stores a photo once when the same bytes arrive at the same moment', async () => {
      const bytes = await makeJpeg({ color: '#778899' });
      const results = await Promise.all(Array.from({ length: 5 }, () => s.upload(bytes, 'same.jpg')));
      expect(results.every((r) => r.ok)).toBe(true);
      await s.ctx.queue.drain();
      const grid = await s.grid();
      expect(grid.length).toBe(1);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(1);
      const back = new Uint8Array(await (await s.fetch(`/api/photos/${grid[0]![0]}/original`)).arrayBuffer());
      expect(sha256(back)).toBe(sha256(bytes));
    });

    it('brings a photo back from Trash when it is uploaded again', async () => {
      const bytes = await makeJpeg();
      const id = await s.uploadOk(bytes);
      await s.ctx.queue.drain();
      await s.fetch('/api/photos', { method: 'PATCH', body: JSON.stringify({ ids: [id], trashed: true }), headers: { 'content-type': 'application/json' } });
      expect(await s.grid()).toEqual([]);
      const res = await s.upload(bytes);
      expect(((await res.json()) as any).restored).toBe(true);
      expect((await s.grid()).length).toBe(1);
    });

    it('keeps non-English filenames and neutralises hostile ones', async () => {
      const a = await s.uploadOk(await makeJpeg({ color: '#010101' }), 'ছবি 東京 🌸.jpg');
      expect((await s.json(`/api/photos/${a}`)).filename).toBe('ছবি 東京 🌸.jpg');
      const b = await s.uploadOk(await makeJpeg({ color: '#020202' }), '../../../etc/passwd.jpg');
      expect((await s.json(`/api/photos/${b}`)).filename).toBe('passwd.jpg');
      await s.ctx.queue.drain();
      const res = await s.fetch(`/api/photos/${a}/original?download=1`);
      expect(decodeURIComponent(res.headers.get('content-disposition')!)).toContain('ছবি 東京 🌸.jpg');
    });
  });

  describe('very large files', () => {
    // RssAnon, not VmRSS: libvips memory-maps its input, and those pages count towards VmRSS even
    // though the OS can reclaim them at any time. Only anonymous memory can run a server out of RAM.
    const anonMb = () => Number(/RssAnon:\s+(\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))![1]) / 1024;
    const openHandles = () => readdirSync('/proc/self/fd').length;

    it('stays within bounded memory on an undecodable 2 GB file, and leaks no file handles', async () => {
      const path = join(s.dir, 'huge.jpg');
      const fd = openSync(path, 'w');
      writeSync(fd, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]));
      ftruncateSync(fd, MAX_PHOTO_BYTES); // Sparse, so this takes no real disk space.
      closeSync(fd);

      const handles = openHandles();
      const before = anonMb();
      let peak = before;
      const sampler = setInterval(() => (peak = Math.max(peak, anonMb())), 10);
      const result = await generatePreviews(path, 'image/jpeg', join(s.dir, 't.webp'), join(s.dir, 'p.webp'));
      clearInterval(sampler);

      expect(result).toBeNull();
      expect(peak - before).toBeLessThan(300);
      expect(openHandles()).toBe(handles);
    });
  });

  describe('metadata and the timeline', () => {
    beforeEach(async () => {
      await s.signIn();
    });

    it('reads the capture date and camera from EXIF', async () => {
      const id = await s.uploadOk(await makeJpeg({ date: '2019:12:31 23:59:58', camera: 'EOS R5' }));
      const d = await s.json(`/api/photos/${id}`);
      expect(d.takenAt).toBe('2019-12-31T23:59:58');
      expect(d.takenSource).toBe('exif');
      expect(d.camera.model).toBe('EOS R5');
    });

    it('falls back to the file date when there is no EXIF', async () => {
      const id = await s.uploadOk(await makeJpeg(), 'a.jpg', s.cookie, '2015-06-07T08:09:10');
      const d = await s.json(`/api/photos/${id}`);
      expect(d.takenAt).toBe('2015-06-07T08:09:10');
      expect(d.takenSource).toBe('file');
    });

    it('ignores a nonsense file date', async () => {
      const id = await s.uploadOk(await makeJpeg(), 'a.jpg', s.cookie, "'; DROP TABLE photos; --");
      expect((await s.json(`/api/photos/${id}`)).takenSource).toBe('upload');
    });

    it('orders the timeline by when photos were taken, not when uploaded', async () => {
      await s.uploadOk(await makeJpeg({ color: '#a00000', date: '2020:01:01 10:00:00' }), 'middle.jpg');
      await s.uploadOk(await makeJpeg({ color: '#00a000', date: '2023:01:01 10:00:00' }), 'newest.jpg');
      await s.uploadOk(await makeJpeg({ color: '#0000a0', date: '2010:01:01 10:00:00' }), 'oldest.jpg');
      expect((await s.grid()).map((i) => i[5])).toEqual(['newest.jpg', 'middle.jpg', 'oldest.jpg']);
    });

    it('swaps width and height when EXIF says the photo is rotated', async () => {
      const id = await s.uploadOk(await makeJpeg({ width: 400, height: 300, orientation: 6 }));
      const d = await s.json(`/api/photos/${id}`);
      expect([d.width, d.height]).toEqual([300, 400]);
      const thumb = Buffer.from(await (await s.fetch(`/api/photos/${id}/thumb`)).arrayBuffer());
      const meta = await sharp(thumb).metadata();
      expect(meta.height!).toBeGreaterThan(meta.width!);
    });

    it('never scales a small photo up', async () => {
      const id = await s.uploadOk(await makeJpeg({ width: 100, height: 80 }));
      const thumb = Buffer.from(await (await s.fetch(`/api/photos/${id}/thumb`)).arrayBuffer());
      expect((await sharp(thumb).metadata()).width).toBe(100);
    });

    it('searches by name, camera, year and month, and treats wildcards as text', async () => {
      await s.uploadOk(await makeJpeg({ color: '#a10000', date: '2019:07:04 10:00:00', camera: 'EOS R5' }), 'beach.jpg');
      await s.uploadOk(await makeJpeg({ color: '#00a100', date: '2021:02:14 10:00:00' }), 'mountain.jpg');
      await s.uploadOk(await makeJpeg({ color: '#0000a1', date: '2021:07:20 10:00:00' }), '100%_real.jpg');
      const names = async (q: string) => (await s.grid(`?q=${encodeURIComponent(q)}`)).map((i) => i[5]).sort();
      expect(await names('beach')).toEqual(['beach.jpg']);
      expect(await names('eos')).toEqual(['beach.jpg']);
      expect(await names('2021')).toEqual(['100%_real.jpg', 'mountain.jpg']);
      expect(await names('july')).toEqual(['100%_real.jpg', 'beach.jpg']);
      expect(await names('july 2021')).toEqual(['100%_real.jpg']);
      expect(await names('%')).toEqual(['100%_real.jpg']);
      expect(await names('_')).toEqual(['100%_real.jpg']);
      expect(await names('nothing-like-this')).toEqual([]);
    });
  });

  describe('when things go wrong', () => {
    beforeEach(async () => {
      await s.signIn();
    });

    it('keeps the local copy and retries when an upload fails', async () => {
      s.storage.failNextPut = new Error('network went away');
      const original = await makeJpeg();
      const id = await s.uploadOk(original);
      await s.ctx.queue.drain();
      let d = await s.json(`/api/photos/${id}`);
      expect(d.status).toBe('queued');
      expect(d.error).toBe('network went away');
      expect(readdirSync(s.ctx.paths.incomingDir)).toHaveLength(1);

      s.ctx.repo.db.prepare('UPDATE photos SET next_attempt_at = 0').run();
      await s.ctx.queue.drain();
      d = await s.json(`/api/photos/${id}`);
      expect(d.status).toBe('stored');
      expect(d.error).toBeNull();
      const back = new Uint8Array(await (await s.fetch(`/api/photos/${id}/original`)).arrayBuffer());
      expect(sha256(back)).toBe(sha256(original));
    });

    it('stops retrying after repeated failures, keeps the file, and can be retried by hand', async () => {
      s.storage.failNextPut = new Error('still broken');
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      for (let i = 1; i < 6; i++) {
        s.storage.failNextPut = new Error('still broken');
        s.ctx.repo.db.prepare(`UPDATE photos SET next_attempt_at = 0 WHERE status = 'queued'`).run();
        await s.ctx.queue.drain();
      }
      expect((await s.json(`/api/photos/${id}`)).status).toBe('failed');
      expect(readdirSync(s.ctx.paths.incomingDir)).toHaveLength(1);
      const status = await s.json('/api/uploads/status');
      expect(status.items[0].status).toBe('failed');
      expect(status.stats.failed).toBe(1);

      expect(((await (await s.post('/api/uploads/retry', {})).json()) as any).retried).toBe(1);
      await s.ctx.queue.drain();
      expect((await s.json(`/api/photos/${id}`)).status).toBe('stored');
    });

    it('waits out a rate limit without using up a retry', async () => {
      s.storage.failNextPut = new RateLimitedError(300);
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      const row = s.ctx.repo.db.prepare('SELECT attempts, next_attempt_at, status FROM photos WHERE id = ?').get(id) as any;
      expect(row.status).toBe('queued');
      expect(row.attempts).toBe(0);
      expect(row.next_attempt_at).toBeGreaterThan(Date.now() + 200_000);
    });

    it('holds every other upload for the account during a rate limit', async () => {
      s.storage.failNextPut = new RateLimitedError(300);
      const seen: string[] = [];
      s.storage.onPut = (input) => seen.push(input.filename);
      await s.uploadOk(await makeJpeg({ color: '#101010' }), 'a.jpg');
      await s.ctx.queue.drain();
      await s.uploadOk(await makeJpeg({ color: '#202020' }), 'b.jpg');
      await s.ctx.queue.drain();
      expect(seen).toEqual(['a.jpg']);
    });

    it('pauses and asks for sign-in if the Telegram session is revoked, then resumes', async () => {
      s.storage.failNextPut = new SessionRevokedError('AUTH_KEY_UNREGISTERED');
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      expect((await s.json('/api/session')).account.needsReauth).toBe(true);
      expect((await s.json(`/api/photos/${id}`)).status).toBe('queued');
      expect(readdirSync(s.ctx.paths.incomingDir)).toHaveLength(1);

      await s.signIn();
      await s.ctx.queue.drain();
      expect((await s.json('/api/session')).account.needsReauth).toBe(false);
      expect((await s.json(`/api/photos/${id}`)).status).toBe('stored');
    });

    it('does not ask for sign-in again when an old session fails after a new sign-in', async () => {
      s.storage.putDelayMs = 200;
      s.storage.failNextPut = null;
      const id = await s.uploadOk(await makeJpeg());
      const account = s.ctx.repo.getAccountByTelegramId('15550000001')!;
      // Simulates: the job started on the old session, then the user signed in again.
      s.ctx.repo.db.prepare('UPDATE accounts SET session_sealed = ? WHERE id = ?').run(s.ctx.sealer.seal('fake:+15550000001'), account.id);
      s.storage.failNextPut = new SessionRevokedError('SESSION_REVOKED');
      await s.ctx.queue.drain();
      expect((await s.json(`/api/photos/${id}`)).id).toBe(id);
    });

    it('explains when a stored original has gone from Telegram', async () => {
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      const { tg_message_id } = s.ctx.repo.db.prepare('SELECT tg_message_id FROM photos WHERE id = ?').get(id) as any;
      const ref = { session: 'fake:+15550000001', library: { channelId: 'x', accessHash: '0' } };
      await s.storage.deletePhotos(ref, [tg_message_id]);
      const res = await s.fetch(`/api/photos/${id}/original`);
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).error.code).toBe(new OriginalMissingError().code);
    });

    it('can give up on a photo that has not reached Telegram', async () => {
      s.storage.failNextPut = new Error('broken');
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      expect((await s.fetch(`/api/uploads/${id}`, { method: 'DELETE' })).ok).toBe(true);
      expect(await s.grid()).toEqual([]);
      expect(readdirSync(s.ctx.paths.incomingDir)).toEqual([]);
    });

    it('refuses to cancel what is already stored', async () => {
      const id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      expect((await s.fetch(`/api/uploads/${id}`, { method: 'DELETE' })).status).toBe(409);
    });

    it('removes half-received uploads when the connection drops', async () => {
      const controller = new AbortController();
      const stream = new ReadableStream({
        async pull(c) {
          c.enqueue(new TextEncoder().encode('--x\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'));
          await new Promise((r) => setTimeout(r, 100));
          controller.abort();
        },
      });
      await s
        .fetch('/api/uploads', { method: 'POST', body: stream, signal: controller.signal, headers: { 'content-type': 'multipart/form-data; boundary=x' }, duplex: 'half' } as RequestInit)
        .catch(() => null);
      await new Promise((r) => setTimeout(r, 200));
      expect(readdirSync(s.ctx.paths.tmpDir)).toEqual([]);
      expect(await s.grid()).toEqual([]);
    });
  });

  describe('trash', () => {
    let id: number;
    const patch = (body: unknown) => s.fetch('/api/photos', { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

    beforeEach(async () => {
      await s.signIn();
      id = await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
    });

    it('moving to Trash keeps the Telegram copy, and restoring brings it all back', async () => {
      await patch({ ids: [id], trashed: true });
      expect(await s.grid()).toEqual([]);
      expect((await s.grid('?view=trash')).length).toBe(1);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(1);
      await patch({ ids: [id], trashed: false });
      expect((await s.grid()).length).toBe(1);
      expect(await s.grid('?view=trash')).toEqual([]);
    });

    it('will not permanently delete a photo that is not in Trash', async () => {
      const res = await (await s.post('/api/photos/delete-permanently', { ids: [id] })).json() as any;
      expect(res.deleted).toBe(0);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(1);
      expect((await s.grid()).length).toBe(1);
    });

    it('permanent delete removes the file from Telegram and everything local', async () => {
      await patch({ ids: [id], trashed: true });
      const { sha256: hash } = await s.json(`/api/photos/${id}`);
      const account = s.ctx.repo.getAccountByTelegramId('15550000001')!;
      expect(existsSync(s.ctx.paths.thumb(account.id, hash))).toBe(true);
      const res = await (await s.post('/api/photos/delete-permanently', { ids: [id] })).json() as any;
      expect(res.deleted).toBe(1);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(0);
      expect((await s.fetch(`/api/photos/${id}`)).status).toBe(404);
      expect(existsSync(s.ctx.paths.thumb(account.id, hash))).toBe(false);
    });

    it('keeps the record if Telegram refuses the delete', async () => {
      await patch({ ids: [id], trashed: true });
      const original = s.storage.deletePhotos.bind(s.storage);
      s.storage.deletePhotos = async () => { throw new Error('telegram said no'); };
      expect((await s.post('/api/photos/delete-permanently', { ids: [id] })).status).toBe(500);
      s.storage.deletePhotos = original;
      expect((await s.grid('?view=trash')).length).toBe(1);
    });

    it('never reuses an id, so a cached thumbnail cannot show the wrong photo', async () => {
      await patch({ ids: [id], trashed: true });
      await s.post('/api/photos/delete-permanently', { ids: [id] });
      const next = await s.uploadOk(await makeJpeg({ color: '#123123' }));
      expect(next).toBeGreaterThan(id);
    });

    it('empties the Trash', async () => {
      const other = await s.uploadOk(await makeJpeg({ color: '#abcabc' }));
      await s.ctx.queue.drain();
      await patch({ ids: [id, other], trashed: true });
      expect(((await (await s.post('/api/trash/empty', {})).json()) as any).deleted).toBe(2);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(0);
    });

    it('purges only what has been in Trash past the retention period', async () => {
      const kept = await s.uploadOk(await makeJpeg({ color: '#defdef' }));
      await s.ctx.queue.drain();
      await patch({ ids: [id, kept], trashed: true });
      const day = 24 * 60 * 60 * 1000;
      s.ctx.repo.db.prepare('UPDATE photos SET trashed_at = ? WHERE id = ?').run(Date.now() - 31 * day, id);
      s.ctx.repo.db.prepare('UPDATE photos SET trashed_at = ? WHERE id = ?').run(Date.now() - 29 * day, kept);
      expect(await s.ctx.library.purgeExpired()).toBe(1);
      expect((await s.grid('?view=trash')).map((i) => i[0])).toEqual([kept]);
      expect(await s.storage.storedCount('fake:+15550000001')).toBe(1);
    });
  });

  describe('favorites and albums', () => {
    beforeEach(async () => {
      await s.signIn();
    });

    it('marks favorites', async () => {
      const a = await s.uploadOk(await makeJpeg({ color: '#a0a0a0' }));
      const b = await s.uploadOk(await makeJpeg({ color: '#b0b0b0' }));
      await s.fetch('/api/photos', { method: 'PATCH', body: JSON.stringify({ ids: [a], favorite: true }), headers: { 'content-type': 'application/json' } });
      expect((await s.grid('?view=favorites')).map((i) => i[0])).toEqual([a]);
      expect((await s.json(`/api/photos/${a}`)).favorite).toBe(true);
      expect((await s.json(`/api/photos/${b}`)).favorite).toBe(false);
    });

    it('creates albums, shows covers, hides trashed photos, and never deletes photos with the album', async () => {
      const a = await s.uploadOk(await makeJpeg({ color: '#c0c0c0', date: '2022:01:01 00:00:00' }));
      const b = await s.uploadOk(await makeJpeg({ color: '#d0d0d0', date: '2023:01:01 00:00:00' }));
      const { id: album } = (await (await s.post('/api/albums', { title: '  Holiday  ', photoIds: [a] })).json()) as { id: number };
      await s.post(`/api/albums/${album}/photos`, { ids: [b] });
      await s.post(`/api/albums/${album}/photos`, { ids: [b] }); // Adding twice is harmless.

      let listed = (await s.json('/api/albums')).albums;
      expect(listed[0]).toMatchObject({ id: album, title: 'Holiday', photoCount: 2, coverId: b });
      expect((await s.grid(`?album=${album}`)).map((i) => i[0])).toEqual([b, a]);
      expect((await s.json(`/api/photos/${a}`)).albums).toEqual([{ id: album, title: 'Holiday' }]);

      await s.fetch(`/api/albums/${album}`, { method: 'PATCH', body: JSON.stringify({ title: 'Trip', coverPhotoId: a }), headers: { 'content-type': 'application/json' } });
      listed = (await s.json('/api/albums')).albums;
      expect(listed[0]).toMatchObject({ title: 'Trip', coverId: a });

      await s.fetch('/api/photos', { method: 'PATCH', body: JSON.stringify({ ids: [a], trashed: true }), headers: { 'content-type': 'application/json' } });
      listed = (await s.json('/api/albums')).albums;
      expect(listed[0]).toMatchObject({ photoCount: 1, coverId: b });
      expect((await s.grid(`?album=${album}`)).map((i) => i[0])).toEqual([b]);

      await s.post(`/api/albums/${album}/photos/remove`, { ids: [b] });
      expect(await s.grid(`?album=${album}`)).toEqual([]);

      await s.fetch(`/api/albums/${album}`, { method: 'DELETE' });
      expect((await s.json('/api/albums')).albums).toEqual([]);
      expect((await s.grid()).map((i) => i[0])).toEqual([b]);
    });

    it('requires an album name', async () => {
      expect((await s.post('/api/albums', { title: '   ' })).status).toBe(400);
    });
  });

  describe('downloading many photos', () => {
    it('builds a zip whose contents are byte-identical, with clashing names kept apart', async () => {
      await s.signIn();
      const one = await makeJpeg({ color: '#1a1a1a' });
      const two = await makeJpeg({ color: '#2b2b2b' });
      const three = await makeJpeg({ color: '#3c3c3c' });
      const ids = [
        await s.uploadOk(one, 'same.jpg'),
        await s.uploadOk(two, 'same.jpg'),
        await s.uploadOk(three, 'other.jpg'),
      ];
      await s.ctx.queue.drain();
      const res = await s.fetch(`/api/photos/zip?ids=${ids.join(',')}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');

      const dir = mkdtempSync(join(tmpdir(), 'tp-zip-'));
      try {
        const zip = join(dir, 'a.zip');
        writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
        execFileSync('python3', ['-c', `import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])`, zip, dir]);
        const hashes = readdirSync(dir).filter((n) => n.endsWith('.jpg')).map((n) => sha256(readFileSync(join(dir, n)))).sort();
        expect(readdirSync(dir).filter((n) => n.endsWith('.jpg')).sort()).toEqual(['other.jpg', 'same (1).jpg', 'same.jpg']);
        expect(hashes).toEqual([one, two, three].map((b) => sha256(b)).sort());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('surviving a restart', () => {
    it('picks up an upload that was interrupted mid-way', async () => {
      await s.signIn();
      s.storage.failNextPut = new Error('stop');
      const original = await makeJpeg({ color: '#9a9a9a' });
      const id = await s.uploadOk(original);
      await s.ctx.queue.drain();
      // Crash simulation: a row left as "uploading", with the local file still present.
      s.ctx.repo.db.prepare(`UPDATE photos SET status = 'uploading', next_attempt_at = 0 WHERE id = ?`).run(id);
      await s.stop();

      const again = await new TestServer(s.dir, false).start();
      again.cookie = s.cookie;
      await again.ctx.queue.drain();
      expect((await again.json(`/api/photos/${id}`)).status).toBe('stored');
      const back = new Uint8Array(await (await again.fetch(`/api/photos/${id}/original`)).arrayBuffer());
      expect(sha256(back)).toBe(sha256(original));
      s = again;
    });

    it('cleans up leftovers on start without touching files still needed', async () => {
      await s.signIn();
      s.storage.failNextPut = new Error('stop');
      await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();
      const needed = readdirSync(s.ctx.paths.incomingDir);
      writeFileSync(join(s.ctx.paths.incomingDir, '1-deadbeef'), 'orphan');
      writeFileSync(join(s.ctx.paths.tmpDir, 'half-upload'), 'orphan');
      await s.stop();

      const again = await new TestServer(s.dir, false).start();
      again.storage.failNextPut = new Error('stay queued');
      expect(readdirSync(again.ctx.paths.incomingDir)).toEqual(needed);
      expect(readdirSync(again.ctx.paths.tmpDir)).toEqual([]);
      s = again;
    });

    it('keeps people signed in, and the session readable, across a restart', async () => {
      await s.signIn();
      await s.stop();
      const again = await new TestServer(s.dir, false).start();
      again.cookie = s.cookie;
      expect((await again.json('/api/session')).account.firstName).toBe('Demo');
      s = again;
    });
  });

  describe('rebuilding from Telegram', () => {
    it('restores the whole library after the local data is lost', async () => {
      await s.signIn();
      const original = await makeJpeg({ width: 1200, height: 800, date: '2018:05:06 07:08:09', camera: 'EOS R5', color: '#5e5e5e' });
      const other = await makeJpeg({ width: 640, height: 480, date: '2017:01:02 03:04:05', color: '#6f6f6f' });
      const firstId = await s.uploadOk(original, 'keep.jpg');
      await s.uploadOk(other, 'also.jpg');
      await s.ctx.queue.drain();
      const fakeRoot = join(s.dir, 'fake-telegram');
      expect(existsSync(fakeRoot)).toBe(true);
      expect(firstId).toBeGreaterThan(0);
      await s.stop();

      // Everything local is gone, except what stands in for Telegram itself.
      for (const name of readdirSync(s.dir)) {
        if (name !== 'fake-telegram') rmSync(join(s.dir, name), { recursive: true, force: true });
      }

      const again = await new TestServer(s.dir, false).start();
      s = again;
      await again.signIn();
      await expect.poll(async () => (await again.json('/api/library')).scan.running, { timeout: 5000 }).toBe(false);
      await again.ctx.queue.drain();

      const grid = await again.grid();
      expect(grid.map((i) => i[5])).toEqual(['keep.jpg', 'also.jpg']);
      const detail = await again.json(`/api/photos/${grid[0]![0]}`);
      expect(detail).toMatchObject({ takenAt: '2018-05-06T07:08:09', width: 1200, height: 800, status: 'stored', previewState: 'ready', sha256: sha256(original) });
      expect(detail.camera.model).toBe('EOS R5');
      expect((await again.fetch(`/api/photos/${grid[0]![0]}/thumb`)).status).toBe(200);
      const back = new Uint8Array(await (await again.fetch(`/api/photos/${grid[0]![0]}/original`)).arrayBuffer());
      expect(sha256(back)).toBe(sha256(original));
    });

    it('rescanning twice adds nothing new, and ignores messages it did not write', async () => {
      await s.signIn();
      await s.uploadOk(await makeJpeg());
      await s.ctx.queue.drain();

      const storage = s.storage;
      const original = storage.scanLibrary.bind(storage);
      storage.scanLibrary = async function* (ctx) {
        yield { messageId: 999, filename: 'holiday-note.pdf', size: 10, mime: 'application/pdf', caption: 'just a note I posted', date: 1 };
        yield* original(ctx);
      } as typeof storage.scanLibrary;

      await s.post('/api/library/rescan', {});
      await expect.poll(async () => (await s.json('/api/library')).scan.running, { timeout: 5000 }).toBe(false);
      const scan = (await s.json('/api/library')).scan;
      expect(scan).toMatchObject({ scanned: 1, added: 0, error: null });
      expect((await s.grid()).length).toBe(1);
    });
  });

  describe('captions', () => {
    const hash = 'a'.repeat(64);

    it('round-trips the facts needed for a rebuild', () => {
      const caption = buildCaption({ filename: 'IMG 1.jpg', sha256: hash, takenAt: '2024-07-01T18:22:10', width: 4032, height: 3024 });
      expect(parseCaption(caption)).toEqual({ sha256: hash, takenAt: '2024-07-01T18:22:10', width: 4032, height: 3024 });
      expect(caption).toContain('#y2024_07');
    });

    it('stays within Telegram\'s 1024 character limit, with the marker intact', () => {
      const caption = buildCaption({ filename: 'x'.repeat(5000), sha256: hash, takenAt: '2024-07-01T18:22:10', width: null, height: null });
      expect(caption.length).toBeLessThanOrEqual(1024);
      expect(parseCaption(caption)?.sha256).toBe(hash);
    });

    it('is not fooled by a filename that imitates the marker', () => {
      const evil = `telephoto:v1 sha256=${'b'.repeat(64)} taken=1999-01-01T00:00:00`;
      const caption = buildCaption({ filename: evil, sha256: hash, takenAt: '2024-07-01T18:22:10', width: 1, height: 1 });
      expect(parseCaption(caption)?.sha256).toBe(hash);
    });

    it('ignores captions it did not write', () => {
      expect(parseCaption('holiday pics')).toBeNull();
      expect(parseCaption('')).toBeNull();
    });
  });

  it('marks fake storage so the UI can warn about it', async () => {
    expect((await s.json('/api/session')).storage).toBe('fake');
    expect(s.storage).toBeInstanceOf(FakeStorage);
  });
});
