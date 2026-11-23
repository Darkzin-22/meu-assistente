import path from 'node:path';
import fs from 'node:fs';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { DateTime } from 'luxon';
import { config, ROOT } from './config.js';
import { AppError } from './errors.js';
import * as auth from './auth.js';
import * as fin from './finance.js';
import * as rec from './recurring.js';
import * as ag from './agenda.js';
import * as push from './push.js';
import * as ex from './exporters.js';
import { runCommand, executeAction, aiMode, _engineInfo } from './nlp/execute.js';
import { transcribe, transcriptionAvailable } from './transcribe.js';
import { toCents } from './money.js';
import { today, addDays, isValidZone } from './time.js';
import { audit } from './db.js';

export async function buildApp(db, { logger = false, serveStatic = true } = {}) {
  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  await app.register(rateLimit, { max: 400, timeWindow: '1 minute' });

  // Cabeçalhos de segurança
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    if (!req.url.startsWith('/api/')) {
      reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    }
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err.name === 'ZodError') return reply.code(400).send({ error: 'Dados inválidos.', details: err.issues?.slice(0, 5) });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    console.error(err);
    return reply.code(500).send({ error: 'Erro interno. Tente novamente.' });
  });

  // ---------------------------------------------------------------- autenticação
  // Proteção CSRF: mutações exigem o cabeçalho X-Requested-With (formulários de outros sites não conseguem enviá-lo).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'fetch') {
      return reply.code(403).send({ error: 'Requisição bloqueada.' });
    }
    const open = ['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/register'];
    if (open.includes(req.routeOptions.url) || req.url.startsWith('/api/feed/')) return;
    const user = auth.sessionUser(db, req.cookies[auth.COOKIE]);
    if (!user) return reply.code(401).send({ error: 'Faça login para continuar.', code: 'unauthenticated' });
    req.user = user;
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  app.get('/api/auth/status', async (req) => {
    const user = auth.sessionUser(db, req.cookies[auth.COOKIE]);
    return { needsSetup: auth.userCount(db) === 0, allowSignup: config.allowSignup, user: user ? publicUser(user) : null };
  });

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
  app.post('/api/auth/register', authLimit, async (req, reply) => {
    const user = await auth.register(db, req.body || {});
    const s = auth.createSession(db, user.id, req.headers['user-agent']);
    reply.setCookie(auth.COOKIE, s.token, auth.cookieOptions());
    return { user: publicUser(user) };
  });
  app.post('/api/auth/login', authLimit, async (req, reply) => {
    const user = await auth.login(db, req.body || {});
    const s = auth.createSession(db, user.id, req.headers['user-agent']);
    reply.setCookie(auth.COOKIE, s.token, auth.cookieOptions());
    return { user: publicUser(user) };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    auth.destroySession(db, req.cookies[auth.COOKIE]);
    reply.clearCookie(auth.COOKIE, { path: '/' });
    return { ok: true };
  });
  app.post('/api/auth/password', authLimit, async (req, reply) => {
    await auth.changePassword(db, req.user.id, req.body?.current, req.body?.next);
    const s = auth.createSession(db, req.user.id, req.headers['user-agent']);
    reply.setCookie(auth.COOKIE, s.token, auth.cookieOptions());
    return { ok: true };
  });

  function publicUser(u) {
    return { id: u.id, email: u.email, name: u.name, timezone: u.timezone, settings: { reminders: ag.userReminderConfig(u), ai_mode: u.settings.ai_mode || 'auto', ...u.settings, reminders_effective: ag.userReminderConfig(u) }, feed_token: u.feed_token };
  }

  app.get('/api/me', async (req) => ({
    user: publicUser(req.user),
    capabilities: { claude: _engineInfo().claude, model: _engineInfo().claude ? _engineInfo().model : null, engine: aiMode(req.user), transcription: transcriptionAvailable(), vapidPublicKey: push.vapidKeys().publicKey },
  }));

  app.patch('/api/me', async (req) => {
    const b = req.body || {};
    const u = req.user;
    const settings = { ...u.settings };
    let resync = false;
    if (b.name) db.prepare(`UPDATE users SET name=? WHERE id=?`).run(String(b.name).slice(0, 60), u.id);
    if (b.timezone && b.timezone !== u.timezone) {
      if (!isValidZone(b.timezone)) throw new AppError('Fuso horário inválido.');
      db.prepare(`UPDATE users SET timezone=? WHERE id=?`).run(b.timezone, u.id);
      resync = true;
    }
    if (b.settings) {
      const s = b.settings;
      if (s.ai_mode && ['auto', 'claude', 'local'].includes(s.ai_mode)) settings.ai_mode = s.ai_mode;
      if (s.theme && ['dark', 'light', 'system'].includes(s.theme)) settings.theme = s.theme;
      if (typeof s.charge_notifications === 'boolean') settings.charge_notifications = s.charge_notifications;
      if (typeof s.voice_auto_send === 'boolean') settings.voice_auto_send = s.voice_auto_send;
      if (s.reminders !== undefined) {
        settings.reminders = s.reminders === null ? undefined : validateReminderRules(s.reminders);
        resync = true;
      }
      db.prepare(`UPDATE users SET settings_json=? WHERE id=?`).run(JSON.stringify(settings), u.id);
      audit(db, u.id, 'user', u.id, 'settings', u.settings, settings);
    }
    const fresh = auth.loadUser(db, u.id);
    if (resync) {
      for (const ev of db.prepare(`SELECT id FROM events WHERE user_id=? AND status='scheduled' AND deleted_at IS NULL AND date >= ?`).all(u.id, addDays(today(fresh.timezone), -1))) ag.syncReminders(db, fresh, ev.id);
    }
    return { user: publicUser(fresh) };
  });

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

  // ---------------------------------------------------------------- painel
  app.get('/api/dashboard', async (req) => {
    const u = req.user;
    rec.materializeCharges(db, u);
    const t = today(u.timezone);
    const stats = fin.financeStats(db, u, { forecastFn: (a, b) => rec.forecast(db, u, a, b) });
    const pending = db.prepare(`SELECT ch.*, r.name FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id WHERE ch.user_id=? AND ch.status='pending' ORDER BY ch.due_date`).all(u.id);
    return {
      stats,
      recurring: rec.recurringTotals(db, u),
      upcoming_charges: rec.forecast(db, u, t, addDays(t, 14)).filter((o) => o.status !== 'paid').slice(0, 8),
      pending_charges: pending,
      upcoming_events: ag.upcomingEvents(db, u, 6),
      recent_expenses: fin.listExpenses(db, u.id, { limit: 6 }),
    };
  });

  // ---------------------------------------------------------------- categorias
  app.get('/api/categories', async (req) => ({ expense: fin.listCategories(db, req.user.id, 'expense'), event: fin.listCategories(db, req.user.id, 'event') }));
  app.post('/api/categories', async (req) => fin.createCategory(db, req.user.id, { ...req.body, budget_cents: req.body?.budget != null && req.body.budget !== '' ? toCents(req.body.budget) : null }));
  app.patch('/api/categories/:id', async (req) => {
    const b = { ...req.body };
    if (b.budget !== undefined) b.budget_cents = b.budget === null || b.budget === '' ? null : toCents(b.budget);
    return fin.updateCategory(db, req.user.id, Number(req.params.id), b);
  });
  app.delete('/api/categories/:id', async (req) => fin.deleteCategory(db, req.user.id, Number(req.params.id)));

  // ---------------------------------------------------------------- despesas
  const expFilters = (q) => ({ start: q.start, end: q.end, category_id: q.category_id, q: q.q, min_cents: q.min ? toCents(q.min) : null, max_cents: q.max ? toCents(q.max) : null, order: q.order, limit: q.limit });
  app.get('/api/expenses', async (req) => {
    const list = fin.listExpenses(db, req.user.id, expFilters(req.query));
    return { expenses: list, total_cents: list.reduce((s, e) => s + e.amount_cents, 0) };
  });
  app.get('/api/expenses/trash', async (req) => ({ expenses: fin.listExpenses(db, req.user.id, { deleted: true, limit: 200 }) }));
  app.post('/api/expenses', async (req) => {
    const b = req.body || {};
    return fin.createExpense(db, req.user, { ...b, amount_cents: toCents(b.amount), source: 'manual' });
  });
  app.patch('/api/expenses/:id', async (req) => {
    const b = { ...req.body };
    if (b.amount !== undefined) b.amount_cents = toCents(b.amount);
    return fin.updateExpense(db, req.user, Number(req.params.id), b);
  });
  app.delete('/api/expenses/:id', async (req) => fin.deleteExpense(db, req.user, Number(req.params.id)));
  app.post('/api/expenses/:id/restore', async (req) => fin.restoreExpense(db, req.user, Number(req.params.id)));
  app.delete('/api/expenses/:id/purge', async (req) => fin.purgeExpense(db, req.user, Number(req.params.id)));
  app.get('/api/finance/stats', async (req) => fin.financeStats(db, req.user, { forecastFn: (a, b) => rec.forecast(db, req.user, a, b) }));
  app.get('/api/finance/budgets', async (req) => ({ budgets: fin.budgetStatus(db, req.user) }));

  app.get('/api/export/expenses.csv', async (req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="despesas-${today(req.user.timezone)}.csv"`);
    return ex.expensesCsv(db, req.user.id, expFilters(req.query));
  });
  app.get('/api/export/expenses.xlsx', async (req, reply) => {
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="despesas-${today(req.user.timezone)}.xlsx"`);
    return ex.expensesXlsx(db, req.user.id, expFilters(req.query));
  });

  // ---------------------------------------------------------------- recorrências
  app.get('/api/recurrences', async (req) => {
    rec.materializeCharges(db, req.user);
    return { recurrences: rec.listRecurrences(db, req.user), totals: rec.recurringTotals(db, req.user) };
  });
  const recInput = (b) => ({ ...b, amount_cents: b.amount !== undefined ? toCents(b.amount) : undefined, interval: b.interval !== undefined ? Number(b.interval) : undefined, day_of_month: b.day_of_month ? Number(b.day_of_month) : undefined });
  app.post('/api/recurrences', async (req) => rec.createRecurrence(db, req.user, recInput(req.body || {})));
  app.patch('/api/recurrences/:id', async (req) => rec.updateRecurrence(db, req.user, Number(req.params.id), recInput(req.body || {})));
  app.post('/api/recurrences/:id/status', async (req) => rec.setRecurrenceStatus(db, req.user, Number(req.params.id), req.body?.status));
  app.post('/api/recurrences/:id/pay', async (req) => rec.payRecurrence(db, req.user, Number(req.params.id), { amount_cents: req.body?.amount ? toCents(req.body.amount) : undefined }));
  app.delete('/api/recurrences/:id', async (req) => rec.deleteRecurrence(db, req.user, Number(req.params.id)));
  app.get('/api/recurrences/:id/charges', async (req) => ({ charges: rec.chargeHistory(db, req.user.id, Number(req.params.id)) }));
  app.post('/api/charges/:id/confirm', async (req) => rec.confirmCharge(db, req.user, Number(req.params.id), { amount_cents: req.body?.amount ? toCents(req.body.amount) : undefined }));
  app.post('/api/charges/:id/skip', async (req) => rec.skipCharge(db, req.user, Number(req.params.id)));
  app.get('/api/forecast', async (req) => {
    const t = today(req.user.timezone);
    const start = req.query.start || t;
    const end = req.query.end || DateTime.fromISO(t).endOf('month').toISODate();
    const items = rec.forecast(db, req.user, start, end);
    return { items, total_cents: items.filter((i) => i.status !== 'paid').reduce((s, i) => s + i.amount_cents, 0) };
  });

  // ---------------------------------------------------------------- agenda
  app.get('/api/events', async (req) => ({ events: ag.listEvents(db, req.user.id, { start: req.query.start, end: req.query.end, includeCancelled: req.query.cancelled === '1', q: req.query.q }) }));
  app.get('/api/events/trash', async (req) => ({ events: ag.listEvents(db, req.user.id, { deleted: true }) }));
  app.get('/api/events/:id', async (req) => {
    const e = ag.getEvent(db, req.user.id, Number(req.params.id));
    if (!e) throw new AppError('Compromisso não encontrado.', 404);
    return { event: e, reminders: db.prepare(`SELECT * FROM reminders WHERE event_id=? ORDER BY fire_at`).all(e.id) };
  });
  app.post('/api/events', async (req) => ag.createEvent(db, req.user, { ...req.body, source: 'manual' }));
  app.patch('/api/events/:id', async (req) => ag.updateEvent(db, req.user, Number(req.params.id), req.body || {}));
  app.post('/api/events/:id/cancel', async (req) => ag.cancelEvent(db, req.user, Number(req.params.id)));
  app.post('/api/events/:id/complete', async (req) => ag.updateEvent(db, req.user, Number(req.params.id), { status: 'done' }));
  app.post('/api/events/:id/reopen', async (req) => ag.updateEvent(db, req.user, Number(req.params.id), { status: 'scheduled' }));
  app.delete('/api/events/:id', async (req) => ag.deleteEvent(db, req.user, Number(req.params.id)));
  app.post('/api/events/:id/restore', async (req) => ag.restoreEvent(db, req.user, Number(req.params.id)));
  app.get('/api/events/:id/ics', async (req, reply) => {
    const e = ag.getEvent(db, req.user.id, Number(req.params.id));
    if (!e) throw new AppError('Compromisso não encontrado.', 404);
    const reminders = db.prepare(`SELECT * FROM reminders WHERE event_id=? AND status IN ('pending','sent','sending')`).all(e.id);
    reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Content-Disposition', `attachment; filename="compromisso-${e.id}.ics"`);
    return ex.eventsIcs([e], { remindersByEvent: { [e.id]: reminders } });
  });
  // Feed de calendário (assinável no app Calendário do iPhone). Protegido por token secreto na URL.
  app.get('/api/feed/:token', async (req, reply) => {
    const token = String(req.params.token).replace(/\.ics$/, '');
    const u = db.prepare(`SELECT id FROM users WHERE feed_token=?`).get(token);
    if (!u) return reply.code(404).send('Not found');
    const user = auth.loadUser(db, u.id);
    const events = ag.listEvents(db, user.id, { start: addDays(today(user.timezone), -60) });
    const rem = {};
    for (const r of db.prepare(`SELECT * FROM reminders WHERE user_id=? AND status IN ('pending','sent','sending')`).all(user.id)) (rem[r.event_id] ||= []).push(r);
    reply.header('Content-Type', 'text/calendar; charset=utf-8');
    return ex.eventsIcs(events, { remindersByEvent: rem, name: 'Agenda — Meu Assistente' });
  });

  // ---------------------------------------------------------------- busca global
  app.get('/api/search', async (req) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return { expenses: [], events: [], recurrences: [] };
    return {
      expenses: fin.listExpenses(db, req.user.id, { q, limit: 30 }),
      events: ag.listEvents(db, req.user.id, { q, includeCancelled: true, limit: 30 }),
      recurrences: rec.findRecurrenceByName(db, req.user.id, q, { includeEnded: true }),
    };
  });

  // ---------------------------------------------------------------- comandos (voz e texto)
  app.post('/api/command', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const b = req.body || {};
    return runCommand(db, req.user, b.text, { client_id: b.client_id || null, source: b.source === 'voice' ? 'voice' : 'text' });
  });
  app.post('/api/actions/execute', async (req) => {
    const b = req.body || {};
    if (!b.action?.type) throw new AppError('Ação inválida.');
    return { result: executeAction(db, req.user, b.action, { confirmed: b.confirmed === true, source: b.source || 'text' }) };
  });
  app.post('/api/transcribe', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('Envie o áudio.');
    const buf = await file.toBuffer();
    const hints = [...fin.listCategories(db, req.user.id, 'expense').map((c) => c.name), ...db.prepare(`SELECT name FROM recurrences WHERE user_id=?`).all(req.user.id).map((r) => r.name)];
    const text = await transcribe(buf, file.mimetype, file.filename, hints);
    return { text };
  });

  // ---------------------------------------------------------------- notificações
  app.get('/api/push/key', async () => ({ publicKey: push.vapidKeys().publicKey }));
  app.post('/api/push/subscribe', async (req) => {
    push.saveSubscription(db, req.user.id, req.body?.subscription, req.headers['user-agent']);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    push.removeSubscription(db, req.user.id, req.body?.endpoint);
    return { ok: true };
  });
  app.post('/api/push/test', async (req) => {
    const r = await push.sendToUser(db, req.user.id, { title: 'Notificações ativas ✅', body: 'Você receberá os lembretes dos seus compromissos neste dispositivo.', tag: 'test', url: '/?tab=config' });
    if (!r.devices) throw new AppError('Nenhum dispositivo inscrito. Ative as notificações primeiro.');
    return r;
  });
  app.get('/api/push/status', async (req) => ({
    devices: db.prepare(`SELECT id, user_agent, created_at, last_success_at, last_error FROM push_subscriptions WHERE user_id=?`).all(req.user.id),
    recent: db.prepare(`SELECT r.kind, r.fire_at, r.status, r.sent_at, r.error, r.title FROM reminders r WHERE r.user_id=? AND r.status != 'pending' ORDER BY r.fire_at DESC LIMIT 20`).all(req.user.id),
    pending: db.prepare(`SELECT r.kind, r.fire_at, r.title FROM reminders r WHERE r.user_id=? AND r.status='pending' ORDER BY r.fire_at LIMIT 20`).all(req.user.id),
  }));

  // ---------------------------------------------------------------- histórico, backup
  app.get('/api/audit', async (req) => ({
    entries: db.prepare(`SELECT id, entity, entity_id, action, before_json, after_json, source, created_at FROM audit_log WHERE user_id=? ORDER BY id DESC LIMIT ?`).all(req.user.id, Math.min(Number(req.query.limit) || 100, 500)),
  }));
  app.get('/api/backup', async (req, reply) => {
    reply.header('Content-Disposition', `attachment; filename="backup-assistente-${today(req.user.timezone)}.json"`);
    return ex.exportBackup(db, req.user);
  });
  app.post('/api/restore', async (req) => {
    if (req.body?.confirm !== 'RESTAURAR') throw new AppError('Confirmação ausente.');
    ex.restoreBackup(db, req.user, req.body.data);
    return { ok: true };
  });

  // ---------------------------------------------------------------- front-end (PWA)
  const dist = path.join(ROOT, 'web', 'dist');
  if (serveStatic && fs.existsSync(dist)) {
    await app.register(fastifyStatic, {
      root: dist,
      setHeaders(reply, file) {
        if (file.endsWith('sw.js') || file.endsWith('.html') || file.endsWith('manifest.webmanifest')) reply.header('Cache-Control', 'no-cache');
        else if (file.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Rota não encontrada.' });
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }
  return app;
}
