import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildCaption } from './caption.js';
import type { AccountRow, PhotoRow, Repo } from './db.js';
import { createLimiter, generatePreviews, readPhotoMetadata } from './media.js';
import type { Paths } from './paths.js';
import type { Sealer } from './secrets.js';
import { RateLimitedError, SessionRevokedError, type StorageBackend, type StorageContext } from './storage/types.js';

const MAX_ATTEMPTS = 6;
const MAX_PARALLEL_ACCOUNTS = 3;
const POLL_MS = 5000;
const MAX_PREVIEW_ATTEMPTS = 3;

export function contextFor(account: AccountRow, sealer: Sealer): StorageContext {
  if (!account.session_sealed || !account.channel_id || !account.channel_access_hash) {
    throw new SessionRevokedError('NO_SESSION');
  }
  return {
    session: sealer.open(account.session_sealed),
    library: { channelId: account.channel_id, accessHash: account.channel_access_hash },
  };
}

/** Thumbnails and previews are CPU and memory heavy, so this is shared by everything that makes them. */
export const mediaLimiter = createLimiter(2);

/**
 * Moves originals from local disk into Telegram.
 *
 * The queue is the database itself, so a restart picks up where it stopped. The local copy is only
 * deleted after Telegram has confirmed the file and that fact is committed, so at every moment at
 * least one complete copy exists.
 */
export class UploadQueue {
  readonly progress = new Map<number, number>();
  private readonly busy = new Set<number>();
  private readonly pausedUntil = new Map<number, number>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private previewRunning = false;
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly repo: Repo,
    private readonly storage: StorageBackend,
    private readonly sealer: Sealer,
    private readonly paths: Paths,
  ) {}

  async start(): Promise<void> {
    this.repo.requeueInterrupted();
    await this.removeOrphans();
    this.stopped = false;
    this.timer = setInterval(() => this.notify(), POLL_MS);
    this.timer.unref();
    this.notify();
  }

  /**
   * Stops taking new work. An upload still running at shutdown stays marked as "uploading", and
   * the next start queues it again, so an interrupted upload is retried rather than lost.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Gives running jobs a moment to finish, so ones about to complete are recorded as complete. */
  async settle(timeoutMs: number): Promise<void> {
    if (this.running.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.running),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Resolves when no job is running and none is ready to start. For tests and tooling. */
  async drain(): Promise<void> {
    for (;;) {
      this.notify();
      if (this.running.size === 0) return;
      await Promise.all(this.running);
    }
  }

  notify(): void {
    if (this.stopped) return;
    while (this.busy.size < MAX_PARALLEL_ACCOUNTS) {
      const now = Date.now();
      for (const [accountId, until] of this.pausedUntil) if (until <= now) this.pausedUntil.delete(accountId);
      const job = this.repo.nextUploadJob(now, [...this.busy, ...this.pausedUntil.keys()]);
      if (!job) break;
      this.busy.add(job.account_id);
      this.repo.markUploading(job.id);
      this.track(this.runUpload(job));
    }
    if (this.busy.size === 0 && !this.previewRunning) {
      const job = this.repo.nextPreviewJob();
      if (job) {
        this.previewRunning = true;
        this.track(this.runPreview(job));
      }
    }
  }

  private track(task: Promise<void>): void {
    this.running.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(task);
        this.notify();
      });
  }

  private async runUpload(job: PhotoRow): Promise<void> {
    const account = this.repo.getAccount(job.account_id)!;
    const path = this.paths.incoming(job.account_id, job.sha256);
    this.progress.set(job.id, 0);
    try {
      const fileExists = await access(path).then(() => true, () => false);
      if (!fileExists) {
        this.repo.markFailed(job.id, 'The local copy of this file is missing, so it could not be sent.');
        return;
      }
      const { messageId } = await this.storage.putPhoto(
        contextFor(account, this.sealer),
        {
          path,
          filename: job.filename,
          mime: job.mime,
          size: job.size,
          caption: buildCaption({
            filename: job.filename, sha256: job.sha256, takenAt: job.taken_at, width: job.width, height: job.height,
          }),
        },
        (fraction) => this.progress.set(job.id, fraction),
      );
      // Commit first, delete second. A crash in between leaves a spare file, never a lost photo.
      this.repo.markStored(job.id, messageId);
      await rm(path, { force: true });
    } catch (err) {
      this.handleUploadError(job, account, err);
    } finally {
      this.progress.delete(job.id);
      this.busy.delete(job.account_id);
    }
  }

  private handleUploadError(job: PhotoRow, account: AccountRow, err: unknown): void {
    // Shutting down closes the connection under the job. That is not the photo's fault, and the
    // database may already be closed. The row stays "uploading" and is queued again next start.
    if (this.stopped) return;
    if (err instanceof SessionRevokedError) {
      // Signing in again revokes the old session, which can fail a job that was using it.
      // That is not a reason to ask the user to sign in yet again.
      const current = this.repo.getAccount(account.id);
      if (current?.session_sealed === account.session_sealed) this.repo.setNeedsReauth(account.id);
      this.repo.rescheduleUpload(job.id, 0, null, false);
      return;
    }
    if (err instanceof RateLimitedError) {
      const resumeAt = Date.now() + (err.seconds + 1) * 1000;
      this.pausedUntil.set(job.account_id, resumeAt);
      this.repo.rescheduleUpload(job.id, resumeAt, null, false);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (job.attempts + 1 >= MAX_ATTEMPTS) {
      this.repo.markFailed(job.id, message);
    } else {
      this.repo.rescheduleUpload(job.id, Date.now() + 5000 * 2 ** job.attempts, message, true);
    }
  }

  /** Rebuilds the thumbnail of a photo that came back from a library rescan. */
  private async runPreview(job: PhotoRow): Promise<void> {
    const tmp = join(this.paths.tmpDir, randomUUID());
    try {
      const account = this.repo.getAccount(job.account_id)!;
      const { stream } = await this.storage.getPhoto(contextFor(account, this.sealer), job.tg_message_id!);
      await pipeline(Readable.from(stream, { objectMode: false }), createWriteStream(tmp, { mode: 0o600 }));

      const thumb = this.paths.thumb(job.account_id, job.sha256);
      const preview = this.paths.preview(job.account_id, job.sha256);
      this.paths.ensureParent(thumb);
      const size = await mediaLimiter(() => generatePreviews(tmp, job.mime, thumb, preview));
      const meta = await readPhotoMetadata(tmp);
      this.repo.markPreviewResult(job.id, size ? 'ready' : 'unavailable', {
        width: size?.width ?? meta.exifWidth,
        height: size?.height ?? meta.exifHeight,
        camera_make: meta.cameraMake,
        camera_model: meta.cameraModel,
        lens: meta.lens,
        iso: meta.iso,
        f_number: meta.fNumber,
        exposure_time: meta.exposureTime,
        focal_length: meta.focalLength,
        gps_lat: meta.gpsLat,
        gps_lon: meta.gpsLon,
      });
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof SessionRevokedError) {
        this.repo.setNeedsReauth(job.account_id);
      } else if (err instanceof RateLimitedError) {
        this.pausedUntil.set(job.account_id, Date.now() + (err.seconds + 1) * 1000);
      } else if (this.repo.bumpPreviewAttempt(job.id) >= MAX_PREVIEW_ATTEMPTS) {
        this.repo.markPreviewResult(job.id, 'unavailable');
      }
    } finally {
      this.previewRunning = false;
      await rm(tmp, { force: true });
    }
  }

  /** Removes half-written uploads and spare copies left behind by a crash. */
  private async removeOrphans(): Promise<void> {
    await rm(this.paths.tmpDir, { recursive: true, force: true });
    this.paths.ensureParent(join(this.paths.tmpDir, 'x'));
    const needed = this.repo.neededIncomingNames();
    for (const name of await readdir(this.paths.incomingDir)) {
      if (!needed.has(name)) await rm(join(this.paths.incomingDir, name), { force: true });
    }
  }
}
