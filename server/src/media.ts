import exifr from 'exifr';
import { fileTypeFromFile } from 'file-type';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import sharp, { type Sharp } from 'sharp';
import decodeHeic from 'heic-decode';

const THUMB_HEIGHT = 512;
const THUMB_MAX_WIDTH = 1024;
const PREVIEW_EDGE = 2560;
/** Past this a HEIC is decoded into too much memory to be worth previewing. It is still stored. */
const HEIC_DECODE_LIMIT_BYTES = 300 * 1024 * 1024;
const MAX_INPUT_PIXELS = 1_000_000_000;
/** Cameras put the embedded preview near the start of a file. */
const EMBEDDED_PREVIEW_SEARCH_BYTES = 32 * 1024 * 1024;

sharp.cache(false);

export interface PhotoMetadata {
  takenAt: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lens: string | null;
  iso: number | null;
  fNumber: number | null;
  exposureTime: number | null;
  focalLength: number | null;
  gpsLat: number | null;
  gpsLon: number | null;
  exifWidth: number | null;
  exifHeight: number | null;
}

const EMPTY_METADATA: PhotoMetadata = {
  takenAt: null, cameraMake: null, cameraModel: null, lens: null, iso: null, fNumber: null,
  exposureTime: null, focalLength: null, gpsLat: null, gpsLon: null, exifWidth: null, exifHeight: null,
};

/** Runs a limited number of heavy tasks at once, so a big batch cannot exhaust memory. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Looks at the file's actual bytes, because a browser's name and type can say anything. */
export async function sniffImage(path: string): Promise<{ mime: string; ext: string } | null> {
  const type = await fileTypeFromFile(path).catch(() => undefined);
  if (!type?.mime.startsWith('image/')) return null;
  return { mime: type.mime, ext: type.ext };
}

const text = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const trimmed = v.replace(/\0/g, '').trim();
  return trimmed || null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** EXIF dates have no zone and mean the local time at the camera, so they are kept exactly as written. */
export function parseExifDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (Number(y) < 1800 || mo === '00' || d === '00') return null;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

export async function readPhotoMetadata(path: string): Promise<PhotoMetadata> {
  try {
    const t = await exifr.parse(path, {
      tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false,
      iptc: false, jfif: false, ihdr: false, reviveValues: false, translateValues: false, mergeOutput: true,
    });
    if (!t) return EMPTY_METADATA;
    return {
      takenAt: parseExifDate(t.DateTimeOriginal) ?? parseExifDate(t.CreateDate) ?? parseExifDate(t.DateTime) ?? parseExifDate(t.ModifyDate),
      cameraMake: text(t.Make),
      cameraModel: text(t.Model),
      lens: text(t.LensModel),
      iso: num(t.ISO),
      fNumber: num(t.FNumber),
      exposureTime: num(t.ExposureTime),
      focalLength: num(t.FocalLength),
      gpsLat: num(t.latitude),
      gpsLon: num(t.longitude),
      exifWidth: num(t.ExifImageWidth) ?? num(t.ImageWidth),
      exifHeight: num(t.ExifImageHeight) ?? num(t.ImageHeight),
    };
  } catch {
    return EMPTY_METADATA;
  }
}

async function writeWebp(pipeline: Sharp, out: string, quality: number): Promise<void> {
  const tmp = `${out}.tmp`;
  try {
    await pipeline.webp({ quality }).toFile(tmp);
    await rename(tmp, out);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function buildFromSharp(
  source: () => Sharp,
  width: number,
  height: number,
  thumbPath: string,
  previewPath: string,
): Promise<{ width: number; height: number }> {
  await writeWebp(
    source().resize({ width: PREVIEW_EDGE, height: PREVIEW_EDGE, fit: 'inside', withoutEnlargement: true }),
    previewPath,
    84,
  );
  // Made from the preview, which is far cheaper than decoding the original a second time.
  await writeWebp(
    sharp(previewPath).resize({ width: THUMB_MAX_WIDTH, height: THUMB_HEIGHT, fit: 'inside', withoutEnlargement: true }),
    thumbPath,
    74,
  );
  return { width, height };
}

/**
 * A camera RAW usually embeds a small JPEG. Showing that is much better than a blank tile, even
 * though it is not a full development of the file.
 */
async function buildFromEmbeddedJpeg(path: string, thumbPath: string, previewPath: string) {
  // Given a path, exifr.thumbnail leaves its file handle open, one per call. Handing it a piece
  // of the file instead means it never opens anything.
  const handle = await open(path, 'r');
  let head: Buffer;
  try {
    const space = Buffer.alloc(EMBEDDED_PREVIEW_SEARCH_BYTES);
    const { bytesRead } = await handle.read(space, 0, space.length, 0);
    head = space.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const buffer = await exifr.thumbnail(head);
  if (!buffer) return null;
  const bytes = Buffer.from(buffer);
  const meta = await sharp(bytes).metadata();
  return buildFromSharp(
    () => sharp(bytes, { failOn: 'none' }).rotate(),
    meta.autoOrient.width,
    meta.autoOrient.height,
    thumbPath,
    previewPath,
  );
}

/**
 * Writes the web-sized copies the app displays. These only ever affect what is shown in the
 * browser. The original is never touched by this function.
 *
 * Returns the display size, or null if nothing in the chain could read the image. That does not
 * fail the upload: the photo is stored in Telegram regardless and gets a placeholder tile.
 */
export async function generatePreviews(
  path: string,
  mime: string,
  thumbPath: string,
  previewPath: string,
): Promise<{ width: number; height: number } | null> {
  const isHeic = mime === 'image/heic' || mime === 'image/heif' || mime === 'image/heic-sequence' || mime === 'image/heif-sequence';

  if (isHeic) {
    // The prebuilt sharp binary has no HEVC decoder, so iPhone photos go through libheif (WASM).
    try {
      const { size } = await stat(path);
      if (size <= HEIC_DECODE_LIMIT_BYTES) {
        const decoded = await decodeHeic({ buffer: await readFile(path) });
        const raw = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
        return await buildFromSharp(
          () => sharp(raw, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }),
          decoded.width,
          decoded.height,
          thumbPath,
          previewPath,
        );
      }
    } catch {
      // Fall through to the generic attempts below.
    }
  }

  try {
    const options = { failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true } as const;
    const meta = await sharp(path, options).metadata();
    return await buildFromSharp(
      () => sharp(path, options).rotate(),
      meta.autoOrient.width,
      meta.autoOrient.height,
      thumbPath,
      previewPath,
    );
  } catch {
    // Fall through.
  }

  try {
    return await buildFromEmbeddedJpeg(path, thumbPath, previewPath);
  } catch {
    return null;
  }
}

export async function removePreviews(thumbPath: string, previewPath: string): Promise<void> {
  await Promise.all([rm(thumbPath, { force: true }), rm(previewPath, { force: true })]);
}
