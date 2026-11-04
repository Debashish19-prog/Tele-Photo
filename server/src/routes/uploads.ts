import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppContext } from '../app.js';
import { MAX_PHOTO_BYTES } from '../config.js';
import { generatePreviews, readPhotoMetadata, sniffImage } from '../media.js';
import { mediaLimiter } from '../queue.js';
import { UserFacingError } from '../storage/types.js';
import { cleanFilename, parseId, requireAccount } from './http.js';

/** Room for the multipart boundaries and headers around the file. */
const MULTIPART_OVERHEAD = 64 * 1024;

function tooLarge(): UserFacingError {
  return new UserFacingError('TOO_LARGE', 'This file is larger than the 1.95 GB Telegram accepts in a single upload.', 413);
}

function nowAsWallClock(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 19);
}

export function uploadRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo, paths, queue, library } = ctx;

  app.post('/api/uploads', async (req, reply) => {
    const account = requireAccount(req);

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_PHOTO_BYTES + MULTIPART_OVERHEAD) throw tooLarge();

    const part = await req.file({ limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
    if (!part) throw new UserFacingError('BAD_REQUEST', 'No file was received.');

    const tmp = join(paths.tmpDir, randomUUID());
    let keepTmp = false;
    try {
      const hash = createHash('sha256');
      let size = 0;
      await pipeline(
        part.file,
        new Transform({
          transform(chunk: Buffer, _encoding, done) {
            hash.update(chunk);
            size += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(tmp, { mode: 0o600 }),
      );
      if (part.file.truncated) throw tooLarge();
      if (size === 0) throw new UserFacingError('EMPTY_FILE', 'This file is empty.');

      const type = await sniffImage(tmp);
      if (!type) throw new UserFacingError('NOT_A_PHOTO', 'Only photos can be stored right now, and this file is not a recognised image format.', 415);

      const sha256 = hash.digest('hex');
      const duplicate = repo.getPhotoBySha(account.id, sha256);
      if (duplicate) {
        // Uploading something that is in the Trash means the person wants it back.
        const restored = duplicate.trashed_at !== null;
        if (restored) repo.setTrashed(account.id, [duplicate.id], null);
        return { id: duplicate.id, duplicate: true, restored };
      }

      const query = req.query as { lastModified?: string };
      const fileDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(query.lastModified ?? '') ? query.lastModified! : null;

      const thumb = paths.thumb(account.id, sha256);
      const preview = paths.preview(account.id, sha256);
      paths.ensureParent(thumb);
      const [meta, shown] = await Promise.all([
        readPhotoMetadata(tmp),
        mediaLimiter(() => generatePreviews(tmp, type.mime, thumb, preview)),
      ]);

      // Moved into place before the row exists, so the queue never sees a job without its file.
      const incoming = paths.incoming(account.id, sha256);
      await rename(tmp, incoming);
      keepTmp = true;

      let id: number;
      try {
        id = repo.insertPhoto({
          account_id: account.id,
          sha256,
          filename: cleanFilename(part.filename),
          mime: type.mime,
          size,
          width: shown?.width ?? meta.exifWidth,
          height: shown?.height ?? meta.exifHeight,
          taken_at: meta.takenAt ?? fileDate ?? nowAsWallClock(),
          taken_source: meta.takenAt ? 'exif' : fileDate ? 'file' : 'upload',
          camera_make: meta.cameraMake,
          camera_model: meta.cameraModel,
          lens: meta.lens,
          iso: meta.iso,
          f_number: meta.fNumber,
          exposure_time: meta.exposureTime,
          focal_length: meta.focalLength,
          gps_lat: meta.gpsLat,
          gps_lon: meta.gpsLon,
          status: 'queued',
          tg_message_id: null,
          preview_state: shown ? 'ready' : 'unavailable',
        });
      } catch (err) {
        // The same bytes arrived twice at once. Both requests share one file name, which the
        // winning row needs, so only the row is given up here.
        const winner = repo.getPhotoBySha(account.id, sha256);
        if (winner) return { id: winner.id, duplicate: true, restored: false };
        throw err;
      }
      queue.notify();
      reply.code(201);
      return { id, duplicate: false, restored: false };
    } finally {
      if (!keepTmp) await rm(tmp, { force: true });
    }
  });

  app.get('/api/uploads/status', async (req) => {
    const account = requireAccount(req);
    const items = repo.uploadActivity(account.id).map((p) => ({
      id: p.id,
      filename: p.filename,
      size: p.size,
      status: p.status,
      progress: queue.progress.get(p.id) ?? (p.status === 'uploading' ? 0 : null),
      error: p.last_error,
      nextAttemptAt: p.next_attempt_at > Date.now() ? p.next_attempt_at : null,
    }));
    return { items, stats: repo.libraryStats(account.id), scan: library.scanState(account.id) };
  });

  app.post('/api/uploads/retry', async (req) => {
    const account = requireAccount(req);
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    const changed = repo.retryFailed(account.id, Array.isArray(ids) ? ids.map(parseId) : null);
    queue.notify();
    return { retried: changed };
  });

  /** Gives up on a photo that has not reached Telegram. */
  app.delete('/api/uploads/:id', async (req) => {
    const account = requireAccount(req);
    const photo = repo.getPhoto(account.id, parseId((req.params as { id: string }).id));
    if (!photo) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);
    if (photo.status === 'stored') throw new UserFacingError('ALREADY_STORED', 'This photo is already stored. Move it to Trash instead.', 409);
    if (photo.status === 'uploading') throw new UserFacingError('BUSY', 'This photo is being sent right now.', 409);
    await library.deletePermanently(account.id, [photo]);
    return { ok: true };
  });
}
