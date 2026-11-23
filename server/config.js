import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

// Carrega um arquivo .env simples (sem dependências) se existir.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
  publicUrl: env.PUBLIC_URL || '',
  defaultTimezone: env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
  allowSignup: env.ALLOW_SIGNUP === 'true',
  // IA (Claude) — chave fica só no servidor, nunca vai para o navegador.
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  claudeModel: env.AI_MODEL || 'claude-opus-5-5',
  claudeEffort: env.AI_EFFORT || 'low',
  // Transcrição de áudio (opcional): Groq (barato/gratuito) ou OpenAI.
  groqKey: env.GROQ_API_KEY || '',
  openaiKey: env.OPENAI_API_KEY || '',
  transcribeModel: env.TRANSCRIBE_MODEL || '',
  vapidSubject: env.VAPID_SUBJECT || 'mailto:admin@localhost',
  schedulerIntervalMs: Number(env.SCHEDULER_INTERVAL_MS || 20000),
  isTest: env.NODE_ENV === 'test',
  secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === 'true' : env.NODE_ENV === 'production',
};

fs.mkdirSync(config.dataDir, { recursive: true });
