import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, ctx } = await buildApp(config, undefined, { logger: true });

await ctx.queue.start();
ctx.library.startPurgeTimer();
await app.listen({ host: config.host, port: config.port });

if (config.storage === 'fake') {
  app.log.warn('TP_STORAGE=fake: photos stay on this disk and are NOT sent to Telegram.');
} else if (!config.telegramApiId || !config.telegramApiHash) {
  app.log.warn('TELEGRAM_API_ID and TELEGRAM_API_HASH are not set. Sign-in will not work until you add them to .env.');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
