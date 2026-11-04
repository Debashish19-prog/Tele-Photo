import bigInt from 'big-integer';
import { randomBytes, randomUUID } from 'node:crypto';
import { Api, TelegramClient, errors } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';
import { LogLevel, Logger } from 'telegram/extensions/Logger.js';
import { readBigIntFromBuffer } from 'telegram/Helpers.js';
import { computeCheck } from 'telegram/Password.js';
import { StringSession } from 'telegram/sessions/index.js';
import {
  type CodeResult,
  type EnsureLibraryResult,
  type LibraryRef,
  type LoginSuccess,
  OriginalMissingError,
  type PutPhotoInput,
  RateLimitedError,
  type ScannedPhoto,
  SessionRevokedError,
  type StorageBackend,
  type StorageContext,
  type TelegramUser,
  UserFacingError,
} from './types.js';

export const LIBRARY_TITLE = 'Tele-Photo Library';
const LIBRARY_MARKER = 'tele-photo-library:v1';
const LIBRARY_ABOUT = `Private storage for your Tele-Photo library. Deleting this channel deletes your photos. ${LIBRARY_MARKER}`;

/** Telegram's largest part size, and also the largest read it allows in one request. */
const DOWNLOAD_REQUEST_BYTES = 512 * 1024;
const UPLOAD_WORKERS = 4;
const LOGIN_TTL_MS = 10 * 60 * 1000;
const DELETE_BATCH = 100;
const DIALOG_SCAN_LIMIT = 1000;

const REVOKED_ERRORS = new Set([
  'AUTH_KEY_UNREGISTERED', 'AUTH_KEY_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DEACTIVATED',
  'USER_DEACTIVATED_BAN', 'AUTH_KEY_PERM_EMPTY', 'AUTH_KEY_DUPLICATED',
]);

export type ClientFactory = (session: string, apiId: number, apiHash: string) => TelegramClient;

const defaultClientFactory: ClientFactory = (session, apiId, apiHash) =>
  new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.NONE),
  });

function rpcCode(err: unknown): string | undefined {
  const message = (err as { errorMessage?: unknown } | null)?.errorMessage;
  return typeof message === 'string' ? message : undefined;
}

/** Converts library errors into ones the upload queue and the API know how to handle. */
function translate(err: unknown): unknown {
  if (err instanceof errors.FloodWaitError) return new RateLimitedError(err.seconds);
  const code = rpcCode(err);
  if (code && REVOKED_ERRORS.has(code)) return new SessionRevokedError(code);
  return err;
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw translate(err);
  }
}

function loginError(err: unknown): unknown {
  if (err instanceof errors.FloodWaitError) {
    const minutes = Math.ceil(err.seconds / 60);
    return new UserFacingError('TOO_MANY_ATTEMPTS', `Telegram asked us to wait about ${minutes} minute(s) before trying again.`, 429);
  }
  const friendly: Record<string, [string, string]> = {
    PHONE_NUMBER_INVALID: ['PHONE_INVALID', 'That phone number does not look right. Include the country code, like +1 555 123 4567.'],
    PHONE_NUMBER_BANNED: ['PHONE_BANNED', 'Telegram has banned this phone number.'],
    PHONE_NUMBER_FLOOD: ['TOO_MANY_ATTEMPTS', 'Too many codes were requested for this number. Try again later.'],
    PHONE_CODE_INVALID: ['CODE_INVALID', 'That code is not correct.'],
    PHONE_CODE_EMPTY: ['CODE_INVALID', 'Enter the code Telegram sent you.'],
    PHONE_CODE_EXPIRED: ['CODE_EXPIRED', 'That code has expired. Start again to get a new one.'],
    PASSWORD_HASH_INVALID: ['PASSWORD_INVALID', 'That password is not correct.'],
    API_ID_INVALID: ['API_INVALID', 'Telegram rejected TELEGRAM_API_ID or TELEGRAM_API_HASH. Check the values in your .env file.'],
    API_ID_PUBLISHED_FLOOD: ['API_INVALID', 'Telegram rejected this API ID. Create your own at my.telegram.org.'],
  };
  const code = rpcCode(err);
  const match = code ? friendly[code] : undefined;
  return match ? new UserFacingError(match[0], match[1]) : err;
}

interface PendingLogin {
  client: TelegramClient;
  phone: string;
  phoneCodeHash: string;
  timer: NodeJS.Timeout;
}

export class TelegramStorage implements StorageBackend {
  readonly kind = 'telegram' as const;
  private readonly clients = new Map<string, Promise<TelegramClient>>();
  private readonly logins = new Map<string, PendingLogin>();

  constructor(
    private readonly apiId: number,
    private readonly apiHash: string,
    private readonly createClient: ClientFactory = defaultClientFactory,
  ) {}

  // ---- connections ---------------------------------------------------------------------------

  private client(session: string): Promise<TelegramClient> {
    let pending = this.clients.get(session);
    if (!pending) {
      pending = (async () => {
        const client = this.createClient(session, this.apiId, this.apiHash);
        await client.connect();
        return client;
      })();
      pending.catch(() => this.clients.delete(session));
      this.clients.set(session, pending);
    }
    return pending.then(async (client) => {
      if (!client.connected) await client.connect();
      return client;
    });
  }

  private async release(session: string): Promise<void> {
    const pending = this.clients.get(session);
    this.clients.delete(session);
    if (pending) await pending.then((c) => c.destroy()).catch(() => undefined);
  }

  async close(): Promise<void> {
    for (const loginId of [...this.logins.keys()]) await this.dropLogin(loginId);
    await Promise.all([...this.clients.keys()].map((s) => this.release(s)));
  }

  // ---- signing in ----------------------------------------------------------------------------

  private async dropLogin(loginId: string): Promise<void> {
    const login = this.logins.get(loginId);
    if (!login) return;
    this.logins.delete(loginId);
    clearTimeout(login.timer);
    await login.client.destroy().catch(() => undefined);
  }

  private requireLogin(loginId: string): PendingLogin {
    const login = this.logins.get(loginId);
    if (!login) throw new UserFacingError('LOGIN_EXPIRED', 'This sign-in has expired. Start again to get a new code.');
    return login;
  }

  async sendLoginCode(phone: string): Promise<{ loginId: string; delivery: 'app' | 'other' }> {
    const client = this.createClient('', this.apiId, this.apiHash);
    try {
      await client.connect();
      const { phoneCodeHash, isCodeViaApp } = await client.sendCode({ apiId: this.apiId, apiHash: this.apiHash }, phone);
      const loginId = randomUUID();
      const timer = setTimeout(() => void this.dropLogin(loginId), LOGIN_TTL_MS);
      timer.unref();
      this.logins.set(loginId, { client, phone, phoneCodeHash, timer });
      return { loginId, delivery: isCodeViaApp ? 'app' : 'other' };
    } catch (err) {
      await client.destroy().catch(() => undefined);
      throw loginError(err);
    }
  }

  private async finishLogin(loginId: string, login: PendingLogin, user: Api.TypeUser): Promise<LoginSuccess> {
    if (!(user instanceof Api.User)) throw new Error('Telegram returned an empty user');
    const session = (login.client.session as StringSession).save();
    const info: TelegramUser = {
      id: user.id.toString(),
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      username: user.username ?? '',
      phone: user.phone ? `+${user.phone}` : login.phone,
    };
    await this.dropLogin(loginId);
    return { status: 'ok', session, user: info };
  }

  async submitLoginCode(loginId: string, code: string): Promise<CodeResult> {
    const login = this.requireLogin(loginId);
    try {
      const result = await login.client.invoke(
        new Api.auth.SignIn({ phoneNumber: login.phone, phoneCodeHash: login.phoneCodeHash, phoneCode: code }),
      );
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        await this.dropLogin(loginId);
        throw new UserFacingError('NO_ACCOUNT', 'There is no Telegram account for this number. Create one in the Telegram app first.');
      }
      return await this.finishLogin(loginId, login, result.user);
    } catch (err) {
      if (rpcCode(err) === 'SESSION_PASSWORD_NEEDED') {
        const password = await login.client.invoke(new Api.account.GetPassword());
        return { status: 'needs-password', hint: password.hint ?? '' };
      }
      if (rpcCode(err) === 'PHONE_CODE_EXPIRED') await this.dropLogin(loginId);
      throw loginError(err);
    }
  }

  async submitLoginPassword(loginId: string, password: string): Promise<LoginSuccess> {
    const login = this.requireLogin(loginId);
    try {
      const srp = await login.client.invoke(new Api.account.GetPassword());
      const check = await computeCheck(srp, password);
      const result = await login.client.invoke(new Api.auth.CheckPassword({ password: check }));
      if (result instanceof Api.auth.AuthorizationSignUpRequired) throw new Error('Unexpected sign-up request after 2FA');
      return await this.finishLogin(loginId, login, result.user);
    } catch (err) {
      throw loginError(err);
    }
  }

  async revokeSession(session: string): Promise<void> {
    const client = await this.client(session);
    try {
      await client.invoke(new Api.auth.LogOut());
    } finally {
      await this.release(session);
    }
  }

  // ---- the library channel -------------------------------------------------------------------

  private peer(ref: LibraryRef): Api.InputPeerChannel {
    return new Api.InputPeerChannel({ channelId: bigInt(ref.channelId), accessHash: bigInt(ref.accessHash) });
  }

  private inputChannel(ref: LibraryRef): Api.InputChannel {
    return new Api.InputChannel({ channelId: bigInt(ref.channelId), accessHash: bigInt(ref.accessHash) });
  }

  /**
   * A private channel rather than Saved Messages: it keeps the library out of the way, cannot be
   * cleared by accident while tidying up personal notes, and holds nothing but photos.
   */
  async ensureLibrary(session: string): Promise<EnsureLibraryResult> {
    return guard(async () => {
      const client = await this.client(session);

      // Found by marker so a reinstall reconnects to the old library rather than starting another.
      for await (const dialog of client.iterDialogs({ limit: DIALOG_SCAN_LIMIT })) {
        const entity = dialog.entity;
        if (!(entity instanceof Api.Channel) || !entity.creator || entity.title !== LIBRARY_TITLE || !entity.accessHash) continue;
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
        if (full.fullChat.about.includes(LIBRARY_MARKER)) {
          return { library: { channelId: entity.id.toString(), accessHash: entity.accessHash.toString() }, existing: true };
        }
      }

      const created = await client.invoke(
        new Api.channels.CreateChannel({ title: LIBRARY_TITLE, about: LIBRARY_ABOUT, broadcast: true }),
      );
      const channel = 'chats' in created ? created.chats.find((c) => c instanceof Api.Channel) : undefined;
      if (!(channel instanceof Api.Channel) || !channel.accessHash) throw new Error('Telegram did not return the new channel');
      return { library: { channelId: channel.id.toString(), accessHash: channel.accessHash.toString() }, existing: false };
    });
  }

  // ---- storing -------------------------------------------------------------------------------

  /**
   * Sends one file as one message, as a document, and confirms what Telegram kept.
   *
   * This deliberately does not use `client.sendFile`. For .jpg, .jpeg and .png files that method
   * computes `forceFile: forceDocument && !isImage`, so it clears force_file on exactly the files
   * we care about even when asked to send a document. Building the request ourselves is the only
   * way to be sure the flag is set.
   */
  async putPhoto(ctx: StorageContext, input: PutPhotoInput, onProgress: (fraction: number) => void): Promise<{ messageId: number }> {
    return guard(async () => {
      const client = await this.client(ctx.session);
      const peer = this.peer(ctx.library);

      // A CustomFile with a path is read from disk one part at a time, so a 2 GB file stays out of memory.
      const file = await client.uploadFile({
        file: new CustomFile(input.filename, input.size, input.path),
        workers: UPLOAD_WORKERS,
        onProgress,
      });

      const randomId = readBigIntFromBuffer(randomBytes(8), true, true);
      const result = await client.invoke(
        new Api.messages.SendMedia({
          peer,
          media: new Api.InputMediaUploadedDocument({
            file,
            forceFile: true,
            mimeType: input.mime,
            attributes: [new Api.DocumentAttributeFilename({ fileName: input.filename })],
          }),
          message: input.caption,
          randomId,
          silent: true,
        }),
      );

      const message = await this.sentMessage(client, peer, result, randomId);
      const media = message.media;
      const intact =
        media instanceof Api.MessageMediaDocument &&
        media.document instanceof Api.Document &&
        media.document.size.toString() === String(input.size);
      if (!intact) {
        // Never accept a copy that differs from what we sent. The original is still on disk, so this retries safely.
        await client
          .invoke(new Api.channels.DeleteMessages({ channel: this.inputChannel(ctx.library), id: [message.id] }))
          .catch(() => undefined);
        throw new Error('Telegram did not store this file as an unmodified document');
      }
      return { messageId: message.id };
    });
  }

  private async sentMessage(
    client: TelegramClient,
    peer: Api.InputPeerChannel,
    result: Api.TypeUpdates,
    randomId: bigInt.BigInteger,
  ): Promise<Api.Message> {
    const updates = result instanceof Api.Updates || result instanceof Api.UpdatesCombined ? result.updates : [];
    const idUpdate = updates.find((u) => u instanceof Api.UpdateMessageID && u.randomId?.equals(randomId));
    const messageId = idUpdate instanceof Api.UpdateMessageID ? idUpdate.id : undefined;

    for (const update of updates) {
      if (
        update instanceof Api.UpdateNewChannelMessage &&
        update.message instanceof Api.Message &&
        (messageId === undefined || update.message.id === messageId)
      ) {
        return update.message;
      }
    }
    if (messageId !== undefined) {
      const [fetched] = await client.getMessages(peer, { ids: [messageId] });
      if (fetched instanceof Api.Message) return fetched;
    }
    throw new Error('Telegram did not confirm the sent message');
  }

  // ---- reading -------------------------------------------------------------------------------

  private async readableMessage(client: TelegramClient, ctx: StorageContext, messageId: number) {
    // Always fetched fresh: file references expire, so a stored one cannot be relied on.
    const [message] = await client.getMessages(this.peer(ctx.library), { ids: [messageId] });
    if (
      !(message instanceof Api.Message) ||
      !(message.media instanceof Api.MessageMediaDocument) ||
      !(message.media.document instanceof Api.Document)
    ) {
      throw new OriginalMissingError();
    }
    return { media: message.media, document: message.media.document };
  }

  async getPhoto(ctx: StorageContext, messageId: number): Promise<{ size: number; stream: AsyncIterable<Uint8Array> }> {
    return guard(async () => {
      const client = await this.client(ctx.session);
      const { media, document } = await this.readableMessage(client, ctx, messageId);
      // `iterDownload` must receive the media object. Passing the Message itself throws.
      const stream = client.iterDownload({ file: media, requestSize: DOWNLOAD_REQUEST_BYTES });
      return { size: document.size.toJSNumber(), stream: stream as AsyncIterable<Uint8Array> };
    });
  }

  async deletePhotos(ctx: StorageContext, messageIds: number[]): Promise<void> {
    await guard(async () => {
      const client = await this.client(ctx.session);
      const channel = this.inputChannel(ctx.library);
      for (let i = 0; i < messageIds.length; i += DELETE_BATCH) {
        await client.invoke(new Api.channels.DeleteMessages({ channel, id: messageIds.slice(i, i + DELETE_BATCH) }));
      }
    });
  }

  async *scanLibrary(ctx: StorageContext): AsyncIterable<ScannedPhoto> {
    const client = await guard(() => this.client(ctx.session));
    try {
      for await (const message of client.iterMessages(this.peer(ctx.library), { reverse: true })) {
        const media = message.media;
        if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) continue;
        const nameAttr = media.document.attributes.find((a) => a instanceof Api.DocumentAttributeFilename);
        yield {
          messageId: message.id,
          filename: nameAttr instanceof Api.DocumentAttributeFilename ? nameAttr.fileName : `photo-${message.id}`,
          size: media.document.size.toJSNumber(),
          mime: media.document.mimeType,
          caption: message.message ?? '',
          date: message.date,
        };
      }
    } catch (err) {
      throw translate(err);
    }
  }
}
