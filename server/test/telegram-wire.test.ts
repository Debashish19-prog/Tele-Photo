/**
 * These tests run the real GramJS upload and download code, and replace only the network socket.
 * They pin down the exact requests sent to Telegram, because those requests are what decide
 * whether a photo keeps its quality. They cannot prove how Telegram's servers respond. That
 * is what `pnpm verify:telegram` is for.
 */
import bigInt from 'big-integer';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Api, TelegramClient, errors } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { TelegramStorage } from '../src/storage/telegram.js';
import { OriginalMissingError, RateLimitedError, SessionRevokedError, type StorageContext } from '../src/storage/types.js';
import { tempDir } from './helpers.js';

const CTX: StorageContext = { session: '', library: { channelId: '1234', accessHash: '5678' } };

interface Wire {
  client: TelegramClient;
  parts: Map<number, Buffer>;
  partRequests: (Api.upload.SaveBigFilePart | Api.upload.SaveFilePart)[];
  invoked: unknown[];
  storedSize: () => number;
  /** Replaces the media that Telegram reports back after sending. */
  mediaOverride: Api.TypeMessageMedia | null;
  failSendWith: Error | null;
  maxLiveBytes: number;
}

function document(size: number): Api.Document {
  return new Api.Document({
    id: bigInt(99), accessHash: bigInt(1), fileReference: Buffer.from([1]), date: 0, mimeType: 'image/jpeg',
    size: bigInt(size), dcId: 2, attributes: [],
  });
}

function makeWire(): Wire {
  const client = new TelegramClient(new StringSession(''), 1, 'hash', { connectionRetries: 0 });
  const wire: Wire = {
    client, parts: new Map(), partRequests: [], invoked: [], mediaOverride: null, failSendWith: null, maxLiveBytes: 0,
    storedSize: () => [...wire.parts.values()].reduce((n, b) => n + b.length, 0),
  };

  const stub = client as unknown as Record<string, unknown>;
  stub.connect = async () => true;
  stub.destroy = async () => undefined;
  Object.defineProperty(client, 'connected', { get: () => true });
  stub.getSender = async () => ({
    dcId: 2,
    isConnected: () => true,
    send: async (req: Api.upload.SaveBigFilePart | Api.upload.SaveFilePart) => {
      wire.partRequests.push(req);
      wire.parts.set(req.filePart, Buffer.from(req.bytes));
      return true;
    },
  });
  stub.invoke = async (req: unknown) => {
    wire.invoked.push(req);
    if (req instanceof Api.messages.SendMedia) {
      if (wire.failSendWith) throw wire.failSendWith;
      const media = wire.mediaOverride ?? new Api.MessageMediaDocument({ document: document(wire.storedSize()) });
      const message = new Api.Message({
        id: 777, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 0, message: req.message, media,
      });
      return new Api.Updates({
        updates: [
          new Api.UpdateMessageID({ id: 777, randomId: req.randomId }),
          new Api.UpdateNewChannelMessage({ message, pts: 1, ptsCount: 1 }),
        ],
        users: [], chats: [], date: 0, seq: 0,
      });
    }
    return true;
  };
  return wire;
}

function storageOver(wire: Wire): TelegramStorage {
  return new TelegramStorage(1, 'hash', () => wire.client);
}

describe('storing a photo on the Telegram wire', () => {
  let tmp: ReturnType<typeof tempDir>;
  let wire: Wire;
  beforeEach(() => {
    tmp = tempDir();
    wire = makeWire();
  });
  afterEach(() => tmp.cleanup());

  async function put(name: string, data: Buffer, mime: string) {
    const path = join(tmp.dir, 'source');
    writeFileSync(path, data);
    return storageOver(wire).putPhoto(CTX, { path, filename: name, mime, size: data.length, caption: 'cap' }, () => undefined);
  }

  const sentMedia = () => {
    const req = wire.invoked.find((r) => r instanceof Api.messages.SendMedia) as Api.messages.SendMedia;
    return req.media as Api.InputMediaUploadedDocument;
  };

  // The heart of "the quality stays intact": these extensions are the ones GramJS's sendFile gets wrong.
  it.each([
    ['photo.jpg', 'image/jpeg'],
    ['PHOTO.JPEG', 'image/jpeg'],
    ['shot.png', 'image/png'],
    ['anim.gif', 'image/gif'],
    ['pic.webp', 'image/webp'],
    ['iphone.heic', 'image/heic'],
  ])('sends %s as an uncompressed file, never as a photo', async (name, mime) => {
    await put(name, randomBytes(4096), mime);
    const media = sentMedia();
    expect(media).toBeInstanceOf(Api.InputMediaUploadedDocument);
    expect(media.forceFile).toBe(true);
    expect(media.mimeType).toBe(mime);
    expect(media.attributes).toHaveLength(1);
    expect((media.attributes[0] as Api.DocumentAttributeFilename).fileName).toBe(name);
  });

  it('produces a request GramJS can really serialize for the wire', async () => {
    await put('photo.jpg', randomBytes(1024), 'image/jpeg');
    const req = wire.invoked.find((r) => r instanceof Api.messages.SendMedia) as Api.messages.SendMedia;
    expect(req.getBytes().length).toBeGreaterThan(0);
  });

  it('delivers exactly the source bytes, in one file and one message', async () => {
    const data = randomBytes(3 * 1024 * 1024 + 123);
    const result = await put('photo.jpg', data, 'image/jpeg');
    expect(result.messageId).toBe(777);
    const parts = [...wire.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    expect(createHash('sha256').update(Buffer.concat(parts)).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    expect(wire.invoked.filter((r) => r instanceof Api.messages.SendMedia)).toHaveLength(1);
  });

  it('switches to big-file parts above 10 MB and reads them from disk', async () => {
    const data = randomBytes(21 * 1024 * 1024);
    await put('large.png', data, 'image/png');
    expect(wire.partRequests[0]).toBeInstanceOf(Api.upload.SaveBigFilePart);
    const parts = [...wire.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
    expect(Buffer.concat(parts).equals(data)).toBe(true);
    expect((sentMedia().file as Api.InputFileBig).className).toBe('InputFileBig');
  });

  // The largest-file case lives in telegram.test.ts, which also checks that memory stays bounded.

  it('rejects the result if Telegram kept a compressed photo instead', async () => {
    wire.mediaOverride = new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(1) }) });
    await expect(put('photo.jpg', randomBytes(2048), 'image/jpeg')).rejects.toThrow(/unmodified/);
    // The altered copy is removed, not left behind as clutter.
    expect(wire.invoked.some((r) => r instanceof Api.channels.DeleteMessages)).toBe(true);
  });

  it('rejects the result if the stored size differs by even one byte', async () => {
    wire.mediaOverride = new Api.MessageMediaDocument({ document: document(2047) });
    await expect(put('photo.jpg', randomBytes(2048), 'image/jpeg')).rejects.toThrow(/unmodified/);
  });

  it('reports a flood wait as a pause rather than a failure', async () => {
    wire.failSendWith = new errors.FloodWaitError({ request: {} as never, capture: 42 } as never);
    await expect(put('photo.jpg', randomBytes(100), 'image/jpeg')).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('reports a revoked session distinctly', async () => {
    wire.failSendWith = Object.assign(new Error('x'), { errorMessage: 'AUTH_KEY_UNREGISTERED' });
    await expect(put('photo.jpg', randomBytes(100), 'image/jpeg')).rejects.toBeInstanceOf(SessionRevokedError);
  });
});

describe('reading a photo back over the wire', () => {
  function wireServing(data: Buffer | null) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const requests: Api.upload.GetFile[] = [];
    stub.getMessages = async () => {
      if (!data) return [undefined];
      return [new Api.Message({
        id: 5, peerId: new Api.PeerChannel({ channelId: bigInt(1234) }), date: 0, message: '',
        media: new Api.MessageMediaDocument({ document: document(data.length) }),
      })];
    };
    stub.invokeWithSender = async (req: Api.upload.GetFile) => {
      requests.push(req);
      const offset = req.offset.toJSNumber();
      return new Api.upload.File({ type: new Api.storage.FilePartial(), mtime: 0, bytes: data!.subarray(offset, offset + req.limit) });
    };
    return { wire, requests };
  }

  it.each([
    ['smaller than one chunk', 1000],
    ['exactly one chunk', 512 * 1024],
    ['exactly several chunks', 3 * 512 * 1024],
    ['one byte over a chunk', 512 * 1024 + 1],
    ['several chunks and a bit', 5 * 512 * 1024 + 777],
  ])('returns every byte when the file is %s', async (_label, size) => {
    const data = randomBytes(size);
    const { wire, requests } = wireServing(data);
    const { size: reported, stream } = await storageOver(wire).getPhoto(CTX, 5);
    expect(reported).toBe(size);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
    // Telegram rejects reads that are not aligned to these sizes.
    for (const r of requests) {
      expect(r.limit).toBe(512 * 1024);
      expect(r.offset.toJSNumber() % (4 * 1024)).toBe(0);
    }
  });

  it('says clearly when the message is gone', async () => {
    const { wire } = wireServing(null);
    await expect(storageOver(wire).getPhoto(CTX, 5)).rejects.toBeInstanceOf(OriginalMissingError);
  });
});

describe('signing in', () => {
  function wireWithLogin(behaviour: (req: unknown) => unknown) {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    stub.sendCode = async () => ({ phoneCodeHash: 'hash', isCodeViaApp: true });
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      return behaviour(req);
    };
    return wire;
  }

  const user = new Api.User({ id: bigInt(42), firstName: 'Ada', lastName: 'L', username: 'ada', phone: '15550000001' });

  it('completes with a code', async () => {
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) {
        expect(req.phoneCode).toBe('11111');
        expect(req.phoneCodeHash).toBe('hash');
        return new Api.auth.Authorization({ user });
      }
    });
    const storage = storageOver(wire);
    const { loginId, delivery } = await storage.sendLoginCode('+15550000001');
    expect(delivery).toBe('app');
    const result = await storage.submitLoginCode(loginId, '11111');
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.user).toMatchObject({ id: '42', firstName: 'Ada', phone: '+15550000001' });
    }
  });

  it('asks for the password when two-step verification is on', async () => {
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) throw Object.assign(new Error('x'), { errorMessage: 'SESSION_PASSWORD_NEEDED' });
      if (req instanceof Api.account.GetPassword) return { hint: 'first pet' };
    });
    const storage = storageOver(wire);
    const { loginId } = await storage.sendLoginCode('+15550000001');
    expect(await storage.submitLoginCode(loginId, '11111')).toEqual({ status: 'needs-password', hint: 'first pet' });
  });

  it('explains a wrong code and allows another try', async () => {
    let tries = 0;
    const wire = wireWithLogin((req) => {
      if (req instanceof Api.auth.SignIn) {
        if (tries++ === 0) throw Object.assign(new Error('x'), { errorMessage: 'PHONE_CODE_INVALID' });
        return new Api.auth.Authorization({ user });
      }
    });
    const storage = storageOver(wire);
    const { loginId } = await storage.sendLoginCode('+15550000001');
    await expect(storage.submitLoginCode(loginId, '00000')).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect((await storage.submitLoginCode(loginId, '11111')).status).toBe('ok');
  });

  it('refuses an unknown login id', async () => {
    const storage = storageOver(makeWire());
    await expect(storage.submitLoginCode('nope', '1')).rejects.toMatchObject({ code: 'LOGIN_EXPIRED' });
  });
});

describe('the library channel', () => {
  it('creates a broadcast channel when none exists', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    stub.iterDialogs = async function* () {};
    const channel = new Api.Channel({ id: bigInt(77), accessHash: bigInt(88), title: 't', photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      if (req instanceof Api.channels.CreateChannel) {
        expect(req.broadcast).toBe(true);
        return new Api.Updates({ updates: [], users: [], chats: [channel], date: 0, seq: 0 });
      }
    };
    const result = await storageOver(wire).ensureLibrary('');
    expect(result).toEqual({ library: { channelId: '77', accessHash: '88' }, existing: false });
  });

  it('reconnects to an existing library instead of making a second one', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const channel = new Api.Channel({ id: bigInt(77), accessHash: bigInt(88), title: 'Tele-Photo Library', creator: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.iterDialogs = async function* () { yield { entity: channel }; };
    stub.invoke = async (req: unknown) => {
      wire.invoked.push(req);
      if (req instanceof Api.channels.GetFullChannel) return { fullChat: { about: 'x tele-photo-library:v1' } };
      throw new Error('must not create another channel');
    };
    expect(await storageOver(wire).ensureLibrary('')).toEqual({ library: { channelId: '77', accessHash: '88' }, existing: true });
  });

  it('ignores a look-alike channel without the marker', async () => {
    const wire = makeWire();
    const stub = wire.client as unknown as Record<string, unknown>;
    const lookalike = new Api.Channel({ id: bigInt(1), accessHash: bigInt(2), title: 'Tele-Photo Library', creator: true, photo: new Api.ChatPhotoEmpty(), date: 0 });
    const created = new Api.Channel({ id: bigInt(3), accessHash: bigInt(4), title: 't', photo: new Api.ChatPhotoEmpty(), date: 0 });
    stub.iterDialogs = async function* () { yield { entity: lookalike }; };
    stub.invoke = async (req: unknown) => {
      if (req instanceof Api.channels.GetFullChannel) return { fullChat: { about: 'someone else' } };
      if (req instanceof Api.channels.CreateChannel) return new Api.Updates({ updates: [], users: [], chats: [created], date: 0, seq: 0 });
    };
    expect((await storageOver(wire).ensureLibrary('')).library.channelId).toBe('3');
  });
});
