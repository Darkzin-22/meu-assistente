import { config } from './config.js';
import { openDb } from './db.js';
import { buildApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { vapidKeys } from './push.js';
import { claudeAvailable } from './nlp/llm.js';
import { transcriptionAvailable } from './transcribe.js';

const db = openDb();
vapidKeys();
const app = await buildApp(db, { logger: { level: process.env.LOG_LEVEL || 'warn' } });
await app.listen({ port: config.port, host: config.host });
startScheduler(db, config.schedulerIntervalMs);

console.log(`Meu Assistente rodando em http://localhost:${config.port}`);
console.log(`  IA (Claude): ${claudeAvailable() ? `ativa (${config.claudeModel})` : 'desativada — usando interpretador local'}`);
console.log(`  Transcrição no servidor: ${transcriptionAvailable() ? 'ativa' : 'desativada — usando reconhecimento de voz do aparelho'}`);
console.log(`  Dados em: ${config.dataDir}`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    db.close();
    process.exit(0);
  });
}
