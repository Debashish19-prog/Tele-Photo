import { rm } from 'node:fs/promises';
import { parseCaption } from './caption.js';
import type { PhotoRow, Repo } from './db.js';
import { removePreviews } from './media.js';
import type { Paths } from './paths.js';
import { contextFor, type UploadQueue } from './queue.js';
import type { Sealer } from './secrets.js';
import { SessionRevokedError, type StorageBackend } from './storage/types.js';

const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScanState {
  running: boolean;
  scanned: number;
  added: number;
  error: string | null;
}

export class Library {
  private readonly scans = new Map<number, ScanState>();
  private purgeTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly storage: StorageBackend,
    private readonly sealer: Sealer,
    private readonly paths: Paths,
    private readonly queue: UploadQueue,
    private readonly retentionDays: number,
  ) {}

  startPurgeTimer(): void {
    void this.purgeExpired();
    this.purgeTimer = setInterval(() => void this.purgeExpired(), PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  stop(): void {
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = null;
  }

  /**
   * Permanently removes photos, from Telegram first and then locally. If Telegram refuses, the
   * local record stays, so the photo can never end up in Telegram with nothing pointing at it.
   * A photo mid-upload is skipped, because its message does not exist yet.
   */
  async deletePermanently(accountId: number, photos: PhotoRow[]): Promise<{ deleted: number; skipped: number }> {
    const account = this.repo.getAccount(accountId);
    if (!account) return { deleted: 0, skipped: photos.length };

    const removable = photos.filter((p) => p.status !== 'uploading');
    const messageIds = removable.filter((p) => p.tg_message_id !== null).map((p) => p.tg_message_id!);
    if (messageIds.length > 0) {
      await this.storage.deletePhotos(contextFor(account, this.sealer), messageIds);
    }
    // Checked again now that the await is over: the queue may have picked up a photo meanwhile.
    const fresh = this.repo.getPhotos(accountId, removable.map((p) => p.id)).filter((p) => p.status !== 'uploading');
    this.repo.deletePhotoRows(accountId, fresh.map((p) => p.id));
    await Promise.all(
      fresh.map(async (p) => {
        await removePreviews(this.paths.thumb(accountId, p.sha256), this.paths.preview(accountId, p.sha256));
        await rm(this.paths.incoming(accountId, p.sha256), { force: true });
      }),
    );
    return { deleted: fresh.length, skipped: photos.length - fresh.length };
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    const cutoff = now - this.retentionDays * DAY_MS;
    const byAccount = new Map<number, PhotoRow[]>();
    for (const photo of this.repo.trashedBefore(cutoff)) {
      const list = byAccount.get(photo.account_id) ?? [];
      list.push(photo);
      byAccount.set(photo.account_id, list);
    }
    let total = 0;
    for (const [accountId, photos] of byAccount) {
      try {
        total += (await this.deletePermanently(accountId, photos)).deleted;
      } catch {
        // Offline or signed out. Those photos stay in Trash and the next pass tries again.
      }
    }
    return total;
  }

  scanState(accountId: number): ScanState {
    return this.scans.get(accountId) ?? { running: false, scanned: 0, added: 0, error: null };
  }

  /** Reads the Telegram channel and restores anything the local index does not know about. */
  startScan(accountId: number): ScanState {
    const current = this.scanState(accountId);
    if (current.running) return current;
    const state: ScanState = { running: true, scanned: 0, added: 0, error: null };
    this.scans.set(accountId, state);
    void this.runScan(accountId, state);
    return state;
  }

  private async runScan(accountId: number, state: ScanState): Promise<void> {
    try {
      const account = this.repo.getAccount(accountId);
      if (!account) throw new Error('Account not found');
      for await (const item of this.storage.scanLibrary(contextFor(account, this.sealer))) {
        const facts = parseCaption(item.caption);
        if (!facts) continue; // Something the user posted by hand. Not ours to manage.
        state.scanned++;
        if (this.repo.getPhotoBySha(accountId, facts.sha256)) continue;
        this.repo.insertPhoto({
          account_id: accountId,
          sha256: facts.sha256,
          filename: item.filename,
          mime: item.mime,
          size: item.size,
          width: facts.width,
          height: facts.height,
          taken_at: facts.takenAt,
          taken_source: 'telegram',
          camera_make: null, camera_model: null, lens: null, iso: null, f_number: null,
          exposure_time: null, focal_length: null, gps_lat: null, gps_lon: null,
          status: 'stored',
          tg_message_id: item.messageId,
          preview_state: 'missing',
        });
        state.added++;
      }
    } catch (err) {
      if (err instanceof SessionRevokedError) this.repo.setNeedsReauth(accountId);
      state.error = err instanceof Error ? err.message : String(err);
    } finally {
      state.running = false;
      this.queue.notify();
    }
  }
}
