import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_PHOTO_BYTES, type Config } from './config.js';
import { Repo } from './db.js';
import { Library } from './library.js';
import { Paths } from './paths.js';
import { UploadQueue } from './queue.js';
import { albumRoutes } from './routes/albums.js';
import { authRoutes } from './routes/auth.js';
import { SESSION_COOKIE } from './routes/http.js';
import { photoRoutes } from './routes/photos.js';
import { uploadRoutes } from './routes/uploads.js';
import { hashToken, Sealer } from './secrets.js';
import { FakeStorage } from './storage/fake.js';
import { TelegramStorage } from './storage/telegram.js';
import { RateLimitedError, SessionRevokedError, type StorageBackend, UserFacingError } from './storage/types.js';

export interface AppContext {
  config: Config;
  storage: StorageBackend;
  repo: Repo;
  paths: Paths;
  sealer: Sealer;
  queue: UploadQueue;
  library: Library;
}

export function createStorage(config: Config): StorageBackend {
  if (config.storage === 'fake') return new FakeStorage(config.dataDir);
  // With no API keys yet the app still starts, so the sign-in page can explain what to do.
  return new TelegramStorage(config.telegramApiId ?? 0, config.telegramApiHash ?? '');
}

export async function buildApp(
  config: Config,
  storage: StorageBackend = createStorage(config),
  options: { logger?: boolean } = {},
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const paths = new Paths(config.dataDir);
  const repo = new Repo(config.dataDir);
  const sealer = new Sealer(config.dataDir);
  const queue = new UploadQueue(repo, storage, sealer, paths);
  const library = new Library(repo, storage, sealer, paths, queue, config.trashRetentionDays);
  const ctx: AppContext = { config, storage, repo, paths, sealer, queue, library };

  const app = Fastify({
    // Startup, warnings and errors only. A grid would otherwise log two lines per thumbnail.
    logger: options.logger ? { level: 'info' } : false,
    logController: new LogController({ disableRequestLogging: true }),
    // Uploads run as long as they need. They are only limited by size.
    requestTimeout: 0,
    // Otherwise a request finishing during shutdown holds the process open until keep-alive expires.
    forceCloseConnections: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 5 } });

  app.decorateRequest('account', null);
  app.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.account = repo.accountForToken(hashToken(token), Date.now()) ?? null;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof UserFacingError) {
      // The body of a refused upload may still be arriving. Closing stops the client sending it all.
      if (err.statusCode === 413) reply.header('Connection', 'close');
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof SessionRevokedError) {
      if (req.account) repo.setNeedsReauth(req.account.id);
      return reply.code(401).send({ error: { code: 'REAUTH', message: 'Telegram ended this session. Please sign in again.' } });
    }
    if (err instanceof RateLimitedError) {
      return reply
        .code(503)
        .header('Retry-After', String(err.seconds))
        .send({ error: { code: 'RATE_LIMITED', message: `Telegram asked us to wait ${err.seconds} seconds. Try again shortly.` } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    req.log.error(err);
    if (reply.raw.headersSent) return reply.raw.destroy();
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong on the server.' } });
  });

  authRoutes(app, ctx);
  uploadRoutes(app, ctx);
  photoRoutes(app, ctx);
  albumRoutes(app, ctx);

  // Serves the built web app, when there is one, with any non-API path falling back to it.
  if (existsSync(join(config.webDist, 'index.html'))) {
    // The default wildcard route looks files up on each request, so a rebuild works without a restart.
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } }));
  }

  app.addHook('onClose', async () => {
    queue.stop();
    library.stop();
    await queue.settle(2000);
    await storage.close();
    await queue.settle(2000);
    repo.close();
  });

  return { app, ctx };
}

