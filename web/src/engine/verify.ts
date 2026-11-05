import type { Engine } from './index';
import { hashBlob } from './media';
import { collectBlob } from './queue';
import { decodeDoc, encodeDoc } from './sync';
import type { StorageContext } from './types';

export interface VerifyResult {
  name: string;
  why: string;
  size: number | null;
  pass: boolean;
  detail: string;
}

const CAPTION = 'Tele-Photo storage check. Safe to delete.';
/** Telegram switches to its big-file call above 10 MB, and that path deserves checking too. */
const BIG_SIDE = 2200;

/** Noise, so every run produces new bytes and nothing can match an earlier upload. */
function noiseCanvas(width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height);
  // getRandomValues refuses more than 64 KB in one call.
  for (let at = 0; at < image.data.length; at += 65536) crypto.getRandomValues(image.data.subarray(at, at + 65536));
  for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
  context.putImageData(image, 0, 0);
  return canvas;
}

/** A canvas cannot write a GIF, so this is one written by hand: a single pixel and some random comment bytes. */
function randomGif(): Blob {
  const comment = crypto.getRandomValues(new Uint8Array(200));
  return new Blob(
    [
      new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]),
      new Uint8Array([0x21, 0xfe, comment.length]),
      comment,
      new Uint8Array([0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b]),
    ],
    { type: 'image/gif' },
  );
}

async function samples(): Promise<{ name: string; mime: string; why: string; file: Blob }[]> {
  return [
    { name: 'check.jpg', mime: 'image/jpeg', why: 'Telegram recompresses JPEGs sent as photos', file: await noiseCanvas(800, 600).convertToBlob({ type: 'image/jpeg', quality: 0.95 }) },
    { name: 'check.png', mime: 'image/png', why: 'Would become a JPEG if sent as a photo', file: await noiseCanvas(400, 300).convertToBlob({ type: 'image/png' }) },
    { name: 'check.webp', mime: 'image/webp', why: 'Could be treated as a sticker', file: await noiseCanvas(400, 300).convertToBlob({ type: 'image/webp', quality: 0.9 }) },
    { name: 'check.gif', mime: 'image/gif', why: 'Could be converted to an MP4', file: randomGif() },
    { name: 'check-big.png', mime: 'image/png', why: 'Over 10 MB, so it uses the big-file call', file: await noiseCanvas(BIG_SIDE, BIG_SIDE).convertToBlob({ type: 'image/png' }) },
  ];
}

/**
 * Proves the thing tests cannot: that real Telegram gives back exactly the bytes it was given.
 *
 * Sends a few generated images to the library channel, downloads each one, compares SHA-256
 * hashes, and deletes them again. Their captions have no photo marker, so even if a delete fails
 * they can never appear in the library.
 */
export async function verifyStorage(engine: Engine, context: StorageContext, onResult: (result: VerifyResult) => void): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const report = (result: VerifyResult) => {
    results.push(result);
    onResult(result);
  };
  const thumb = await noiseCanvas(64, 48).convertToBlob({ type: 'image/jpeg', quality: 0.8 });

  for (const sample of await samples()) {
    let messageId: number | null = null;
    try {
      const expected = await hashBlob(sample.file);
      const stored = await engine.storage.putPhoto(
        context,
        { file: sample.file, thumb, filename: sample.name, mime: sample.mime, size: sample.file.size, caption: CAPTION },
        () => undefined,
      );
      messageId = stored.messageId;
      const { stream } = await engine.storage.getPhoto(context, messageId);
      const actual = await hashBlob(await collectBlob(stream, sample.mime));
      const thumbBack = await engine.storage.getThumb(context, messageId);
      const pass = actual === expected;
      report({
        name: sample.name,
        why: sample.why,
        size: sample.file.size,
        pass,
        detail: pass ? (thumbBack ? 'Identical, and its thumbnail came back too' : 'Identical, but Telegram kept no thumbnail') : 'The bytes that came back are different',
      });
    } catch (err) {
      report({ name: sample.name, why: sample.why, size: sample.file.size, pass: false, detail: err instanceof Error ? err.message : String(err) });
    } finally {
      if (messageId !== null) await engine.storage.deletePhotos(context, [messageId]).catch(() => undefined);
    }
  }

  // The real saved state must not be disturbed, so this writes what is already there back again.
  try {
    await engine.sync.flush();
    const read = await engine.storage.readState(context, null);
    const file = read.changed ? read.file : null;
    const known = file ? { messageId: file.messageId, version: file.version } : null;
    const bytes = file?.bytes ?? (await encodeDoc({ v: 1, photos: {}, albums: {} }));
    const saved = await engine.storage.writeState(context, bytes, known);
    const back = await engine.storage.readState(context, null);
    const readable = back.changed && back.file ? await decodeDoc(back.file.bytes) : null;
    const pass = readable !== null && back.changed && back.file?.messageId === saved.messageId;
    report({ name: 'Albums and favorites', why: 'They sync between devices through this file', size: bytes.length, pass, detail: pass ? 'Saved and read back' : 'What came back could not be read' });
    if (pass) await engine.sync.pull();
  } catch (err) {
    report({ name: 'Albums and favorites', why: 'They sync between devices through this file', size: null, pass: false, detail: err instanceof Error ? err.message : String(err) });
  }
  return results;
}
