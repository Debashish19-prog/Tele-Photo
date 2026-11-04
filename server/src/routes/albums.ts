import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { UserFacingError } from '../storage/types.js';
import { parseId, parseIds, requireAccount } from './http.js';

function albumTitle(raw: unknown): string {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (!title) throw new UserFacingError('BAD_REQUEST', 'Give the album a name.');
  return title.slice(0, 200);
}

export function albumRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { repo } = ctx;

  function ownedAlbum(accountId: number, raw: unknown) {
    const album = repo.getAlbum(accountId, parseId(raw));
    if (!album) throw new UserFacingError('NOT_FOUND', 'Album not found.', 404);
    return album;
  }

  const shape = (a: ReturnType<typeof repo.listAlbums>[number]) => ({
    id: a.id,
    title: a.title,
    photoCount: a.photo_count,
    coverId: a.cover_id,
    updatedAt: a.updated_at,
  });

  app.get('/api/albums', async (req) => {
    const account = requireAccount(req);
    return { albums: repo.listAlbums(account.id).map(shape) };
  });

  app.post('/api/albums', async (req, reply) => {
    const account = requireAccount(req);
    const body = (req.body ?? {}) as { title?: unknown; photoIds?: unknown };
    const id = repo.createAlbum(account.id, albumTitle(body.title));
    if (Array.isArray(body.photoIds) && body.photoIds.length > 0) repo.addToAlbum(account.id, id, parseIds(body.photoIds));
    reply.code(201);
    return { id };
  });

  app.get('/api/albums/:id', async (req) => {
    const account = requireAccount(req);
    const album = ownedAlbum(account.id, (req.params as { id: string }).id);
    const listed = repo.listAlbums(account.id).find((a) => a.id === album.id)!;
    return shape(listed);
  });

  app.patch('/api/albums/:id', async (req) => {
    const account = requireAccount(req);
    const album = ownedAlbum(account.id, (req.params as { id: string }).id);
    const body = (req.body ?? {}) as { title?: unknown; coverPhotoId?: unknown };
    if (body.title !== undefined) repo.updateAlbum(account.id, album.id, { title: albumTitle(body.title) });
    if (body.coverPhotoId !== undefined) {
      const coverPhotoId = body.coverPhotoId === null ? null : parseId(body.coverPhotoId);
      if (coverPhotoId !== null && !repo.getPhoto(account.id, coverPhotoId)) throw new UserFacingError('NOT_FOUND', 'Photo not found.', 404);
      repo.updateAlbum(account.id, album.id, { coverPhotoId });
    }
    return { ok: true };
  });

  /** Removes the album only. The photos in it stay in the library. */
  app.delete('/api/albums/:id', async (req) => {
    const account = requireAccount(req);
    const album = ownedAlbum(account.id, (req.params as { id: string }).id);
    repo.deleteAlbum(account.id, album.id);
    return { ok: true };
  });

  app.post('/api/albums/:id/photos', async (req) => {
    const account = requireAccount(req);
    const album = ownedAlbum(account.id, (req.params as { id: string }).id);
    repo.addToAlbum(account.id, album.id, parseIds((req.body as { ids?: unknown } | null)?.ids));
    return { ok: true };
  });

  app.post('/api/albums/:id/photos/remove', async (req) => {
    const account = requireAccount(req);
    const album = ownedAlbum(account.id, (req.params as { id: string }).id);
    repo.removeFromAlbum(album.id, parseIds((req.body as { ids?: unknown } | null)?.ids));
    return { ok: true };
  });
}
