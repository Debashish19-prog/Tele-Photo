import type { FastifyInstance, FastifyReply } from 'fastify';
import { normalizePhone } from '../config.js';
import type { AppContext } from '../app.js';
import { hashToken, newToken } from '../secrets.js';
import { type LoginSuccess, UserFacingError } from '../storage/types.js';
import { requireAccount, SESSION_COOKIE, SESSION_TTL_MS } from './http.js';

const AUTH_RATE_LIMIT = { rateLimit: { max: 10, timeWindow: '1 minute' } };

function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  if (typeof value !== 'string' || !value.trim()) throw new UserFacingError('BAD_REQUEST', `Missing ${name}.`);
  return value;
}

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, storage, sealer, config, queue, library } = ctx;

  const canSignIn = config.storage === 'fake' || (config.telegramApiId !== null && config.telegramApiHash !== null);

  function assertConfigured(): void {
    if (!canSignIn) {
      throw new UserFacingError('NOT_CONFIGURED', 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH to your .env file, then restart the server.', 503);
    }
  }

  async function completeLogin(success: LoginSuccess, reply: FastifyReply) {
    const previous = repo.getAccountByTelegramId(success.user.id);
    const previousSession = previous?.session_sealed ? sealer.open(previous.session_sealed) : null;

    const account = repo.upsertAccount({
      tgUserId: success.user.id,
      phone: success.user.phone,
      firstName: success.user.firstName,
      lastName: success.user.lastName,
      username: success.user.username,
      sessionSealed: sealer.seal(success.session),
    });

    let foundExistingLibrary = false;
    if (!account.channel_id) {
      const { library: ref, existing } = await storage.ensureLibrary(success.session);
      repo.setLibrary(account.id, ref.channelId, ref.accessHash);
      foundExistingLibrary = existing;
    }

    // One live Telegram session per account. Signing in again replaces the old one.
    if (previousSession && previousSession !== success.session) {
      void storage.revokeSession(previousSession).catch(() => undefined);
    }

    const token = newToken();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    repo.createBrowserSession(hashToken(token), account.id, expiresAt);
    repo.deleteExpiredBrowserSessions(Date.now());
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/', expires: new Date(expiresAt),
    });

    // A library with no local index means a fresh install on top of an old library: bring it back.
    if (foundExistingLibrary && repo.libraryStats(account.id).count === 0) library.startScan(account.id);
    queue.notify();
    return { status: 'ok' as const };
  }

  app.get('/api/session', async (req) => ({
    storage: storage.kind,
    configured: canSignIn,
    account: req.account
      ? {
          id: req.account.id,
          firstName: req.account.first_name,
          lastName: req.account.last_name,
          username: req.account.username,
          phone: req.account.phone,
          needsReauth: req.account.needs_reauth === 1,
        }
      : null,
  }));

  app.post('/api/auth/phone', { config: AUTH_RATE_LIMIT }, async (req) => {
    assertConfigured();
    const phone = normalizePhone(field(req.body, 'phone'));
    if (!/^\+[0-9]{6,16}$/.test(phone)) {
      throw new UserFacingError('PHONE_INVALID', 'Include the country code, like +1 555 123 4567.');
    }
    if (config.allowedPhones && !config.allowedPhones.has(phone)) {
      throw new UserFacingError('PHONE_NOT_ALLOWED', 'This number is not allowed to sign in to this server.', 403);
    }
    return storage.sendLoginCode(phone);
  });

  app.post('/api/auth/code', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const result = await storage.submitLoginCode(field(req.body, 'loginId'), field(req.body, 'code').trim());
    if (result.status === 'needs-password') return { status: 'password' as const, hint: result.hint };
    return completeLogin(result, reply);
  });

  app.post('/api/auth/password', { config: AUTH_RATE_LIMIT }, async (req, reply) => {
    const result = await storage.submitLoginPassword(field(req.body, 'loginId'), field(req.body, 'password'));
    return completeLogin(result, reply);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) repo.deleteBrowserSession(hashToken(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Ends the Telegram session itself, leaving this server with no access to the account. */
  app.post('/api/auth/disconnect', async (req, reply) => {
    const account = requireAccount(req);
    if (account.session_sealed) {
      await storage.revokeSession(sealer.open(account.session_sealed)).catch(() => undefined);
    }
    repo.clearSession(account.id);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
