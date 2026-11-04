import { resolve } from 'node:path';

/**
 * The most a non-Premium account can upload as a single file: 4000 parts of 512 KiB.
 * This is 2,097,152,000 bytes (about 1.95 GiB). Anything larger fails on Telegram's side
 * with FILE_PARTS_INVALID, so we refuse it before doing any work.
 */
export const MAX_PHOTO_BYTES = 4000 * 512 * 1024;

export type StorageKind = 'telegram' | 'fake';

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  webDist: string;
  storage: StorageKind;
  telegramApiId: number | null;
  telegramApiHash: string | null;
  cookieSecure: boolean;
  trashRetentionDays: number;
  allowedPhones: Set<string> | null;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s().-]/g, '');
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // `pnpm --filter` runs the server from server/, so relative paths are anchored at the repo root.
  const root = resolve(import.meta.dirname, '..', '..');
  const storage = env.TP_STORAGE === 'fake' ? 'fake' : 'telegram';
  const apiId = Number.parseInt(env.TELEGRAM_API_ID ?? '', 10);
  const allowed = (env.TP_ALLOWED_PHONES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizePhone);
  const retention = Number.parseInt(env.TP_TRASH_RETENTION_DAYS ?? '', 10);

  return {
    host: env.HOST || '127.0.0.1',
    port: Number.parseInt(env.PORT ?? '', 10) || 8787,
    dataDir: resolve(root, env.TP_DATA_DIR || './data'),
    webDist: resolve(root, 'web', 'dist'),
    storage,
    telegramApiId: Number.isFinite(apiId) && apiId > 0 ? apiId : null,
    telegramApiHash: env.TELEGRAM_API_HASH?.trim() || null,
    cookieSecure: env.TP_COOKIE_SECURE === 'true',
    trashRetentionDays: Number.isFinite(retention) && retention > 0 ? retention : 30,
    allowedPhones: allowed.length > 0 ? new Set(allowed) : null,
  };
}
