import { toWallClock } from '@/lib/format';

/** Telegram's single-file ceiling: 4000 parts of 512 KiB. The server enforces the same number. */
export const MAX_PHOTO_BYTES = 4000 * 512 * 1024;
const CONCURRENCY = 3;

/** Browsers leave the type blank for many camera formats, so these are recognised by name. */
const PHOTO_EXTENSIONS = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|jxl|dng|cr2|cr3|nef|arw|orf|rw2|raf|pef|srw)$/i;

export type LocalStage = 'waiting' | 'sending' | 'received' | 'duplicate' | 'restored' | 'error';

export interface LocalUpload {
  key: number;
  file: File | null;
  filename: string;
  size: number;
  stage: LocalStage;
  progress: number;
  error: string | null;
  photoId: number | null;
}

type Listener = () => void;

/** Sends files from the browser to the server. Telegram comes after that, on the server's side. */
class Uploader {
  private entries: LocalUpload[] = [];
  private readonly listeners = new Set<Listener>();
  private active = 0;
  private nextKey = 1;
  /** Called whenever a file lands on the server, so the grid can show it straight away. */
  onReceived: (() => void) | null = null;

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.entries;

  private emit(): void {
    this.entries = [...this.entries];
    for (const listener of this.listeners) listener();
  }

  private patch(key: number, change: Partial<LocalUpload>): void {
    const entry = this.entries.find((e) => e.key === key);
    if (entry) Object.assign(entry, change);
    this.emit();
  }

  /** True while leaving the page would lose something that has not reached the server. */
  get isBusy(): boolean {
    return this.entries.some((e) => e.stage === 'waiting' || e.stage === 'sending');
  }

  add(files: File[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    for (const file of files) {
      const looksLikePhoto = file.type.startsWith('image/') || PHOTO_EXTENSIONS.test(file.name);
      if (!looksLikePhoto) {
        skipped++;
        continue;
      }
      const tooBig = file.size > MAX_PHOTO_BYTES;
      this.entries.push({
        key: this.nextKey++,
        file: tooBig ? null : file,
        filename: file.name,
        size: file.size,
        stage: tooBig ? 'error' : 'waiting',
        progress: 0,
        error: tooBig ? 'Larger than the 1.95 GB Telegram accepts in one file.' : null,
        photoId: null,
      });
      added++;
    }
    this.emit();
    this.pump();
    return { added, skipped };
  }

  retry(key: number): void {
    const entry = this.entries.find((e) => e.key === key);
    if (!entry?.file) return;
    this.patch(key, { stage: 'waiting', progress: 0, error: null });
    this.pump();
  }

  dismiss(key: number): void {
    this.entries = this.entries.filter((e) => e.key !== key);
    this.emit();
  }

  /** Forgets everything that no longer needs attention. */
  clearSettled(isSettled: (entry: LocalUpload) => boolean): void {
    this.entries = this.entries.filter((e) => !isSettled(e));
    this.emit();
  }

  private pump(): void {
    while (this.active < CONCURRENCY) {
      const next = this.entries.find((e) => e.stage === 'waiting');
      if (!next) return;
      this.active++;
      this.patch(next.key, { stage: 'sending' });
      void this.send(next).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private send(entry: LocalUpload): Promise<void> {
    return new Promise((resolve) => {
      const form = new FormData();
      form.append('file', entry.file!, entry.filename);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/uploads?lastModified=${encodeURIComponent(toWallClock(entry.file!.lastModified))}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) this.patch(entry.key, { progress: event.loaded / event.total });
      };
      xhr.onerror = () => {
        this.patch(entry.key, { stage: 'error', error: 'Lost the connection to the server.' });
        resolve();
      };
      xhr.onload = () => {
        let body: { id?: number; duplicate?: boolean; restored?: boolean; error?: { message?: string } } | null = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // Reported as a failure below.
        }
        if (xhr.status >= 200 && xhr.status < 300 && body?.id) {
          this.patch(entry.key, {
            stage: body.restored ? 'restored' : body.duplicate ? 'duplicate' : 'received',
            progress: 1,
            photoId: body.id,
            // Nothing further needs it, and holding on to a File keeps it in memory for no reason.
            file: null,
          });
          this.onReceived?.();
        } else {
          const message = body?.error?.message ?? 'The server could not take this file.';
          // A file refused for what it is would be refused again, so there is nothing to retry.
          const permanent = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 401 && xhr.status !== 429;
          this.patch(entry.key, { stage: 'error', error: message, ...(permanent ? { file: null } : {}) });
        }
        resolve();
      };
      xhr.send(form);
    });
  }
}

export const uploader = new Uploader();

/** Walks a dropped folder, because dropping a whole folder is how a library usually moves in. */
export async function filesFromDrop(data: DataTransfer): Promise<File[]> {
  // Both are read before the first await: a browser empties a DataTransfer once the event is over.
  const entries = [...data.items].map((item) => item.webkitGetAsEntry()).filter((e): e is FileSystemEntry => e !== null);
  if (entries.length === 0) return [...data.files];
  const files: File[] = [];

  async function walk(entry: FileSystemEntry): Promise<void> {
    if (entry.isFile) {
      await new Promise<void>((resolve) => {
        (entry as FileSystemFileEntry).file(
          (file) => {
            files.push(file);
            resolve();
          },
          () => resolve(),
        );
      });
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most about 100 at a time, so it must be called until it comes back empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
      if (batch.length === 0) return;
      for (const child of batch) await walk(child);
    }
  }

  for (const entry of entries) await walk(entry);
  return files;
}
