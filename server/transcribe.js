import { config } from './config.js';
import { AppError } from './errors.js';

// Transcrição de áudio no servidor (opcional). A chave fica só no servidor.
// Groq: Whisper large-v3-turbo (muito barato, com cota gratuita). OpenAI: gpt-4o-mini-transcribe.

export function transcriptionAvailable() {
  return Boolean(config.groqKey || config.openaiKey);
}

export async function transcribe(buffer, mimetype, filename, hints = []) {
  if (!transcriptionAvailable()) throw new AppError('Transcrição no servidor não configurada. Use o reconhecimento de voz do aparelho.', 501, 'no_transcription');
  if (!buffer?.length) throw new AppError('Áudio vazio.');
  const useGroq = Boolean(config.groqKey);
  const url = useGroq ? 'https://api.groq.com/openai/v1/audio/transcriptions' : 'https://api.openai.com/v1/audio/transcriptions';
  const model = config.transcribeModel || (useGroq ? 'whisper-large-v3-turbo' : 'gpt-4o-mini-transcribe');
  const ext = /mp4|m4a|aac/.test(mimetype) ? 'mp4' : /ogg/.test(mimetype) ? 'ogg' : /wav/.test(mimetype) ? 'wav' : /mpeg|mp3/.test(mimetype) ? 'mp3' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/webm' }), filename || `audio.${ext}`);
  form.append('model', model);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  // Dica de vocabulário: melhora nomes como "Netflix", "açaí", categorias e assinaturas cadastradas.
  form.append('prompt', `Comandos de finanças e agenda em português do Brasil. Valores em reais. ${hints.slice(0, 40).join(', ')}.`.slice(0, 800));
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${useGroq ? config.groqKey : config.openaiKey}` }, body: form, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('transcrição falhou', res.status, body.slice(0, 300));
    throw new AppError('Falha na transcrição do áudio. Tente novamente ou digite o comando.', 502, 'transcription_failed');
  }
  const data = await res.json();
  return String(data.text || '').trim();
}
