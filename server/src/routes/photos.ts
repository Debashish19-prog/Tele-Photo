import { ZipArchive } from 'archiver';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { AppContext } from '../app.js';
import type { PhotoRow, PhotoView } from '../db.js';
import { contextFor } from '../queue.js';
import { UserFacingError } from '../storage/types.js';
import { contentDisposition, gridItem, parseId, parseIds, photoDetail, requireAccount } from './http.js';

/** Types a browser can show directly. Everything else downloads instead of opening. */
const INLINE_SAFE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const MAX_ZIP_PHOTOS = 2000;
const CACHE_FOREVER = 'private, max-age=31536000, immutable';

export function photoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, paths, storage, sealer, library, config } = ctx;

  function owned(accountId: number, rawId: unknown): PhotoRow {
    const photo = repo.getPhoto(accountId, parseId(rawId));
    if (!photo) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);
    return photo;
  }

  /** Comes from local disk until Telegram has it, and from Telegram from then on. */
  async function openOriginal(accountId: number, photo: PhotoRow): Promise<Readable> {
    if (photo.status !== 'stored' || photo.tg_message_id === null) {
      return createReadStream(paths.incoming(accountId, photo.sha256));
    }
    const account = repo.getAccount(accountId)!;
    const { stream } = await storage.getPhoto(contextFor(account, sealer), photo.tg_message_id);
    return Readable.from(stream, { objectMode: false });
  }

  app.get('/api/photos', async (req) => {
    const account = requireAccount(req);
    const q = req.query as { view?: string; album?: string; q?: string };
    let view: PhotoView = { kind: 'timeline' };
    if (q.view === 'favorites') view = { kind: 'favorites' };
    if (q.view === 'trash') view = { kind: 'trash' };
    if (q.album) {
      const albumId = parseId(q.album);
      if (!repo.getAlbum(account.id, albumId)) throw new UserFacingError('NOT_FOUND', 'Album not found.', 404);
      view = { kind: 'album', albumId };
    }
    return { items: repo.listPhotos(account.id, view, q.q ?? '').map(gridItem) };
  });

  // Registered before the /:id routes, so "zip" is never read as an id.
  app.get('/api/photos/zip', async (req, reply) => {
    const account = requireAccount(req);
    const raw = (req.query as { ids?: string }).ids ?? '';
    const ids = parseIds(raw.split(',').filter(Boolean), MAX_ZIP_PHOTOS);
    const photos = repo.getPhotos(account.id, ids);
    if (photos.length === 0) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);

    // Photos are already compressed, so "store" costs nothing and keeps this fast.
    const archive = new ZipArchive({ store: true, forceZip64: true });
    const used = new Set<string>();
    const uniqueName = (filename: string) => {
      const dot = filename.lastIndexOf('.');
      const [base, ext] = dot > 0 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, ''];
      let name = filename;
      for (let n = 1; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
      used.add(name.toLowerCase());
      return name;
    };

    let aborted = false;
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) {
        aborted = true;
        archive.abort();
      }
    });

    void (async () => {
      try {
        for (const photo of photos) {
          if (aborted) return;
          const source = await openOriginal(account.id, photo);
          await new Promise<void>((resolve, reject) => {
            source.once('error', reject);
            archive.once('entry', () => resolve());
            archive.append(source, { name: uniqueName(photo.filename) });
          });
        }
        await archive.finalize();
      } catch (err) {
        // Destroying the stream makes the download fail visibly, rather than end in a short archive.
        archive.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition('attachment', `Tele-Photo-${photos.length}-photos.zip`));
    return reply.send(archive);
  });

  app.get('/api/photos/:id', async (req) => {
    const account = requireAccount(req);
    const photo = owned(account.id, (req.params as { id: string }).id);
    const albums = repo.db
      .prepare<[number], { id: number; title: string }>(
        'SELECT a.id, a.title FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE ap.photo_id = ?',
      )
      .all(photo.id);
    return { ...photoDetail(photo, config.trashRetentionDays), albums };
  });

  function sendPreviewFile(kind: 'thumb' | 'preview') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const account = requireAccount(req);
      const photo = owned(account.id, (req.params as { id: string }).id);
      const path = paths[kind](account.id, photo.sha256);
      const info = await stat(path).catch(() => null);
      if (!info) throw new UserFacingError('NO_PREVIEW', 'No preview is available.', 404);
      return reply
        .header('Content-Type', 'image/webp')
        .header('Content-Length', info.size)
        .header('Cache-Control', CACHE_FOREVER)
        .send(createReadStream(path));
    };
  }
  app.get('/api/photos/:id/thumb', sendPreviewFile('thumb'));
  app.get('/api/photos/:id/preview', sendPreviewFile('preview'));

  app.get('/api/photos/:id/original', async (req, reply) => {
    const account = requireAccount(req);
    const photo = owned(account.id, (req.params as { id: string }).id);
    const asDownload = (req.query as { download?: string }).download !== undefined || !INLINE_SAFE.has(photo.mime);
    const source = await openOriginal(account.id, photo);
    return reply
      .header('Content-Type', photo.mime)
      .header('Content-Length', photo.size)
      .header('Content-Disposition', contentDisposition(asDownload ? 'attachment' : 'inline', photo.filename))
      .header('Cache-Control', CACHE_FOREVER)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(source);
  });

  app.patch('/api/photos', async (req) => {
    const account = requireAccount(req);
    const body = (req.body ?? {}) as { ids?: unknown; favorite?: unknown; trashed?: unknown };
    const ids = parseIds(body.ids);
    if (typeof body.favorite === 'boolean') repo.setFavorite(account.id, ids, body.favorite);
    if (typeof body.trashed === 'boolean') repo.setTrashed(account.id, ids, body.trashed ? Date.now() : null);
    return { ok: true };
  });

  /** Permanent. Only accepts photos already in the Trash, so nothing is one click from gone. */
  app.post('/api/photos/delete-permanently', async (req) => {
    const account = requireAccount(req);
    const ids = parseIds((req.body as { ids?: unknown } | null)?.ids);
    const photos = repo.getPhotos(account.id, ids).filter((p) => p.trashed_at !== null);
    return library.deletePermanently(account.id, photos);
  });

  app.post('/api/trash/empty', async (req) => {
    const account = requireAccount(req);
    const photos = repo.getPhotos(account.id, repo.trashedIds(account.id));
    return library.deletePermanently(account.id, photos);
  });

  app.get('/api/library', async (req) => {
    const account = requireAccount(req);
    return {
      stats: repo.libraryStats(account.id),
      scan: library.scanState(account.id),
      trashRetentionDays: config.trashRetentionDays,
    };
  });

  app.post('/api/library/rescan', async (req) => {
    const account = requireAccount(req);
    return library.startScan(account.id);
  });
}
