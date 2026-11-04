import Database from 'better-sqlite3';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

export type PhotoStatus = 'queued' | 'uploading' | 'stored' | 'failed';
export type PreviewState = 'ready' | 'missing' | 'unavailable';

export interface AccountRow {
  id: number;
  tg_user_id: string;
  phone: string;
  first_name: string;
  last_name: string;
  username: string;
  session_sealed: string | null;
  channel_id: string | null;
  channel_access_hash: string | null;
  needs_reauth: 0 | 1;
  created_at: number;
}

export interface PhotoRow {
  id: number;
  account_id: number;
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Wall-clock time where the photo was taken, with no zone: 2024-07-01T18:22:10. */
  taken_at: string;
  taken_source: 'exif' | 'file' | 'upload' | 'telegram';
  uploaded_at: number;
  camera_make: string | null;
  camera_model: string | null;
  lens: string | null;
  iso: number | null;
  f_number: number | null;
  exposure_time: number | null;
  focal_length: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  status: PhotoStatus;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  tg_message_id: number | null;
  preview_state: PreviewState;
  preview_attempts: number;
  favorite: 0 | 1;
  trashed_at: number | null;
}

export interface AlbumRow {
  id: number;
  account_id: number;
  title: string;
  cover_photo_id: number | null;
  created_at: number;
  updated_at: number;
}

export type NewPhoto = Pick<
  PhotoRow,
  | 'account_id' | 'sha256' | 'filename' | 'mime' | 'size' | 'width' | 'height' | 'taken_at' | 'taken_source'
  | 'camera_make' | 'camera_model' | 'lens' | 'iso' | 'f_number' | 'exposure_time' | 'focal_length'
  | 'gps_lat' | 'gps_lon' | 'status' | 'tg_message_id' | 'preview_state'
>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  tg_user_id TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  session_sealed TEXT,
  channel_id TEXT,
  channel_access_hash TEXT,
  needs_reauth INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  -- AUTOINCREMENT: thumbnails are cached forever by id, so an id must never come back for another photo.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  taken_at TEXT NOT NULL,
  taken_source TEXT NOT NULL,
  uploaded_at INTEGER NOT NULL,
  camera_make TEXT,
  camera_model TEXT,
  lens TEXT,
  iso REAL,
  f_number REAL,
  exposure_time REAL,
  focal_length REAL,
  gps_lat REAL,
  gps_lon REAL,
  status TEXT NOT NULL CHECK (status IN ('queued','uploading','stored','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  tg_message_id INTEGER,
  preview_state TEXT NOT NULL DEFAULT 'ready' CHECK (preview_state IN ('ready','missing','unavailable')),
  preview_attempts INTEGER NOT NULL DEFAULT 0,
  favorite INTEGER NOT NULL DEFAULT 0,
  trashed_at INTEGER,
  UNIQUE (account_id, sha256)
);
CREATE INDEX IF NOT EXISTS photos_timeline ON photos (account_id, trashed_at, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS photos_jobs ON photos (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS photos_previews ON photos (preview_state);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX IF NOT EXISTS album_photos_by_photo ON album_photos (photo_id);
`;

const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type PhotoView =
  | { kind: 'timeline' }
  | { kind: 'favorites' }
  | { kind: 'trash' }
  | { kind: 'album'; albumId: number };

export class Repo {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    const path = join(dataDir, 'tele-photo.db');
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- accounts ------------------------------------------------------------------------------

  getAccount(id: number): AccountRow | undefined {
    return this.db.prepare<[number], AccountRow>('SELECT * FROM accounts WHERE id = ?').get(id);
  }

  getAccountByTelegramId(tgUserId: string): AccountRow | undefined {
    return this.db.prepare<[string], AccountRow>('SELECT * FROM accounts WHERE tg_user_id = ?').get(tgUserId);
  }

  upsertAccount(a: {
    tgUserId: string; phone: string; firstName: string; lastName: string; username: string; sessionSealed: string;
  }): AccountRow {
    this.db
      .prepare(
        `INSERT INTO accounts (tg_user_id, phone, first_name, last_name, username, session_sealed, needs_reauth, created_at)
         VALUES (@tgUserId, @phone, @firstName, @lastName, @username, @sessionSealed, 0, @now)
         ON CONFLICT (tg_user_id) DO UPDATE SET
           phone = excluded.phone, first_name = excluded.first_name, last_name = excluded.last_name,
           username = excluded.username, session_sealed = excluded.session_sealed, needs_reauth = 0`,
      )
      .run({ ...a, now: Date.now() });
    return this.getAccountByTelegramId(a.tgUserId)!;
  }

  setLibrary(accountId: number, channelId: string, accessHash: string): void {
    this.db
      .prepare('UPDATE accounts SET channel_id = ?, channel_access_hash = ? WHERE id = ?')
      .run(channelId, accessHash, accountId);
  }

  setNeedsReauth(accountId: number): void {
    this.db.prepare('UPDATE accounts SET needs_reauth = 1 WHERE id = ?').run(accountId);
  }

  clearSession(accountId: number): void {
    this.db.prepare('UPDATE accounts SET session_sealed = NULL, needs_reauth = 1 WHERE id = ?').run(accountId);
    this.db.prepare('DELETE FROM browser_sessions WHERE account_id = ?').run(accountId);
  }

  // ---- browser sessions ----------------------------------------------------------------------

  createBrowserSession(tokenHash: string, accountId: number, expiresAt: number): void {
    this.db
      .prepare('INSERT INTO browser_sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
      .run(tokenHash, accountId, expiresAt);
  }

  accountForToken(tokenHash: string, now: number): AccountRow | undefined {
    return this.db
      .prepare<[string, number], AccountRow>(
        `SELECT a.* FROM browser_sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(tokenHash, now);
  }

  deleteBrowserSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM browser_sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteExpiredBrowserSessions(now: number): void {
    this.db.prepare('DELETE FROM browser_sessions WHERE expires_at <= ?').run(now);
  }

  // ---- photos --------------------------------------------------------------------------------

  insertPhoto(p: NewPhoto): number {
    const info = this.db
      .prepare(
        `INSERT INTO photos (account_id, sha256, filename, mime, size, width, height, taken_at, taken_source, uploaded_at,
           camera_make, camera_model, lens, iso, f_number, exposure_time, focal_length, gps_lat, gps_lon,
           status, tg_message_id, preview_state)
         VALUES (@account_id, @sha256, @filename, @mime, @size, @width, @height, @taken_at, @taken_source, @now,
           @camera_make, @camera_model, @lens, @iso, @f_number, @exposure_time, @focal_length, @gps_lat, @gps_lon,
           @status, @tg_message_id, @preview_state)`,
      )
      .run({ ...p, now: Date.now() });
    return Number(info.lastInsertRowid);
  }

  getPhoto(accountId: number, id: number): PhotoRow | undefined {
    return this.db.prepare<[number, number], PhotoRow>('SELECT * FROM photos WHERE account_id = ? AND id = ?').get(accountId, id);
  }

  getPhotoBySha(accountId: number, sha256: string): PhotoRow | undefined {
    return this.db
      .prepare<[number, string], PhotoRow>('SELECT * FROM photos WHERE account_id = ? AND sha256 = ?')
      .get(accountId, sha256);
  }

  getPhotos(accountId: number, ids: number[]): PhotoRow[] {
    if (ids.length === 0) return [];
    const rows: PhotoRow[] = [];
    const stmt = this.db.prepare<[number, string], PhotoRow>(
      'SELECT * FROM photos WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))',
    );
    for (let i = 0; i < ids.length; i += 500) {
      rows.push(...stmt.all(accountId, JSON.stringify(ids.slice(i, i + 500))));
    }
    return rows;
  }

  listPhotos(accountId: number, view: PhotoView, query: string): PhotoRow[] {
    const where: string[] = ['p.account_id = @accountId'];
    const params: Record<string, string | number> = { accountId };
    let join = '';

    if (view.kind === 'trash') {
      where.push('p.trashed_at IS NOT NULL');
    } else {
      where.push('p.trashed_at IS NULL');
      if (view.kind === 'favorites') where.push('p.favorite = 1');
      if (view.kind === 'album') {
        join = 'JOIN album_photos ap ON ap.photo_id = p.id AND ap.album_id = @albumId';
        params.albumId = view.albumId;
      }
    }

    query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8)
      .forEach((token, i) => {
        const key = `t${i}`;
        params[key] = `%${escapeLike(token)}%`;
        const fields = ['p.filename', 'p.camera_make', 'p.camera_model', 'p.lens', 'p.taken_at'];
        const clauses = fields.map((f) => `lower(${f}) LIKE @${key} ESCAPE '\\'`);
        const month = MONTHS[token];
        if (month) {
          params[`${key}m`] = `____-${month}-%`;
          clauses.push(`p.taken_at LIKE @${key}m`);
        }
        where.push(`(${clauses.join(' OR ')})`);
      });

    const sql = `SELECT p.* FROM photos p ${join} WHERE ${where.join(' AND ')} ORDER BY p.taken_at DESC, p.id DESC`;
    return this.db.prepare<Record<string, string | number>, PhotoRow>(sql).all(params);
  }

  setFavorite(accountId: number, ids: number[], favorite: boolean): void {
    this.db
      .prepare('UPDATE photos SET favorite = ? WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))')
      .run(favorite ? 1 : 0, accountId, JSON.stringify(ids));
  }

  setTrashed(accountId: number, ids: number[], trashedAt: number | null): void {
    this.db
      .prepare('UPDATE photos SET trashed_at = ? WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))')
      .run(trashedAt, accountId, JSON.stringify(ids));
  }

  deletePhotoRows(accountId: number, ids: number[]): void {
    this.db
      .prepare('DELETE FROM photos WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))')
      .run(accountId, JSON.stringify(ids));
  }

  trashedBefore(cutoff: number): PhotoRow[] {
    return this.db
      .prepare<[number], PhotoRow>(
        // A photo still uploading has no Telegram message yet, so it waits until the job settles.
        `SELECT * FROM photos WHERE trashed_at IS NOT NULL AND trashed_at <= ? AND status != 'uploading'`,
      )
      .all(cutoff);
  }

  trashedIds(accountId: number): number[] {
    return this.db
      .prepare<[number], { id: number }>('SELECT id FROM photos WHERE account_id = ? AND trashed_at IS NOT NULL')
      .all(accountId)
      .map((r) => r.id);
  }

  libraryStats(accountId: number): { count: number; bytes: number; trash: number; pending: number; failed: number } {
    return this.db
      .prepare<[number], { count: number; bytes: number; trash: number; pending: number; failed: number }>(
        `SELECT
           COALESCE(SUM(trashed_at IS NULL), 0) AS count,
           COALESCE(SUM(CASE WHEN status = 'stored' THEN size ELSE 0 END), 0) AS bytes,
           COALESCE(SUM(trashed_at IS NOT NULL), 0) AS trash,
           COALESCE(SUM(status IN ('queued','uploading')), 0) AS pending,
           COALESCE(SUM(status = 'failed'), 0) AS failed
         FROM photos WHERE account_id = ?`,
      )
      .get(accountId)!;
  }

  // ---- upload queue --------------------------------------------------------------------------

  /** After a crash, anything marked as mid-upload is simply queued again. */
  requeueInterrupted(): void {
    this.db.prepare(`UPDATE photos SET status = 'queued', next_attempt_at = 0 WHERE status = 'uploading'`).run();
  }

  nextUploadJob(now: number, busyAccounts: number[]): PhotoRow | undefined {
    return this.db
      .prepare<[number, string], PhotoRow>(
        `SELECT p.* FROM photos p JOIN accounts a ON a.id = p.account_id
         WHERE p.status = 'queued' AND p.next_attempt_at <= ?
           AND a.needs_reauth = 0 AND a.session_sealed IS NOT NULL AND a.channel_id IS NOT NULL
           AND p.account_id NOT IN (SELECT value FROM json_each(?))
         ORDER BY p.next_attempt_at, p.id LIMIT 1`,
      )
      .get(now, JSON.stringify(busyAccounts));
  }

  markUploading(id: number): void {
    this.db.prepare(`UPDATE photos SET status = 'uploading', last_error = NULL WHERE id = ?`).run(id);
  }

  markStored(id: number, messageId: number): void {
    this.db
      .prepare(`UPDATE photos SET status = 'stored', tg_message_id = ?, last_error = NULL WHERE id = ?`)
      .run(messageId, id);
  }

  /** Puts a job back in line. `countAttempt` is false when the wait was not this photo's fault. */
  rescheduleUpload(id: number, nextAttemptAt: number, error: string | null, countAttempt: boolean): void {
    this.db
      .prepare(
        `UPDATE photos SET status = 'queued', next_attempt_at = ?, last_error = ?, attempts = attempts + ? WHERE id = ?`,
      )
      .run(nextAttemptAt, error, countAttempt ? 1 : 0, id);
  }

  markFailed(id: number, error: string): void {
    this.db.prepare(`UPDATE photos SET status = 'failed', last_error = ?, attempts = attempts + 1 WHERE id = ?`).run(error, id);
  }

  retryFailed(accountId: number, ids: number[] | null): number {
    const info = ids
      ? this.db
          .prepare(
            `UPDATE photos SET status = 'queued', attempts = 0, next_attempt_at = 0, last_error = NULL
             WHERE account_id = ? AND status = 'failed' AND id IN (SELECT value FROM json_each(?))`,
          )
          .run(accountId, JSON.stringify(ids))
      : this.db
          .prepare(
            `UPDATE photos SET status = 'queued', attempts = 0, next_attempt_at = 0, last_error = NULL
             WHERE account_id = ? AND status = 'failed'`,
          )
          .run(accountId);
    return info.changes;
  }

  uploadActivity(accountId: number): PhotoRow[] {
    return this.db
      .prepare<[number], PhotoRow>(
        `SELECT * FROM photos WHERE account_id = ? AND status != 'stored' ORDER BY status = 'uploading' DESC, id LIMIT 200`,
      )
      .all(accountId);
  }

  /** The incoming files that are still needed. Anything else on disk is left over from a crash. */
  neededIncomingNames(): Set<string> {
    const rows = this.db
      .prepare<[], { name: string }>(`SELECT account_id || '-' || sha256 AS name FROM photos WHERE status != 'stored'`)
      .all();
    return new Set(rows.map((r) => r.name));
  }

  // ---- restoring previews --------------------------------------------------------------------

  nextPreviewJob(): PhotoRow | undefined {
    return this.db
      .prepare<[], PhotoRow>(
        `SELECT p.* FROM photos p JOIN accounts a ON a.id = p.account_id
         WHERE p.preview_state = 'missing' AND p.status = 'stored' AND p.trashed_at IS NULL
           AND a.needs_reauth = 0 AND a.session_sealed IS NOT NULL
         ORDER BY p.taken_at DESC LIMIT 1`,
      )
      .get();
  }

  markPreviewResult(
    id: number,
    state: PreviewState,
    meta?: Partial<Pick<PhotoRow, 'width' | 'height' | 'camera_make' | 'camera_model' | 'lens' | 'iso' | 'f_number' | 'exposure_time' | 'focal_length' | 'gps_lat' | 'gps_lon'>>,
  ): void {
    this.db
      .prepare(
        `UPDATE photos SET preview_state = @state,
           width = COALESCE(@width, width), height = COALESCE(@height, height),
           camera_make = COALESCE(@camera_make, camera_make), camera_model = COALESCE(@camera_model, camera_model),
           lens = COALESCE(@lens, lens), iso = COALESCE(@iso, iso), f_number = COALESCE(@f_number, f_number),
           exposure_time = COALESCE(@exposure_time, exposure_time), focal_length = COALESCE(@focal_length, focal_length),
           gps_lat = COALESCE(@gps_lat, gps_lat), gps_lon = COALESCE(@gps_lon, gps_lon)
         WHERE id = @id`,
      )
      .run({
        id, state, width: null, height: null, camera_make: null, camera_model: null, lens: null, iso: null,
        f_number: null, exposure_time: null, focal_length: null, gps_lat: null, gps_lon: null, ...meta,
      });
  }

  bumpPreviewAttempt(id: number): number {
    this.db.prepare('UPDATE photos SET preview_attempts = preview_attempts + 1 WHERE id = ?').run(id);
    return this.db.prepare<[number], { n: number }>('SELECT preview_attempts AS n FROM photos WHERE id = ?').get(id)?.n ?? 0;
  }

  // ---- albums --------------------------------------------------------------------------------

  listAlbums(accountId: number): (AlbumRow & { photo_count: number; cover_id: number | null })[] {
    return this.db
      .prepare<[number], AlbumRow & { photo_count: number; cover_id: number | null }>(
        `SELECT a.*,
           (SELECT COUNT(*) FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
             WHERE ap.album_id = a.id AND p.trashed_at IS NULL) AS photo_count,
           COALESCE(
             (SELECT p.id FROM photos p WHERE p.id = a.cover_photo_id AND p.trashed_at IS NULL),
             (SELECT p.id FROM album_photos ap JOIN photos p ON p.id = ap.photo_id
               WHERE ap.album_id = a.id AND p.trashed_at IS NULL ORDER BY p.taken_at DESC LIMIT 1)
           ) AS cover_id
         FROM albums a WHERE a.account_id = ? ORDER BY a.updated_at DESC`,
      )
      .all(accountId);
  }

  getAlbum(accountId: number, id: number): AlbumRow | undefined {
    return this.db.prepare<[number, number], AlbumRow>('SELECT * FROM albums WHERE account_id = ? AND id = ?').get(accountId, id);
  }

  createAlbum(accountId: number, title: string): number {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO albums (account_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(accountId, title, now, now);
    return Number(info.lastInsertRowid);
  }

  updateAlbum(accountId: number, id: number, patch: { title?: string; coverPhotoId?: number | null }): void {
    if (patch.title !== undefined) {
      this.db
        .prepare('UPDATE albums SET title = ?, updated_at = ? WHERE account_id = ? AND id = ?')
        .run(patch.title, Date.now(), accountId, id);
    }
    if (patch.coverPhotoId !== undefined) {
      this.db
        .prepare('UPDATE albums SET cover_photo_id = ?, updated_at = ? WHERE account_id = ? AND id = ?')
        .run(patch.coverPhotoId, Date.now(), accountId, id);
    }
  }

  deleteAlbum(accountId: number, id: number): void {
    this.db.prepare('DELETE FROM albums WHERE account_id = ? AND id = ?').run(accountId, id);
  }

  addToAlbum(accountId: number, albumId: number, photoIds: number[]): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO album_photos (album_id, photo_id, added_at)
         SELECT ?, id, ? FROM photos WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))`,
      )
      .run(albumId, now, accountId, JSON.stringify(photoIds));
    this.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(now, albumId);
  }

  removeFromAlbum(albumId: number, photoIds: number[]): void {
    this.db
      .prepare('DELETE FROM album_photos WHERE album_id = ? AND photo_id IN (SELECT value FROM json_each(?))')
      .run(albumId, JSON.stringify(photoIds));
    this.db.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').run(Date.now(), albumId);
  }
}
