import { DateTime } from 'luxon';
import { listExpenses } from './finance.js';
import { AppError } from './errors.js';
import { nowUtcIso } from './time.js';
import { syncReminders } from './agenda.js';
import { audit } from './db-util.js';

// ---------------------------------------------------------------- CSV / Excel
const brNum = (cents) => (cents / 100).toFixed(2).replace('.', ',');
const brDate = (d) => DateTime.fromISO(d).toFormat('dd/LL/yyyy');

export function expensesCsv(db, userId, filters) {
  const rows = listExpenses(db, userId, { ...filters, limit: 5000 });
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Data', 'Descrição', 'Categoria', 'Valor (R$)', 'Parcela', 'Origem', 'Observações'].join(';')];
  for (const e of rows) {
    lines.push([brDate(e.date), e.description, e.category_name || '', brNum(e.amount_cents), e.installment_no ? `${e.installment_no}/${e.installment_total}` : '', e.source, e.notes || ''].map(esc).join(';'));
  }
  // BOM para o Excel reconhecer UTF-8; ";" é o separador padrão do Excel em pt-BR.
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- iCalendar
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsDate = (iso) => DateTime.fromISO(iso, { zone: 'utc' }).toFormat("yyyyLLdd'T'HHmmss'Z'");

function foldLine(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

/** Gera um .ics. Com withAlarms, inclui os mesmos lembretes como alarmes nativos (VALARM). */
export function eventsIcs(events, { remindersByEvent = {}, name = 'Meu Assistente', withAlarms = true } = {}) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meu Assistente//PT-BR', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${icsEsc(name)}`, 'X-WR-TIMEZONE:America/Sao_Paulo'];
  for (const e of events) {
    L.push('BEGIN:VEVENT', `UID:evento-${e.id}@meu-assistente`, `DTSTAMP:${icsDate(nowUtcIso())}`, `SUMMARY:${icsEsc(e.title)}`);
    if (e.time) {
      L.push(`DTSTART:${icsDate(e.start_utc)}`, `DTEND:${icsDate(DateTime.fromISO(e.start_utc).plus({ minutes: e.duration_min || 60 }).toUTC().toISO())}`);
    } else {
      const d = e.date.replace(/-/g, '');
      L.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${DateTime.fromISO(e.date).plus({ days: 1 }).toFormat('yyyyLLdd')}`);
    }
    if (e.location) L.push(`LOCATION:${icsEsc(e.location)}`);
    if (e.notes) L.push(`DESCRIPTION:${icsEsc(e.notes)}`);
    if (e.category_name) L.push(`CATEGORIES:${icsEsc(e.category_name)}`);
    if (e.status === 'cancelled') L.push('STATUS:CANCELLED');
    if (withAlarms) {
      for (const r of remindersByEvent[e.id] || []) {
        L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEsc(r.body)}`, `TRIGGER;VALUE=DATE-TIME:${icsDate(r.fire_at)}`, 'END:VALARM');
      }
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(foldLine).join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- Backup / restauração
const TABLES = ['categories', 'recurrences', 'recurrence_charges', 'expenses', 'events', 'reminders'];

export function exportBackup(db, user) {
  const data = { app: 'meu-assistente', version: 1, exported_at: nowUtcIso(), user: { email: user.email, name: user.name, timezone: user.timezone, settings: user.settings } };
  for (const t of TABLES) data[t] = db.prepare(`SELECT * FROM ${t} WHERE user_id=?`).all(user.id);
  return data;
}

/** Substitui TODOS os dados do usuário pelos do backup (em uma transação: tudo ou nada). */
export function restoreBackup(db, user, data) {
  if (data?.app !== 'meu-assistente' || !Array.isArray(data.expenses)) throw new AppError('Arquivo de backup inválido.');
  db.transaction(() => {
    for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t} WHERE user_id=?`).run(user.id);
    for (const t of TABLES) {
      const rows = data[t] || [];
      if (!rows.length) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const ins = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const r of rows) ins.run(...cols.map((c) => (c === 'user_id' ? user.id : r[c] ?? null)));
    }
    if (data.user?.settings) db.prepare(`UPDATE users SET settings_json=?, timezone=? WHERE id=?`).run(JSON.stringify(data.user.settings), data.user.timezone || user.timezone, user.id);
    audit(db, user.id, 'backup', null, 'restore', null, { counts: Object.fromEntries(TABLES.map((t) => [t, (data[t] || []).length])) });
  })();
  // Reprograma lembretes futuros (ids podem ter mudado de servidor).
  for (const ev of db.prepare(`SELECT id FROM events WHERE user_id=? AND status='scheduled' AND deleted_at IS NULL`).all(user.id)) syncReminders(db, user, ev.id);
}
