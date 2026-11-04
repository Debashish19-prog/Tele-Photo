/**
 * Proves the thing tests cannot: that real Telegram gives back exactly the bytes it was given.
 *
 * Sends a few small generated images to your library channel, downloads each one, compares
 * SHA-256 hashes, and deletes them again. Stop the server before running this.
 *
 *   pnpm verify:telegram
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildCaption } from '../src/caption.js';
import { loadConfig } from '../src/config.js';
import { Repo } from '../src/db.js';
import { Paths } from '../src/paths.js';
import { contextFor } from '../src/queue.js';
import { Sealer } from '../src/secrets.js';
import { TelegramStorage } from '../src/storage/telegram.js';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Noise, so every run produces new bytes and nothing can match an earlier upload. */
function noise(width: number, height: number) {
  return sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } });
}

async function samples(): Promise<{ name: string; mime: string; bytes: Buffer; why: string }[]> {
  return [
    { name: 'verify.jpg', mime: 'image/jpeg', bytes: await noise(800, 600).withExif({ IFD0: { Make: 'TelePhotoVerify' } }).jpeg({ quality: 95 }).toBuffer(), why: 'Telegram recompresses JPEGs sent as photos' },
    { name: 'verify.png', mime: 'image/png', bytes: await noise(400, 300).png().toBuffer(), why: 'would become a JPEG if sent as a photo' },
    { name: 'verify.webp', mime: 'image/webp', bytes: await noise(400, 300).webp().toBuffer(), why: 'could be treated as a sticker' },
    { name: 'verify.gif', mime: 'image/gif', bytes: await noise(100, 100).gif().toBuffer(), why: 'could be converted to an MP4' },
    { name: 'verify-big.png', mime: 'image/png', bytes: await noise(2200, 2200).png({ compressionLevel: 1 }).toBuffer(), why: 'over 10 MB, so it uses the big-file call' },
  ];
}

const config = loadConfig();
if (config.storage !== 'telegram') throw new Error('TP_STORAGE is set to "fake", so there is no real Telegram to verify against.');
if (!config.telegramApiId || !config.telegramApiHash) throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.');

new Paths(config.dataDir); // Creates the data folder on a first run.
const repo = new Repo(config.dataDir);
const account = repo.db.prepare('SELECT * FROM accounts WHERE session_sealed IS NOT NULL ORDER BY id LIMIT 1').get() as Parameters<typeof contextFor>[0] | undefined;
if (!account) throw new Error('Nobody is signed in yet. Start the app and sign in once, then run this again.');

const storage = new TelegramStorage(config.telegramApiId, config.telegramApiHash);
const ctx = contextFor(account, new Sealer(config.dataDir));
const dir = mkdtempSync(join(tmpdir(), 'tele-photo-verify-'));
const sent: number[] = [];
let failures = 0;

try {
  for (const sample of await samples()) {
    const path = join(dir, sample.name);
    writeFileSync(path, sample.bytes);
    const hash = sha(sample.bytes);
    const label = `${sample.name.padEnd(16)} ${(sample.bytes.length / 1024 / 1024).toFixed(2).padStart(6)} MB`;
    try {
      const { messageId } = await storage.putPhoto(
        ctx,
        {
          path, filename: sample.name, mime: sample.mime, size: sample.bytes.length,
          caption: `Tele-Photo self-test, safe to delete\n${buildCaption({ filename: sample.name, sha256: hash, takenAt: '2000-01-01T00:00:00', width: null, height: null })}`,
        },
        () => undefined,
      );
      sent.push(messageId);
      const { stream } = await storage.getPhoto(ctx, messageId);
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const back = Buffer.concat(chunks);
      if (sha(back) === hash) {
        console.log(`PASS  ${label}  identical after the round trip (${sample.why})`);
      } else {
        failures++;
        console.log(`FAIL  ${label}  came back different: ${back.length} bytes, sent ${sample.bytes.length}`);
      }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${label}  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
} finally {
  if (sent.length > 0) {
    await storage.deletePhotos(ctx, sent).catch((err) => console.log(`Could not clean up test messages ${sent.join(', ')}: ${err}`));
  }
  await storage.close();
  repo.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll formats came back byte-identical. Telegram storage is working.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
