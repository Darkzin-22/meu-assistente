import { DateTime } from 'luxon';
import { audit } from './db-util.js';
import { AppError, notFound } from './errors.js';
import { categoryIdOrDefault } from './finance.js';
import { classifyEvent, iconForEvent, norm } from './categories.js';
import { now, nowUtcIso, today, isValidDate, isValidTime, localToUtc } from './time.js';

/** Lembretes padrão pedidos: 5 dias antes às 10h, 1 dia antes às 10h, 2h antes e 10 min antes. */
export const DEFAULT_REMINDERS = [
  { kind: 'd5', type: 'days', days: 5, time: '10:00', enabled: true },
  { kind: 'd1', type: 'days', days: 1, time: '10:00', enabled: true },
  { kind: 'h2', type: 'minutes', minutes: 120, enabled: true },
  { kind: 'm10', type: 'minutes', minutes: 10, enabled: true },
];

const SHORT_MSG = {
  d5: 'Organize-se com antecedência.',
  d1: 'Não esqueça!',
  h2: 'Hora de começar a se preparar.',
  m10: 'Está quase na hora!',
};

export function userReminderConfig(user) {
  const s = user.settings || {};
  return Array.isArray(s.reminders) && s.reminders.length ? s.reminders : DEFAULT_REMINDERS;
}

function relLabel(rule) {
  if (rule.type === 'days') return rule.days === 1 ? 'É amanhã' : rule.days === 0 ? 'É hoje' : `Daqui a ${rule.days} dias`;
  const m = rule.minutes;
  if (m % 60 === 0) return m === 60 ? 'Em 1 hora' : `Em ${m / 60} horas`;
  return `Em ${m} minutos`;
}

/**
 * Calcula os horários dos lembretes de um compromisso.
 * Só devolve lembretes no futuro (se o compromisso for criado depois de algum horário, ele é pulado).
 */
export function computeReminders(event, rules, nowDt = now()) {
  const tz = event.timezone;
  const start = DateTime.fromISO(`${event.date}T${event.time || '00:00'}`, { zone: tz });
  const when = start.setLocale('pt-BR').toFormat("ccc dd/LL") + (event.time ? ` às ${event.time.replace(':', 'h')}` : ' (dia inteiro)');
  const out = [];
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    let fire;
    if (rule.type === 'days') {
      const [h, m] = String(rule.time || '10:00').split(':').map(Number);
      fire = start.startOf('day').minus({ days: rule.days }).set({ hour: h, minute: m });
      // Para lembretes "no dia" de um compromisso cedo, não avisar depois do início.
      if (event.time && fire >= start) continue;
    } else {
      if (!event.time) continue; // dia inteiro: lembretes relativos a horário não se aplicam
      fire = start.minus({ minutes: rule.minutes });
    }
    if (fire <= nowDt) continue;
    out.push({
      kind: rule.kind,
      fire_at: fire.toUTC().toISO(),
      title: event.title,
      body: `${relLabel(rule)} — ${when}. ${SHORT_MSG[rule.kind] || ''}`.trim(),
    });
  }
  return out;
}

/** Recria os lembretes pendentes do compromisso (chamado ao criar, editar, remarcar, cancelar). */
export function syncReminders(db, user, eventId) {
  const ev = db.prepare(`SELECT * FROM events WHERE id=?`).get(eventId);
  db.transaction(() => {
    db.prepare(`DELETE FROM reminders WHERE event_id=? AND status IN ('pending','failed','cancelled','missed')`).run(eventId);
    if (!ev || ev.deleted_at || ev.status !== 'scheduled') return;
    const ins = db.prepare(`INSERT OR IGNORE INTO reminders (user_id, event_id, kind, fire_at, title, body) VALUES (?,?,?,?,?,?)`);
    for (const r of computeReminders(ev, userReminderConfig(user))) ins.run(user.id, eventId, r.kind, r.fire_at, r.title, r.body);
  })();
  return db.prepare(`SELECT * FROM reminders WHERE event_id=? ORDER BY fire_at`).all(eventId);
}

const EV_SELECT = `
  SELECT ev.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
  FROM events ev LEFT JOIN categories c ON c.id = ev.category_id`;

export function getEvent(db, userId, id) {
  return db.prepare(`${EV_SELECT} WHERE ev.id=? AND ev.user_id=?`).get(id, userId) || null;
}

function validateEvent(e) {
  if (!e.title || !String(e.title).trim()) throw new AppError('Informe o nome do compromisso.');
  if (!isValidDate(e.date)) throw new AppError('Data do compromisso inválida.');
  if (e.time !== null && e.time !== undefined && !isValidTime(e.time)) throw new AppError('Horário inválido (use HH:mm).');
  if (e.image && String(e.image).length > 400_000) throw new AppError('Imagem muito grande.');
}

export function createEvent(db, user, input) {
  const tz = input.timezone || user.timezone;
  const title = String(input.title || '').trim();
  const e = {
    title: title ? title[0].toUpperCase() + title.slice(1) : '',
    date: input.date,
    time: input.time || null,
    duration_min: Number(input.duration_min) || 60,
    timezone: tz,
    category_id: input.category_id ?? categoryIdOrDefault(db, user.id, 'event', input.category || classifyEvent(title)),
    icon: input.icon || iconForEvent(title) || null,
    image: input.image || null,
    location: input.location || null,
    notes: input.notes || null,
    source: input.source || 'manual',
    client_id: input.client_id || null,
  };
  validateEvent(e);
  if (e.client_id) {
    const prev = db.prepare(`SELECT id FROM events WHERE user_id=? AND client_id=?`).get(user.id, e.client_id);
    if (prev) return { event: getEvent(db, user.id, prev.id), duplicate: true, warnings: [] };
  }
  const warnings = [];
  const start = localToUtc(e.date, e.time, tz);
  if (DateTime.fromISO(start) < now().minus({ minutes: 1 })) warnings.push('Atenção: este compromisso está no passado; nenhum lembrete foi programado.');
  const dup = db.prepare(`SELECT id FROM events WHERE user_id=? AND deleted_at IS NULL AND status='scheduled' AND date=? AND IFNULL(time,'')=IFNULL(?, '') AND lower(title)=lower(?)`).get(user.id, e.date, e.time, e.title);
  if (dup) warnings.push('Já existe um compromisso igual neste dia e horário.');
  const ts = nowUtcIso();
  const id = db.prepare(`INSERT INTO events (user_id, title, date, time, duration_min, start_utc, timezone, category_id, icon, image, location, notes, source, client_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, e.title, e.date, e.time, e.duration_min, start, tz, e.category_id, e.icon, e.image, e.location, e.notes, e.source, e.client_id, ts, ts).lastInsertRowid;
  audit(db, user.id, 'event', id, 'create', null, { ...e, image: e.image ? '[imagem]' : null }, e.source);
  const reminders = syncReminders(db, user, id);
  return { event: getEvent(db, user.id, id), reminders, warnings };
}

export function updateEvent(db, user, id, patch, source = 'manual') {
  const before = getEvent(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Compromisso');
  const next = { ...before };
  for (const k of ['title', 'date', 'duration_min', 'icon', 'image', 'location', 'notes', 'status']) if (patch[k] !== undefined) next[k] = patch[k];
  if (patch.time !== undefined) next.time = patch.time || null;
  if (patch.category_id !== undefined || patch.category) next.category_id = patch.category_id ?? categoryIdOrDefault(db, user.id, 'event', patch.category);
  if (!['scheduled', 'done', 'cancelled'].includes(next.status)) throw new AppError('Situação inválida.');
  validateEvent(next);
  next.start_utc = localToUtc(next.date, next.time, next.timezone);
  db.prepare(`UPDATE events SET title=?, date=?, time=?, duration_min=?, start_utc=?, category_id=?, icon=?, image=?, location=?, notes=?, status=?, updated_at=? WHERE id=?`)
    .run(next.title, next.date, next.time, next.duration_min, next.start_utc, next.category_id, next.icon, next.image, next.location, next.notes, next.status, nowUtcIso(), id);
  const strip = (o) => ({ ...o, image: o.image ? '[imagem]' : null });
  const action = patch.date || patch.time !== undefined ? 'reschedule' : patch.status === 'cancelled' ? 'cancel' : patch.status === 'done' ? 'complete' : 'update';
  audit(db, user.id, 'event', id, action, strip(before), strip(next), source);
  const reminders = syncReminders(db, user, id);
  return { event: getEvent(db, user.id, id), reminders };
}

export function cancelEvent(db, user, id, source = 'manual') {
  return updateEvent(db, user, id, { status: 'cancelled' }, source);
}

export function deleteEvent(db, user, id) {
  const before = getEvent(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Compromisso');
  db.prepare(`UPDATE events SET deleted_at=? WHERE id=?`).run(nowUtcIso(), id);
  syncReminders(db, user, id);
  audit(db, user.id, 'event', id, 'delete', { ...before, image: null }, null);
  return { ok: true };
}

export function restoreEvent(db, user, id) {
  const ev = getEvent(db, user.id, id);
  if (!ev || !ev.deleted_at) throw notFound('Compromisso na lixeira');
  db.prepare(`UPDATE events SET deleted_at=NULL, status='scheduled', updated_at=? WHERE id=?`).run(nowUtcIso(), id);
  syncReminders(db, user, id);
  return getEvent(db, user.id, id);
}

export function listEvents(db, userId, { start, end, includeCancelled = false, deleted = false, q, limit = 1000 } = {}) {
  const where = ['ev.user_id=?', deleted ? 'ev.deleted_at IS NOT NULL' : 'ev.deleted_at IS NULL'];
  const args = [userId];
  if (start) { where.push('ev.date >= ?'); args.push(start); }
  if (end) { where.push('ev.date <= ?'); args.push(end); }
  if (!includeCancelled && !deleted) where.push(`ev.status != 'cancelled'`);
  if (q) { where.push('(ev.title LIKE ? OR ev.notes LIKE ? OR ev.location LIKE ? OR c.name LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  return db.prepare(`${EV_SELECT} WHERE ${where.join(' AND ')} ORDER BY ev.date, ev.time IS NOT NULL, ev.time LIMIT ${Math.min(limit, 5000)}`).all(...args);
}

export function upcomingEvents(db, user, limit = 5) {
  const t = today(user.timezone);
  const nowTime = now(user.timezone).toFormat('HH:mm');
  return db.prepare(`${EV_SELECT} WHERE ev.user_id=? AND ev.deleted_at IS NULL AND ev.status='scheduled'
      AND (ev.date > ? OR (ev.date = ? AND (ev.time IS NULL OR ev.time >= ?)))
    ORDER BY ev.date, ev.time IS NOT NULL, ev.time LIMIT ?`).all(user.id, t, t, nowTime, limit);
}

/** Busca compromissos que combinam com uma descrição e/ou data (para editar/cancelar por voz). */
export function findEvents(db, user, { text, date, time }) {
  const t = today(user.timezone);
  let rows = listEvents(db, user.id, date ? { start: date, end: date } : { start: t });
  rows = rows.filter((r) => r.status === 'scheduled');
  if (time) {
    const byTime = rows.filter((r) => r.time === time);
    if (byTime.length) rows = byTime;
  }
  const words = norm(text || '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !GENERIC_EVENT_WORDS.has(w));
  if (words.length) {
    const scored = rows
      .map((r) => {
        const hay = norm(`${r.title} ${r.category_name || ''} ${r.notes || ''}`);
        return { r, score: words.filter((w) => hay.includes(w) || hay.includes(w.replace(/s$/, ''))).length };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length) {
      const best = scored[0].score;
      return scored.filter((x) => x.score === best).map((x) => x.r);
    }
    if (!date) return [];
  }
  return rows;
}

const GENERIC_EVENT_WORDS = new Set(['meu', 'minha', 'compromisso', 'compromissos', 'evento', 'agenda', 'lembrete', 'marcado', 'marcada', 'para', 'dia', 'que', 'tenho', 'com', 'dos', 'das', 'uma', 'umas', 'uns']);
