import type { FastifyRequest } from 'fastify';
import type { AccountRow, PhotoRow } from '../db.js';
import { UserFacingError } from '../storage/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: AccountRow | null;
  }
}

export const SESSION_COOKIE = 'tp_session';
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function requireAccount(req: FastifyRequest): AccountRow {
  if (!req.account) throw new UserFacingError('NOT_SIGNED_IN', 'Please sign in.', 401);
  return req.account;
}

export function parseId(raw: unknown): number {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new UserFacingError('NOT_FOUND', 'Not found.', 404);
  return id;
}

export function parseIds(raw: unknown, max = 10_000): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    throw new UserFacingError('BAD_REQUEST', 'Expected a list of photo ids.');
  }
  return [...new Set(raw.map(parseId))];
}

/** Strips anything that could change meaning in a path or a header, and keeps the name readable. */
export function cleanFilename(raw: string | undefined): string {
  const base = (raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'photo';
}

export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The compact form of a photo in a grid: [id, width, height, takenAt, flags, filename]. */
export const FLAG_FAVORITE = 1;
export const FLAG_PENDING = 2;
export const FLAG_FAILED = 4;
export const FLAG_NO_PREVIEW = 8;
export const FLAG_PREVIEW_COMING = 16;

export function gridItem(p: PhotoRow): [number, number, number, string, number, string] {
  let flags = 0;
  if (p.favorite) flags |= FLAG_FAVORITE;
  if (p.status === 'queued' || p.status === 'uploading') flags |= FLAG_PENDING;
  if (p.status === 'failed') flags |= FLAG_FAILED;
  if (p.preview_state === 'unavailable') flags |= FLAG_NO_PREVIEW;
  if (p.preview_state === 'missing') flags |= FLAG_PREVIEW_COMING;
  return [p.id, p.width ?? 4, p.height ?? 3, p.taken_at, flags, p.filename];
}

export function photoDetail(p: PhotoRow, retentionDays: number) {
  return {
    id: p.id,
    filename: p.filename,
    mime: p.mime,
    size: p.size,
    width: p.width,
    height: p.height,
    takenAt: p.taken_at,
    takenSource: p.taken_source,
    uploadedAt: p.uploaded_at,
    sha256: p.sha256,
    camera: { make: p.camera_make, model: p.camera_model, lens: p.lens, iso: p.iso, fNumber: p.f_number, exposureTime: p.exposure_time, focalLength: p.focal_length },
    location: p.gps_lat !== null && p.gps_lon !== null ? { lat: p.gps_lat, lon: p.gps_lon } : null,
    status: p.status,
    error: p.last_error,
    telegramMessageId: p.tg_message_id,
    previewState: p.preview_state,
    favorite: p.favorite === 1,
    trashedAt: p.trashed_at,
    purgeAt: p.trashed_at ? p.trashed_at + retentionDays * 24 * 60 * 60 * 1000 : null,
  };
}
