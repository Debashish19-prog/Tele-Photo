import { createHash } from 'node:crypto';
import { Engine, type IngestResult } from '../src/engine/index';
import { FakeStorage, type FakeDisk, memoryDisk } from '../src/engine/fake';
import { readMetadata, sniffImage, type MediaTools, type Previews } from '../src/engine/media';

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
export const blobBytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

function exifBlock(date?: string, camera?: string): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(`${s}\0`);
  const make = ascii('Canon');
  const model = ascii(camera ?? '');
  const taken = ascii(date ?? '');
  const ifd0Count = (camera ? 2 : 0) + (date ? 1 : 0);
  const ifd0End = 8 + 2 + ifd0Count * 12 + 4;
  const makeAt = ifd0End;
  const modelAt = makeAt + (camera ? make.length : 0);
  const exifIfdAt = modelAt + (camera ? model.length : 0);
  const exifEnd = exifIfdAt + (date ? 2 + 12 + 4 : 0);
  const buffer = new Uint8Array(exifEnd + (date ? taken.length : 0));
  const view = new DataView(buffer.buffer);
  buffer.set([0x49, 0x49, 0x2a, 0], 0);
  view.setUint32(4, 8, true);
  view.setUint16(8, ifd0Count, true);
  let entry = 10;
  const write = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, type, true);
    view.setUint32(entry + 4, count, true);
    view.setUint32(entry + 8, value, true);
    entry += 12;
  };
  if (camera) {
    write(0x010f, 2, make.length, makeAt);
    write(0x0110, 2, model.length, modelAt);
    buffer.set(make, makeAt);
    buffer.set(model, modelAt);
  }
  if (date) {
    write(0x8769, 4, 1, exifIfdAt);
    view.setUint16(exifIfdAt, 1, true);
    entry = exifIfdAt + 2;
    write(0x9003, 2, taken.length, exifEnd);
    buffer.set(taken, exifEnd);
  }
  const header = new TextEncoder().encode('Exif\0\0');
  const app1 = new Uint8Array(4 + header.length + buffer.length);
  app1.set([0xff, 0xe1, (app1.length - 2) >> 8, (app1.length - 2) & 0xff], 0);
  app1.set(header, 4);
  app1.set(buffer, 4 + header.length);
  return app1;
}

/**
 * A small file that really is a JPEG as far as its header and EXIF go. Pixels are only tested in a
 * real browser. `color` just makes the bytes differ, so two calls can be different photos.
 */
export function makeJpeg(options: { color?: string; width?: number; height?: number; date?: string; camera?: string } = {}): Uint8Array {
  const { color = '#336699', width = 64, height = 48, date, camera } = options;
  const comment = new TextEncoder().encode(color);
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  if (date || camera) parts.push(exifBlock(date, camera));
  parts.push(new Uint8Array([0xff, 0xfe, 0, comment.length + 2]), comment);
  parts.push(new Uint8Array([0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
  parts.push(new Uint8Array([0xff, 0xd9]));
  return new Uint8Array(Buffer.concat(parts));
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    if (bytes[i + 1] === 0xc0) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    i += 2 + ((bytes[i + 2]! << 8) | bytes[i + 3]!);
  }
  return null;
}

/** Everything real except the pixel work, which needs a browser and is tested in one. */
export const testMedia: MediaTools = {
  sniffImage,
  readMetadata,
  async makePreviews(file): Promise<Previews | null> {
    const size = jpegSize(await blobBytes(file));
    if (!size) return null;
    return { ...size, thumb: new Blob(['grid-thumb'], { type: 'image/webp' }), preview: new Blob(['viewer-preview'], { type: 'image/webp' }), telegramThumb: new Blob(['telegram-thumb'], { type: 'image/jpeg' }) };
  },
};

let counter = 0;

/** A browser profile: its own local database, talking to one shared pretend Telegram. */
export class Device {
  engine!: Engine;
  readonly storage: FakeStorage;
  dbName = `tp-test-${process.pid}-${++counter}`;

  constructor(readonly disk: FakeDisk = memoryDisk(), storage?: FakeStorage) {
    this.storage = storage ?? new FakeStorage(disk);
  }

  async open(options: { trashRetentionDays?: number } = {}): Promise<this> {
    this.engine = await Engine.open({ storage: this.storage, configured: true, media: testMedia, dbName: this.dbName, ...options });
    return this;
  }

  /** Closes this tab, keeping what is saved. Files it was holding are gone, as with a real tab. */
  async reload(): Promise<void> {
    await this.engine.close();
    await this.open();
  }

  /** The browser's data is cleared, or this is a brand new device. Telegram is untouched. */
  async wipeBrowser(): Promise<void> {
    await this.engine.close();
    this.dbName = `tp-test-${process.pid}-${++counter}`;
    await this.open();
  }

  async close(): Promise<void> {
    await this.engine.close();
  }

  async signIn(phone = '+15550000001'): Promise<void> {
    const { loginId } = await this.engine.sendCode(phone);
    const result = await this.engine.submitCode(loginId, '12345');
    if (result.status !== 'ok') throw new Error('expected no password step');
    await this.engine.whenIdle();
  }

  add(bytes: Uint8Array, filename = 'photo.jpg', lastModified: string | null = null): Promise<IngestResult> {
    return this.engine.ingest(new Blob([bytes as BlobPart]), filename, lastModified);
  }

  async addOk(bytes: Uint8Array, filename = 'photo.jpg', lastModified: string | null = null): Promise<number> {
    return (await this.add(bytes, filename, lastModified)).id;
  }

  async stored(bytes: Uint8Array, filename = 'photo.jpg'): Promise<number> {
    const id = await this.addOk(bytes, filename);
    await this.engine.queue.drain();
    return id;
  }

  names(query: Parameters<Engine['photos']>[0] = {}): string[] {
    return this.engine.photos(query).map((p) => p.filename);
  }

  /** Pushes this device's changes up, as its timer would a few seconds later. */
  async saveState(): Promise<void> {
    await this.engine.sync.flush();
  }

  /** Reads what other devices have done, as coming back to the app would. */
  async catchUp(): Promise<void> {
    await this.engine.sync.pull();
    this.engine.library.startScan({ full: false });
    await this.engine.whenIdle();
  }
}
