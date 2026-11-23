// "Servidor de bolso": responde às mesmas rotas da API, mas dentro do navegador,
// usando exatamente as mesmas funções de negócio do servidor (server/*.js).
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { openLocalDb } from './sqlite.js';
import { seedCategories, audit } from '../../../server/db-util.js';
import { AppError } from '../../../server/errors.js';
import * as fin from '../../../server/finance.js';
import * as rec from '../../../server/recurring.js';
import * as ag from '../../../server/agenda.js';
import * as ex from '../../../server/exporters.js';
import { runCommand, executeAction } from '../../../server/nlp/execute.js';
import { toCents } from '../../../server/money.js';
import { today, addDays, isValidZone, nowUtcIso } from '../../../server/time.js';

const USER_ID = 1;

function loadUser(db) {
  const u = db.prepare(`SELECT id, email, name, timezone, settings_json, feed_token, created_at FROM users WHERE id=?`).get(USER_ID);
  if (!u) return null;
  let settings = {};
  try { settings = JSON.parse(u.settings_json || '{}'); } catch { /* vazio */ }
  delete u.settings_json;
  return { ...u, settings };
}

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, timezone: u.timezone, settings: { ai_mode: 'local', ...u.settings, reminders_effective: ag.userReminderConfig(u) }, feed_token: null };
}

const download = (filename, mime, content) => ({ __download: { filename, mime, content } });

function validateReminderRules(rules) {
  if (!Array.isArray(rules) || rules.length > 10) throw new AppError('Configuração de lembretes inválida.');
  return rules.map((r, i) => {
    const kind = String(r.kind || `r${i}`).replace(/[^a-z0-9]/gi, '').slice(0, 10) || `r${i}`;
    if (r.type === 'days') {
      const days = Number(r.days);
      if (!Number.isInteger(days) || days < 0 || days > 60 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '')) throw new AppError('Lembrete inválido.');
      return { kind, type: 'days', days, time: r.time, enabled: r.enabled !== false };
    }
    const minutes = Number(r.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 1440) throw new AppError('Lembrete inválido.');
    return { kind, type: 'minutes', minutes, enabled: r.enabled !== false };
  });
}

const expFilters = (q) => ({ start: q.start, end: q.end, category_id: q.category_id, q: q.q, min_cents: q.min ? toCents(q.min) : null, max_cents: q.max ? toCents(q.max) : null, order: q.order, limit: q.limit });
const recInput = (b) => ({ ...b, amount_cents: b.amount !== undefined ? toCents(b.amount) : undefined, interval: b.interval !== undefined ? Number(b.interval) : undefined, day_of_month: b.day_of_month ? Number(b.day_of_month) : undefined });

// Rotas: [método, padrão, handler(ctx)] — ctx = { db, user, params, query, body }
const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn]);

on('GET', '/api/health', () => ({ ok: true }));
on('GET', '/api/auth/status', ({ user }) => ({ needsSetup: !user, allowSignup: false, local: true, user: user ? publicUser(user) : null }));
on('POST', '/api/auth/register', ({ db, body }) => {
  if (loadUser(db)) throw new AppError('Já configurado.');
  const tz = body.timezone && isValidZone(body.timezone) ? body.timezone : 'America/Sao_Paulo';
  db.prepare(`INSERT INTO users (id, email, name, password_hash, timezone, feed_token, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(USER_ID, 'aparelho@local', String(body.name || '').trim().slice(0, 60) || 'Você', '-', tz, crypto.randomUUID(), nowUtcIso());
  seedCategories(db, USER_ID);
  return { user: publicUser(loadUser(db)) };
});
on('POST', '/api/auth/logout', () => ({ ok: true }));

on('GET', '/api/me', ({ user }) => ({
  user: publicUser(user),
  capabilities: { local: true, claude: false, model: null, engine: 'local', transcription: false, vapidPublicKey: null },
}));
on('PATCH', '/api/me', ({ db, user, body }) => {
  const settings = { ...user.settings };
  let resync = false;
  if (body.name) db.prepare(`UPDATE users SET name=? WHERE id=?`).run(String(body.name).slice(0, 60), USER_ID);
  if (body.timezone && body.timezone !== user.timezone) {
    if (!isValidZone(body.timezone)) throw new AppError('Fuso horário inválido.');
    db.prepare(`UPDATE users SET timezone=? WHERE id=?`).run(body.timezone, USER_ID);
    resync = true;
  }
  if (body.settings) {
    const s = body.settings;
    if (s.theme && ['dark', 'light', 'system'].includes(s.theme)) settings.theme = s.theme;
    if (typeof s.voice_auto_send === 'boolean') settings.voice_auto_send = s.voice_auto_send;
    if (typeof s.calendar_prompt === 'boolean') settings.calendar_prompt = s.calendar_prompt;
    if (s.reminders !== undefined) { settings.reminders = s.reminders === null ? undefined : validateReminderRules(s.reminders); resync = true; }
    db.prepare(`UPDATE users SET settings_json=? WHERE id=?`).run(JSON.stringify(settings), USER_ID);
    audit(db, USER_ID, 'user', USER_ID, 'settings', user.settings, settings);
  }
  const fresh = loadUser(db);
  if (resync) for (const ev of db.prepare(`SELECT id FROM events WHERE user_id=? AND status='scheduled' AND deleted_at IS NULL AND date >= ?`).all(USER_ID, addDays(today(fresh.timezone), -1))) ag.syncReminders(db, fresh, ev.id);
  return { user: publicUser(fresh) };
});

on('GET', '/api/dashboard', ({ db, user }) => {
  rec.materializeCharges(db, user);
  const t = today(user.timezone);
  return {
    stats: fin.financeStats(db, user, { forecastFn: (a, b) => rec.forecast(db, user, a, b) }),
    recurring: rec.recurringTotals(db, user),
    upcoming_charges: rec.forecast(db, user, t, addDays(t, 14)).filter((o) => o.status !== 'paid').slice(0, 8),
    pending_charges: db.prepare(`SELECT ch.*, r.name FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id WHERE ch.user_id=? AND ch.status='pending' ORDER BY ch.due_date`).all(USER_ID),
    upcoming_events: ag.upcomingEvents(db, user, 6),
    recent_expenses: fin.listExpenses(db, USER_ID, { limit: 6 }),
  };
});

on('GET', '/api/categories', ({ db }) => ({ expense: fin.listCategories(db, USER_ID, 'expense'), event: fin.listCategories(db, USER_ID, 'event') }));
on('POST', '/api/categories', ({ db, body }) => fin.createCategory(db, USER_ID, { ...body, budget_cents: body.budget != null && body.budget !== '' ? toCents(body.budget) : null }));
on('PATCH', '/api/categories/:id', ({ db, params, body }) => {
  const b = { ...body };
  if (b.budget !== undefined) b.budget_cents = b.budget === null || b.budget === '' ? null : toCents(b.budget);
  return fin.updateCategory(db, USER_ID, Number(params.id), b);
});
on('DELETE', '/api/categories/:id', ({ db, params }) => fin.deleteCategory(db, USER_ID, Number(params.id)));

on('GET', '/api/expenses', ({ db, query }) => {
  const list = fin.listExpenses(db, USER_ID, expFilters(query));
  return { expenses: list, total_cents: list.reduce((s, e) => s + e.amount_cents, 0) };
});
on('GET', '/api/expenses/trash', ({ db }) => ({ expenses: fin.listExpenses(db, USER_ID, { deleted: true, limit: 200 }) }));
on('POST', '/api/expenses', ({ db, user, body }) => fin.createExpense(db, user, { ...body, amount_cents: toCents(body.amount), source: 'manual' }));
on('PATCH', '/api/expenses/:id', ({ db, user, params, body }) => {
  const b = { ...body };
  if (b.amount !== undefined) b.amount_cents = toCents(b.amount);
  return fin.updateExpense(db, user, Number(params.id), b);
});
on('DELETE', '/api/expenses/:id', ({ db, user, params }) => fin.deleteExpense(db, user, Number(params.id)));
on('POST', '/api/expenses/:id/restore', ({ db, user, params }) => fin.restoreExpense(db, user, Number(params.id)));
on('DELETE', '/api/expenses/:id/purge', ({ db, user, params }) => fin.purgeExpense(db, user, Number(params.id)));
on('GET', '/api/finance/stats', ({ db, user }) => fin.financeStats(db, user, { forecastFn: (a, b) => rec.forecast(db, user, a, b) }));
on('GET', '/api/export/expenses.csv', ({ db, user, query }) => download(`despesas-${today(user.timezone)}.csv`, 'text/csv;charset=utf-8', ex.expensesCsv(db, USER_ID, expFilters(query))));

on('GET', '/api/recurrences', ({ db, user }) => { rec.materializeCharges(db, user); return { recurrences: rec.listRecurrences(db, user), totals: rec.recurringTotals(db, user) }; });
on('POST', '/api/recurrences', ({ db, user, body }) => rec.createRecurrence(db, user, recInput(body)));
on('PATCH', '/api/recurrences/:id', ({ db, user, params, body }) => rec.updateRecurrence(db, user, Number(params.id), recInput(body)));
on('POST', '/api/recurrences/:id/status', ({ db, user, params, body }) => rec.setRecurrenceStatus(db, user, Number(params.id), body.status));
on('POST', '/api/recurrences/:id/pay', ({ db, user, params, body }) => rec.payRecurrence(db, user, Number(params.id), { amount_cents: body.amount ? toCents(body.amount) : undefined }));
on('DELETE', '/api/recurrences/:id', ({ db, user, params }) => rec.deleteRecurrence(db, user, Number(params.id)));
on('GET', '/api/recurrences/:id/charges', ({ db, params }) => ({ charges: rec.chargeHistory(db, USER_ID, Number(params.id)) }));
on('POST', '/api/charges/:id/confirm', ({ db, user, params, body }) => rec.confirmCharge(db, user, Number(params.id), { amount_cents: body.amount ? toCents(body.amount) : undefined }));
on('POST', '/api/charges/:id/skip', ({ db, user, params }) => rec.skipCharge(db, user, Number(params.id)));
on('GET', '/api/forecast', ({ db, user, query }) => {
  const t = today(user.timezone);
  const items = rec.forecast(db, user, query.start || t, query.end || DateTime.fromISO(t).endOf('month').toISODate());
  return { items, total_cents: items.filter((i) => i.status !== 'paid').reduce((s, i) => s + i.amount_cents, 0) };
});

on('GET', '/api/events', ({ db, query }) => ({ events: ag.listEvents(db, USER_ID, { start: query.start, end: query.end, includeCancelled: query.cancelled === '1', q: query.q }) }));
on('GET', '/api/events/trash', ({ db }) => ({ events: ag.listEvents(db, USER_ID, { deleted: true }) }));
on('GET', '/api/events/:id/ics', ({ db, params }) => {
  const e = ag.getEvent(db, USER_ID, Number(params.id));
  if (!e) throw new AppError('Compromisso não encontrado.', 404);
  return download(`compromisso-${e.id}.ics`, 'text/calendar;charset=utf-8', ex.eventsIcs([e], { remindersByEvent: { [e.id]: icsAlarms(db, e) } }));
});
on('GET', '/api/events/:id', ({ db, params }) => {
  const e = ag.getEvent(db, USER_ID, Number(params.id));
  if (!e) throw new AppError('Compromisso não encontrado.', 404);
  return { event: e, reminders: db.prepare(`SELECT * FROM reminders WHERE event_id=? ORDER BY fire_at`).all(e.id) };
});
on('POST', '/api/events', ({ db, user, body }) => ag.createEvent(db, user, { ...body, source: 'manual' }));
on('PATCH', '/api/events/:id', ({ db, user, params, body }) => ag.updateEvent(db, user, Number(params.id), body));
on('POST', '/api/events/:id/cancel', ({ db, user, params }) => ag.cancelEvent(db, user, Number(params.id)));
on('POST', '/api/events/:id/complete', ({ db, user, params }) => ag.updateEvent(db, user, Number(params.id), { status: 'done' }));
on('POST', '/api/events/:id/reopen', ({ db, user, params }) => ag.updateEvent(db, user, Number(params.id), { status: 'scheduled' }));
on('DELETE', '/api/events/:id', ({ db, user, params }) => ag.deleteEvent(db, user, Number(params.id)));
on('POST', '/api/events/:id/restore', ({ db, user, params }) => ag.restoreEvent(db, user, Number(params.id)));

on('GET', '/api/search', ({ db, query }) => {
  const q = String(query.q || '').trim();
  if (q.length < 2) return { expenses: [], events: [], recurrences: [] };
  return { expenses: fin.listExpenses(db, USER_ID, { q, limit: 30 }), events: ag.listEvents(db, USER_ID, { q, includeCancelled: true, limit: 30 }), recurrences: rec.findRecurrenceByName(db, USER_ID, q, { includeEnded: true }) };
});

on('POST', '/api/command', ({ db, user, body }) => runCommand(db, user, body.text, { client_id: body.client_id || null, source: body.source === 'voice' ? 'voice' : 'text' }));
on('POST', '/api/actions/execute', ({ db, user, body }) => {
  if (!body.action?.type) throw new AppError('Ação inválida.');
  return { result: executeAction(db, user, body.action, { confirmed: body.confirmed === true, source: body.source || 'text' }) };
});

on('GET', '/api/audit', ({ db, query }) => ({ entries: db.prepare(`SELECT id, entity, entity_id, action, before_json, after_json, source, created_at FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT ?`).all(USER_ID, Math.min(Number(query.limit) || 100, 500)) }));
on('GET', '/api/backup', ({ db, user }) => download(`backup-assistente-${today(user.timezone)}.json`, 'application/json', JSON.stringify(ex.exportBackup(db, user), null, 1)));
on('POST', '/api/restore', ({ db, user, body }) => {
  if (body.confirm !== 'RESTAURAR') throw new AppError('Confirmação ausente.');
  ex.restoreBackup(db, user, body.data);
  return { ok: true };
});

/** Alarmes do .ics: todos os lembretes configurados que ainda estão no futuro. */
function icsAlarms(db, e) {
  return db.prepare(`SELECT * FROM reminders WHERE event_id=? AND status IN ('pending','sent','sending')`).all(e.id);
}

export async function handle(method, url, body) {
  const db = await openLocalDb();
  const u = new URL(url, 'http://local');
  const user = loadUser(db);
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const match = re.exec(u.pathname);
    if (!match) continue;
    const open = ['/api/health', '/api/auth/status', '/api/auth/register'].includes(u.pathname);
    if (!user && !open) throw Object.assign(new Error('Configure o app primeiro.'), { status: 401 });
    try {
      const result = await fn({ db, user, params: match.groups || {}, query: Object.fromEntries(u.searchParams), body: body || {} });
      if (method !== 'GET' || db.dirty) await db.save();
      return result;
    } catch (err) {
      if (err instanceof AppError) throw Object.assign(new Error(err.message), { status: err.status, data: { error: err.message, code: err.code } });
      if (err?.name === 'ZodError') throw Object.assign(new Error('Dados inválidos.'), { status: 400 });
      console.error(err);
      throw Object.assign(new Error('Erro interno. Tente novamente.'), { status: 500 });
    }
  }
  throw Object.assign(new Error('Função indisponível nesta versão.'), { status: 404 });
}
