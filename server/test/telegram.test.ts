/**
 * Runs the real GramJS code down to the point a request would hit the network. Only the socket is
 * replaced, so these tests check the exact requests Telegram would receive.
 */
import bigInt from 'big-integer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Api, TelegramClient, errors } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { StringSession } from 'telegram/sessions/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES } from '../src/config.js';
import { TelegramStorage } from '../src/storage/telegram.js';
import { OriginalMissingError, RateLimitedError, SessionRevokedError, UserFacingError } from '../src/storage/types.js';

const ctx = { session: '', library: { channelId: '777', accessHash: '888' } };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** What Telegram would answer to a successful SendMedia, unless a test overrides `reply`. */
function documentReply(req: Api.messages.SendMedia, size: number, messageId = 42) {
  return new Api.Updates({
    updates: [
      new Api.UpdateMessageID({ id: messageId, randomId: req.randomId }),
      new Api.UpdateNewChannelMessage({
        pts: 1,
        ptsCount: 1,
        message: new Api.Message({
          id: messageId,
          peerId: new Api.PeerChannel({ channelId: bigInt(777) }),
          date: 1,
          message: req.message,
          media: new Api.MessageMediaDocument({
            document: new Api.Document({
              id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.alloc(0), date: 1,
              mimeType: 'image/jpeg', size: bigInt(size), dcId: 2, attributes: [],
            }),
          }),
        }),
      }),
    ],
    users: [],
    chats: [],
    date: 1,
    seq: 1,
  });
}

class Harness {
  parts = new Map<number, Buffer>();
  /** Plain facts only. GramJS requests retain their bytes, so keeping them would itself use 2 GB. */
  partRequests: { filePart: number; fileTotalParts: number | null; isBig: boolean }[] = [];
  keepBytes = true;
  sent: Api.messages.SendMedia[] = [];
  deleted: Api.channels.DeleteMessages[] = [];
  reply: ((req: Api.messages.SendMedia) => unknown) | null = null;
  invokeError: unknown = null;
  remote: Buffer = Buffer.alloc(0);
  getFileRequests: Api.upload.GetFile[] = [];
  /** Set by getMessages. A real Api.Message, or anything else to simulate a missing one. */
  messages: unknown[] = [];

  factory = (): TelegramClient => {
    const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
    const sender = {
      dcId: 2,
      isConnected: () => true,
      send: async (req: Api.upload.SaveBigFilePart | Api.upload.SaveFilePart) => {
        const isBig = req instanceof Api.upload.SaveBigFilePart;
        this.partRequests.push({ filePart: req.filePart, fileTotalParts: isBig ? req.fileTotalParts : null, isBig });
        if (this.keepBytes) this.parts.set(req.filePart, Buffer.from(req.bytes));
        return true;
      },
    };
    Object.defineProperty(client, 'connected', { get: () => true });
    client.connect = async () => true;
    client.destroy = async () => {};
    client.getSender = (async () => sender) as unknown as TelegramClient['getSender'];
    client.invoke = (async (req: unknown) => {
      if (this.invokeError) throw this.invokeError;
      if (req instanceof Api.messages.SendMedia) {
        this.sent.push(req);
        if (this.reply) return this.reply(req);
        const file = (req.media as Api.InputMediaUploadedDocument).file;
        const size = file instanceof Api.InputFileBig || file instanceof Api.InputFile ? [...this.parts.values()].reduce((n, b) => n + b.length, 0) : 0;
        return documentReply(req, size);
      }
      if (req instanceof Api.channels.DeleteMessages) {
        this.deleted.push(req);
        return new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 });
      }
      throw new Error(`Unexpected request: ${(req as { className?: string }).className}`);
    }) as TelegramClient['invoke'];
    client.invokeWithSender = (async (req: Api.upload.GetFile) => {
      this.getFileRequests.push(req);
      const offset = req.offset.toJSNumber();
      return new Api.upload.File({
        type: new Api.storage.FileUnknown(),
        mtime: 1,
        bytes: this.remote.subarray(offset, offset + req.limit),
      });
    }) as unknown as TelegramClient['invokeWithSender'];
    client.getMessages = (async () => this.messages) as unknown as TelegramClient['getMessages'];
    return client;
  };

  storage = new TelegramStorage(1, 'hash', this.factory);

  reassembled(): Buffer {
    const order = [...this.parts.keys()].sort((a, b) => a - b);
    return Buffer.concat(order.map((i) => this.parts.get(i)!));
  }
}

function storedMessage(size: number) {
  return new Api.Message({
    id: 42,
    peerId: new Api.PeerChannel({ channelId: bigInt(777) }),
    date: 1,
    message: '',
    media: new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt(1), accessHash: bigInt(2), fileReference: Buffer.from([1]), date: 1,
        mimeType: 'image/jpeg', size: bigInt(size), dcId: 2, attributes: [],
      }),
    }),
  });
}

describe('TelegramStorage against real GramJS', () => {
  let dir: string;
  let h: Harness;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tp-tg-'));
    h = new Harness();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function put(name: string, bytes: Buffer, mime = 'image/jpeg') {
    const path = join(dir, name);
    writeFileSync(path, bytes);
    return h.storage.putPhoto(ctx, { path, filename: name, mime, size: bytes.length, caption: 'cap' }, () => {});
  }

  it('documents why we avoid sendFile: it clears force_file for JPEGs even with forceDocument', async () => {
    // If a GramJS upgrade ever changes this, the workaround may no longer be needed.
    const path = join(dir, 'a.jpg');
    const bytes = randomBytes(2048);
    writeFileSync(path, bytes);
    const client = h.factory();
    (client as unknown as { getInputEntity: unknown }).getInputEntity = async () => new Api.InputPeerSelf();
    (client as unknown as { _getResponseMessage: unknown })._getResponseMessage = () => new Api.MessageEmpty({ id: 1 });
    await client.sendFile('me', { file: new CustomFile('a.jpg', bytes.length, path), forceDocument: true }).catch(() => {});
    const media = h.sent[0]!.media as Api.InputMediaUploadedDocument;
    expect(media.className).toBe('InputMediaUploadedDocument');
    expect(media.forceFile).toBeFalsy();
  });

  for (const name of ['a.jpg', 'b.JPEG', 'c.png', 'd.gif', 'e.webp', 'f.heic']) {
    it(`sends ${name} as a forced document, never as a compressed photo`, async () => {
      const bytes = randomBytes(5000);
      await put(name, bytes);
      expect(h.sent).toHaveLength(1);
      const req = h.sent[0]!;
      expect(req.media).toBeInstanceOf(Api.InputMediaUploadedDocument);
      const media = req.media as Api.InputMediaUploadedDocument;
      expect(media.forceFile).toBe(true);
      expect(media.mimeType).toBe('image/jpeg');
      expect(media.attributes[0]).toBeInstanceOf(Api.DocumentAttributeFilename);
      expect((media.attributes[0] as Api.DocumentAttributeFilename).fileName).toBe(name);
      // A request that serializes is one Telegram can parse.
      expect(req.getBytes().length).toBeGreaterThan(0);
    });
  }

  it('sends a small file byte for byte, in one message', async () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 17);
    const { messageId } = await put('small.jpg', bytes);
    expect(messageId).toBe(42);
    expect(h.sent).toHaveLength(1);
    expect(sha(h.reassembled())).toBe(sha(bytes));
    expect(h.partRequests[0]!.isBig).toBe(false);
  });

  it('sends a file over 10 MB through the big-file call, byte for byte', async () => {
    const bytes = randomBytes(25 * 1024 * 1024 + 123);
    await put('big.jpg', bytes);
    expect(h.partRequests[0]!.isBig).toBe(true);
    expect(sha(h.reassembled())).toBe(sha(bytes));
    const media = h.sent[0]!.media as Api.InputMediaUploadedDocument;
    expect(media.file).toBeInstanceOf(Api.InputFileBig);
  });

  it('handles the largest allowed file: 4000 parts, one message, bounded memory', async () => {
    h.keepBytes = false;
    const path = join(dir, 'max.jpg');
    writeFileSync(path, '');
    truncateSync(path, MAX_PHOTO_BYTES); // Sparse, so this takes no real disk space.
    h.reply = (req) => documentReply(req, MAX_PHOTO_BYTES);

    const before = process.memoryUsage().rss;
    let peak = before;
    let last = 0;
    await h.storage.putPhoto(ctx, { path, filename: 'max.jpg', mime: 'image/jpeg', size: MAX_PHOTO_BYTES, caption: '' }, (f) => {
      last = f;
      peak = Math.max(peak, process.memoryUsage().rss);
    });

    expect(h.sent).toHaveLength(1);
    const file = (h.sent[0]!.media as Api.InputMediaUploadedDocument).file as Api.InputFileBig;
    expect(file).toBeInstanceOf(Api.InputFileBig);
    expect(file.parts).toBe(4000);
    expect(h.partRequests).toHaveLength(4000);
    for (const part of h.partRequests) expect(part.fileTotalParts).toBe(4000);
    expect(new Set(h.partRequests.map((p) => p.filePart)).size).toBe(4000);
    expect(last).toBeCloseTo(1, 5);
    // Reads are streamed from disk. The whole file in memory would be about 2000 MB.
    expect(peak - before).toBeLessThan(500 * 1024 * 1024);
  }, 180_000);

  it('rejects the upload and removes the message if Telegram returned a compressed photo', async () => {
    h.reply = (req) =>
      new Api.Updates({
        updates: [
          new Api.UpdateMessageID({ id: 9, randomId: req.randomId }),
          new Api.UpdateNewChannelMessage({
            pts: 1, ptsCount: 1,
            message: new Api.Message({
              id: 9, peerId: new Api.PeerChannel({ channelId: bigInt(777) }), date: 1, message: '',
              media: new Api.MessageMediaPhoto({}),
            }),
          }),
        ],
        users: [], chats: [], date: 1, seq: 1,
      });
    await expect(put('a.jpg', randomBytes(1000))).rejects.toThrow(/unmodified document/);
    expect(h.deleted[0]!.id).toEqual([9]);
  });

  it('rejects the upload if Telegram kept a different size', async () => {
    h.reply = (req) => documentReply(req, 999);
    await expect(put('a.jpg', randomBytes(1000))).rejects.toThrow(/unmodified document/);
    expect(h.deleted).toHaveLength(1);
  });

  it('turns a flood wait into a queue pause rather than a failure', async () => {
    h.invokeError = new errors.FloodWaitError({ request: new Api.help.GetConfig(), capture: 120 } as never);
    await expect(put('a.jpg', randomBytes(100))).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('recognises a session the user ended from their Telegram settings', async () => {
    h.invokeError = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
    await expect(put('a.jpg', randomBytes(100))).rejects.toBeInstanceOf(SessionRevokedError);
  });

  for (const [label, size] of [
    ['smaller than one request', 1000],
    ['exactly one request', 512 * 1024],
    ['exactly two requests', 1024 * 1024],
    ['one byte past two requests', 1024 * 1024 + 1],
    ['several requests', 3 * 1024 * 1024 + 4242],
  ] as const) {
    it(`downloads a file ${label} byte for byte, with valid offsets`, async () => {
      h.remote = randomBytes(size);
      h.messages = [storedMessage(size)];
      const { size: reported, stream } = await h.storage.getPhoto(ctx, 42);
      expect(reported).toBe(size);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(sha(Buffer.concat(chunks))).toBe(sha(h.remote));
      for (const req of h.getFileRequests) {
        // Telegram's documented rules for upload.getFile without the `precise` flag.
        expect(req.limit % 4096).toBe(0);
        expect((1024 * 1024) % req.limit).toBe(0);
        expect(req.offset.toJSNumber() % 4096).toBe(0);
      }
    });
  }

  it('reports a clear error when the message is gone from Telegram', async () => {
    h.messages = [new Api.MessageEmpty({ id: 42 })];
    await expect(h.storage.getPhoto(ctx, 42)).rejects.toBeInstanceOf(OriginalMissingError);
    h.messages = [undefined];
    await expect(h.storage.getPhoto(ctx, 42)).rejects.toBeInstanceOf(OriginalMissingError);
  });

  it('deletes in batches of 100, which is what channels.deleteMessages allows', async () => {
    await h.storage.deletePhotos(ctx, Array.from({ length: 250 }, (_, i) => i + 1));
    expect(h.deleted.map((d) => d.id.length)).toEqual([100, 100, 50]);
  });

  describe('signing in', () => {
    function loginHarness(respond: (req: unknown) => unknown) {
      const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
      client.connect = async () => true;
      client.destroy = async () => {};
      client.sendCode = (async () => ({ phoneCodeHash: 'hash', isCodeViaApp: true })) as TelegramClient['sendCode'];
      client.invoke = (async (req: unknown) => respond(req)) as TelegramClient['invoke'];
      (client.session as StringSession).save = () => 'SESSION-STRING';
      return new TelegramStorage(1, 'hash', () => client);
    }
    const user = new Api.User({ id: bigInt(5), firstName: 'Ada', phone: '15551234567', accessHash: bigInt(1) });

    it('completes with a code', async () => {
      const storage = loginHarness((req) => {
        if (req instanceof Api.auth.SignIn) {
          expect(req.phoneCode).toBe('12345');
          expect(req.phoneNumber).toBe('+15551234567');
          expect(req.phoneCodeHash).toBe('hash');
          return new Api.auth.Authorization({ user });
        }
        throw new Error('unexpected');
      });
      const { loginId, delivery } = await storage.sendLoginCode('+15551234567');
      expect(delivery).toBe('app');
      const result = await storage.submitLoginCode(loginId, '12345');
      expect(result).toEqual({
        status: 'ok',
        session: 'SESSION-STRING',
        user: { id: '5', firstName: 'Ada', lastName: '', username: '', phone: '+15551234567' },
      });
    });

    it('asks for the password when two-step verification is on', async () => {
      const storage = loginHarness((req) => {
        if (req instanceof Api.auth.SignIn) throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
        if (req instanceof Api.account.GetPassword) return { hint: 'my dog' };
        throw new Error('unexpected');
      });
      const { loginId } = await storage.sendLoginCode('+15551234567');
      expect(await storage.submitLoginCode(loginId, '12345')).toEqual({ status: 'needs-password', hint: 'my dog' });
    });

    it('explains a wrong code and allows another try', async () => {
      let calls = 0;
      const storage = loginHarness(() => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('x'), { errorMessage: 'PHONE_CODE_INVALID' });
        return new Api.auth.Authorization({ user });
      });
      const { loginId } = await storage.sendLoginCode('+15551234567');
      await expect(storage.submitLoginCode(loginId, '000')).rejects.toMatchObject({ code: 'CODE_INVALID' });
      expect((await storage.submitLoginCode(loginId, '12345')).status).toBe('ok');
    });

    it('rejects a sign-in id it never issued', async () => {
      const storage = loginHarness(() => null);
      await expect(storage.submitLoginCode('nope', '1')).rejects.toBeInstanceOf(UserFacingError);
    });
  });
});
