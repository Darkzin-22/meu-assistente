// Jarvis: canal de voz usado pelo atalho da Siri ("E aí Siri, Jarvis").
// Recebe o texto ditado, executa com as mesmas regras do app e devolve uma resposta curta para ser falada.
// Mantém uma "pendência" por usuário por alguns minutos para entender respostas como "sim", "o segundo" ou "às 3 da tarde".
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { AppError } from './errors.js';
import { norm } from './categories.js';
import { nowUtcIso, now } from './time.js';
import { runCommand, executeAction } from './nlp/execute.js';
import { _internals as P } from './nlp/parse-local.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PENDING_TTL_MS = 3 * 60 * 1000;
const pending = new Map(); // userId -> { result, at }

// ---------------------------------------------------------------- chaves de acesso
/** Cria (ou troca) a chave do Jarvis. A chave só é mostrada uma vez; guardamos apenas o hash. */
export function createToken(db, userId) {
  const token = `jv_${crypto.randomBytes(24).toString('base64url')}`;
  db.transaction(() => {
    db.prepare(`DELETE FROM api_tokens WHERE user_id=? AND name='jarvis'`).run(userId);
    db.prepare(`INSERT INTO api_tokens (token_hash, user_id, name, created_at) VALUES (?,?,?,?)`).run(sha256(token), userId, 'jarvis', nowUtcIso());
  })();
  return token;
}
export function revokeToken(db, userId) {
  db.prepare(`DELETE FROM api_tokens WHERE user_id=? AND name='jarvis'`).run(userId);
}
export function tokenStatus(db, userId) {
  const t = db.prepare(`SELECT created_at, last_used_at FROM api_tokens WHERE user_id=? AND name='jarvis'`).get(userId);
  return t ? { active: true, ...t } : { active: false };
}
export function userIdFromToken(db, header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header || '');
  if (!m) return null;
  const row = db.prepare(`SELECT user_id FROM api_tokens WHERE token_hash=?`).get(sha256(m[1]));
  if (!row) return null;
  db.prepare(`UPDATE api_tokens SET last_used_at=? WHERE token_hash=?`).run(nowUtcIso(), sha256(m[1]));
  return row.user_id;
}

// ---------------------------------------------------------------- texto para fala
/** Deixa a mensagem boa para ser lida em voz alta pela Siri. */
export function toSpeech(message) {
  return String(message || '')
    .split('\n')
    .map((l) => l.replace(/^•\s*/, '').trim())
    .filter(Boolean)
    .map((l) => (/[.!?:]$/.test(l) ? l : `${l}.`))
    .join(' ')
    .replace(/\s—\s/g, ', ')
    .replace(/\s*\(([^)]*)\)/g, ', $1')
    .replace(/,\s*([.,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const YES = /^(sim|s|confirmo|confirma|confirmar|pode|pode sim|isso|isso mesmo|ok|okay|claro|manda|com certeza|pode apagar|pode cancelar|pode desmarcar|positivo|exato)\b/;
const NO = /^(nao|n|cancela|cancelar|deixa|deixa pra la|esquece|negativo|nada)\b/;
const ORDINALS = [/\b(primeir[oa]|1|um|uma)\b/, /\b(segund[oa]|2|dois|duas)\b/, /\b(terceir[oa]|3|tres)\b/, /\b(quart[oa]|4|quatro)\b/, /\b(quint[oa]|5|cinco)\b/];

/** Tenta usar a fala como resposta à pergunta pendente. Retorna null se não for uma resposta. */
function answerPending(db, user, text, p) {
  const n = norm(text).replace(/[.!?,]/g, '').trim();
  const r = p.result;
  if (r.type === 'confirm') {
    if (YES.test(n)) return executeAction(db, user, r.action, { confirmed: true, source: 'voice' });
    if (NO.test(n)) return { type: 'answer', message: 'Tudo bem, não alterei nada.' };
    return null;
  }
  if (r.type === 'choose') {
    if (NO.test(n)) return { type: 'answer', message: 'Tudo bem, não alterei nada.' };
    let idx = ORDINALS.findIndex((re) => re.test(n));
    if (idx < 0) {
      // Escolha por palavras do nome ("o do dentista")
      const words = n.split(/\s+/).filter((w) => w.length > 3);
      idx = r.options.findIndex((o) => words.some((w) => norm(o.label).includes(w)));
    }
    if (idx < 0 || idx >= r.options.length) return null;
    return executeAction(db, user, r.options[idx].action, { source: 'voice' });
  }
  if (r.type === 'needs_input') {
    if (NO.test(n)) return { type: 'answer', message: 'Tudo bem, cancelei.' };
    const tz = user.timezone;
    const today = now(tz).startOf('day');
    const t = new P.Txt(text);
    P.convertNumberWords(t);
    const draft = { ...r.draft };
    const isChanges = draft.type === 'update_event' || draft.type === 'update_recurrence' || draft.type === 'update_expense';
    const set = (k, v) => { if (isChanges) draft.changes = { ...(draft.changes || {}), [k]: v }; else draft[k] = v; };
    let filled = 0;
    for (const f of r.missing) {
      if (f === 'time') { const v = P.extractTime(t.clone()) || bareHour(t.n); if (v) { set('time', v); filled++; } }
      else if (f === 'date') { const v = P.extractDate(t.clone(), today, 'future'); if (v) { set('date', v); filled++; } }
      else if (f === 'amount') { const m = P.findMoney(t.n)[0]; const v = m ? m.value : Number((/(\d+(?:[.,]\d{1,2})?)/.exec(t.n) || [])[1]?.replace(',', '.')); if (v > 0) { set('amount', v); filled++; } }
      else if (f === 'day_of_month') { const v = Number((/(\d{1,2})/.exec(t.n) || [])[1]); if (v >= 1 && v <= 31) { set('day_of_month', v); filled++; } }
      else if (f === 'changes') {
        const d = P.extractDate(t.clone(), today, 'future'); const tm = P.extractTime(t.clone());
        if (d) { set('date', d); filled++; } if (tm) { set('time', tm); filled++; }
        const m = P.findMoney(t.n)[0]; if (m && !d && !tm) { set('amount', m.value); filled++; }
      } else if (['name', 'title', 'description'].includes(f)) { set(f, text.trim().replace(/[.!?]+$/, '')); filled++; }
    }
    if (!filled) return null;
    draft.missing = null;
    return executeAction(db, user, draft, { source: 'voice' });
  }
  return null;
}

/** "às 3" já é tratado pelo interpretador; aqui aceitamos só "15" ou "15 e 30" como resposta curta. */
function bareHour(n) {
  const m = /^\s*(\d{1,2})(?:\s*(?:e|:)\s*(\d{2}))?\s*$/.exec(n);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : null;
}

function speechFor(result) {
  if (result.type === 'confirm') return `${result.message} Diga sim ou não.`;
  if (result.type === 'choose') return `${result.message} ${result.options.slice(0, 5).map((o, i) => `${['Primeiro', 'Segundo', 'Terceiro', 'Quarto', 'Quinto'][i]}: ${o.label}.`).join(' ')}`;
  let msg = result.message || '';
  if (result.warnings?.length) msg += `\n${result.warnings.join('\n')}`;
  return msg;
}

/**
 * Processa uma fala. Retorna:
 *   resposta   — texto para a Siri falar
 *   entendeu   — false quando não é um comando do assistente (o atalho então usa a IA da Apple)
 *   aguardando — true quando o Jarvis fez uma pergunta e espera a próxima fala
 */
export async function handleUtterance(db, user, text) {
  text = String(text || '').trim();
  if (!text) throw new AppError('Não ouvi nada.');
  // Remove "Jarvis," do começo, se a pessoa falar o nome de novo.
  text = text.replace(/^\s*(ok\s+|ei\s+|e ai\s+|e aí\s+)?jarvis[,.!\s]*/i, '').trim() || text;

  let results = null;
  const p = pending.get(user.id);
  if (p && Date.now() - p.at < PENDING_TTL_MS) {
    try {
      const r = answerPending(db, user, text, p);
      if (r) results = [r];
    } catch (err) {
      results = [{ type: 'error', message: err instanceof AppError ? err.message : 'Não consegui concluir.' }];
    }
  }
  pending.delete(user.id);
  if (!results) {
    const resp = await runCommand(db, user, text, { source: 'voice' });
    results = resp.results;
  }

  const understood = results.some((r) => r.type !== 'clarify');
  const waiting = results.find((r) => ['confirm', 'choose', 'needs_input'].includes(r.type));
  if (waiting) pending.set(user.id, { result: waiting, at: Date.now() });
  const speech = toSpeech(results.filter((r) => r.type !== 'clarify' || !understood).map(speechFor).join('\n'));
  return {
    resposta: understood ? speech : '',
    entendeu: understood,
    aguardando: Boolean(waiting),
    // Campos em texto (mais fáceis de comparar no app Atalhos):
    modo: understood ? 'assistente' : 'pergunta_geral',
    continuar: waiting ? 'sim' : 'nao',
    texto: text,
    hora: DateTime.now().setZone(user.timezone).toFormat('HH:mm'),
  };
}

export function clearPending(userId) {
  pending.delete(userId);
}
