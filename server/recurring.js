import { DateTime } from 'luxon';
import { audit } from './db-util.js';
import { AppError, notFound } from './errors.js';
import { categoryIdOrDefault, getExpense } from './finance.js';
import { norm } from './categories.js';
import { nowUtcIso, today, isValidDate } from './time.js';

const FREQS = ['weekly', 'monthly', 'yearly', 'days'];

const REC_SELECT = `
  SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color, c.key AS category_key
  FROM recurrences r LEFT JOIN categories c ON c.id = r.category_id`;

export function getRecurrence(db, userId, id) {
  return db.prepare(`${REC_SELECT} WHERE r.id=? AND r.user_id=?`).get(id, userId) || null;
}

/** k-ésima ocorrência a partir da âncora (sem acumular arredondamentos de fim de mês). */
function nth(rec, k) {
  const a = DateTime.fromISO(rec.anchor_date);
  const step = k * rec.interval;
  switch (rec.frequency) {
    case 'weekly': return a.plus({ weeks: step });
    case 'monthly': return a.plus({ months: step }); // 31/jan + 1 mês = 28/fev (Luxon ajusta)
    case 'yearly': return a.plus({ years: step });
    case 'days': return a.plus({ days: step });
    default: throw new Error('frequência inválida');
  }
}

/** Datas de vencimento entre from e to (inclusive). */
export function occurrences(rec, from, to, max = 500) {
  const out = [];
  for (let k = 0; out.length < max; k++) {
    const d = nth(rec, k).toISODate();
    if (d > to) break;
    if (d >= from) out.push(d);
    if (k > 20000) break;
  }
  return out;
}

export function nextOccurrence(rec, fromDate) {
  return occurrences(rec, fromDate, DateTime.fromISO(fromDate).plus({ years: 2, days: 1 }).toISODate(), 1)[0] || null;
}

/** Valor mensal equivalente (para totais "por mês"). */
export function monthlyEquivalent(rec) {
  const a = rec.amount_cents / rec.interval;
  switch (rec.frequency) {
    case 'monthly': return a;
    case 'yearly': return a / 12;
    case 'weekly': return (a * 52) / 12;
    case 'days': return (a * 365) / 12;
    default: return 0;
  }
}

export function frequencyLabel(rec) {
  const n = rec.interval;
  switch (rec.frequency) {
    case 'monthly': return n === 1 ? 'Mensal' : `A cada ${n} meses`;
    case 'yearly': return n === 1 ? 'Anual' : `A cada ${n} anos`;
    case 'weekly': return n === 1 ? 'Semanal' : n === 2 ? 'Quinzenal' : `A cada ${n} semanas`;
    case 'days': return `A cada ${n} dias`;
    default: return rec.frequency;
  }
}

/**
 * Calcula a primeira cobrança a partir de um "dia do mês" (ex.: todo dia 23):
 * se o dia ainda não passou neste mês (ou é hoje), usa este mês; senão o próximo.
 */
export function anchorFromDay(day, tz, month = null) {
  const t = DateTime.fromISO(today(tz));
  if (month) {
    let d = DateTime.fromObject({ year: t.year, month, day: Math.min(day, DateTime.fromObject({ year: t.year, month }).daysInMonth) });
    if (d < t) d = d.plus({ years: 1 });
    return d.toISODate();
  }
  const clamp = (dt) => Math.min(day, dt.daysInMonth);
  let d = t.set({ day: clamp(t) });
  if (d < t) {
    const nm = t.plus({ months: 1 }).startOf('month');
    d = nm.set({ day: clamp(nm) });
  }
  return d.toISODate();
}

function validate(r) {
  if (!r.name || !String(r.name).trim()) throw new AppError('Informe o nome da assinatura/despesa fixa.');
  if (!Number.isInteger(r.amount_cents) || r.amount_cents <= 0) throw new AppError('Informe um valor válido.');
  if (!FREQS.includes(r.frequency)) throw new AppError('Frequência inválida.');
  if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 365) throw new AppError('Intervalo inválido.');
  if (!isValidDate(r.anchor_date)) throw new AppError('Data da próxima cobrança inválida.');
}

export function findRecurrenceByName(db, userId, name, { includeEnded = false } = {}) {
  const q = norm(name).replace(/^(a|o|minha|meu|da|do)\s+/, '').trim();
  if (!q) return [];
  const rows = db.prepare(`${REC_SELECT} WHERE r.user_id=? ${includeEnded ? '' : "AND r.status != 'cancelled'"} ORDER BY r.status='active' DESC, r.id DESC`).all(userId);
  const exact = rows.filter((r) => norm(r.name) === q);
  if (exact.length) return exact;
  return rows.filter((r) => norm(r.name).includes(q) || q.includes(norm(r.name)) || norm(r.category_name || '') === q);
}

export function createRecurrence(db, user, input, source = 'manual') {
  const tz = user.timezone;
  const r = {
    name: String(input.name || '').trim(),
    amount_cents: input.amount_cents,
    frequency: input.frequency || 'monthly',
    interval: Number(input.interval) || 1,
    anchor_date: input.anchor_date || (input.day_of_month ? anchorFromDay(Number(input.day_of_month), tz, input.month || null) : today(tz)),
    kind: input.kind === 'fixed' ? 'fixed' : 'subscription',
    direction: input.direction === 'income' ? 'income' : 'expense',
    auto_confirm: input.auto_confirm ? 1 : 0,
    notes: input.notes || null,
  };
  r.category_id = r.direction === 'income' ? null : input.category_id ?? categoryIdOrDefault(db, user.id, 'expense', input.category || (r.kind === 'subscription' ? 'assinaturas' : 'contas'));
  validate(r);
  const dup = findRecurrenceByName(db, user.id, r.name).find((x) => norm(x.name) === norm(r.name));
  if (dup) throw new AppError(`Já existe "${dup.name}" cadastrada. Use "alterar" para mudar valor ou data.`, 409, 'duplicate');
  const ts = nowUtcIso();
  const info = db.prepare(`INSERT INTO recurrences (user_id, name, amount_cents, category_id, kind, direction, frequency, interval, anchor_date, active_from, auto_confirm, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(user.id, r.name, r.amount_cents, r.category_id, r.kind, r.direction, r.frequency, r.interval, r.anchor_date, r.anchor_date, r.auto_confirm, r.notes, ts, ts);
  audit(db, user.id, 'recurrence', info.lastInsertRowid, 'create', null, r, source);
  materializeCharges(db, user);
  return getRecurrence(db, user.id, info.lastInsertRowid);
}

export function updateRecurrence(db, user, id, patch, source = 'manual') {
  const before = getRecurrence(db, user.id, id);
  if (!before) throw notFound('Assinatura');
  const next = { ...before };
  for (const k of ['name', 'amount_cents', 'frequency', 'interval', 'kind', 'notes']) if (patch[k] !== undefined && patch[k] !== null) next[k] = patch[k];
  if (patch.auto_confirm !== undefined) next.auto_confirm = patch.auto_confirm ? 1 : 0;
  if (patch.category_id !== undefined || patch.category) next.category_id = patch.category_id ?? categoryIdOrDefault(db, user.id, 'expense', patch.category);
  if (patch.anchor_date) next.anchor_date = patch.anchor_date;
  else if (patch.day_of_month) next.anchor_date = anchorFromDay(Number(patch.day_of_month), user.timezone, patch.month || null);
  next.interval = Number(next.interval);
  validate(next);
  const scheduleChanged = next.anchor_date !== before.anchor_date || next.frequency !== before.frequency || next.interval !== before.interval;
  const t = today(user.timezone);
  db.transaction(() => {
    db.prepare(`UPDATE recurrences SET name=?, amount_cents=?, frequency=?, interval=?, anchor_date=?, active_from=?, kind=?, category_id=?, auto_confirm=?, notes=?, updated_at=? WHERE id=?`)
      .run(next.name, next.amount_cents, next.frequency, next.interval, next.anchor_date, scheduleChanged ? (next.anchor_date > t ? next.anchor_date : t) : before.active_from, next.kind, next.category_id, next.auto_confirm, next.notes, nowUtcIso(), id);
    // Cobranças pendentes acompanham o novo valor; cobranças pendentes que deixaram de existir no novo calendário são removidas.
    if (next.amount_cents !== before.amount_cents) {
      db.prepare(`UPDATE recurrence_charges SET amount_cents=? WHERE recurrence_id=? AND status='pending'`).run(next.amount_cents, id);
    }
    if (scheduleChanged) db.prepare(`DELETE FROM recurrence_charges WHERE recurrence_id=? AND status='pending' AND due_date >= ?`).run(id, t);
    audit(db, user.id, 'recurrence', id, 'update', before, next, source);
  })();
  materializeCharges(db, user);
  return getRecurrence(db, user.id, id);
}

export function setRecurrenceStatus(db, user, id, status, source = 'manual') {
  const before = getRecurrence(db, user.id, id);
  if (!before) throw notFound('Assinatura');
  if (!['active', 'paused', 'cancelled'].includes(status)) throw new AppError('Situação inválida.');
  const t = today(user.timezone);
  db.transaction(() => {
    if (status === 'active') {
      // Ao reativar, não gera cobranças retroativas do período pausado.
      db.prepare(`UPDATE recurrences SET status='active', active_from=?, ended_at=NULL, updated_at=? WHERE id=?`).run(t, nowUtcIso(), id);
    } else {
      db.prepare(`UPDATE recurrences SET status=?, ended_at=?, updated_at=? WHERE id=?`).run(status, t, nowUtcIso(), id);
      // Cobranças futuras pendentes deixam de valer.
      db.prepare(`DELETE FROM recurrence_charges WHERE recurrence_id=? AND status='pending' AND due_date > ?`).run(id, t);
    }
    audit(db, user.id, 'recurrence', id, status === 'active' ? 'resume' : status === 'paused' ? 'pause' : 'cancel', before, { status }, source);
  })();
  if (status === 'active') materializeCharges(db, user);
  return getRecurrence(db, user.id, id);
}

export function deleteRecurrence(db, user, id) {
  const before = getRecurrence(db, user.id, id);
  if (!before) throw notFound('Assinatura');
  db.transaction(() => {
    // Mantém as despesas já pagas (histórico financeiro), apenas desvincula.
    db.prepare(`UPDATE expenses SET charge_id=NULL WHERE charge_id IN (SELECT id FROM recurrence_charges WHERE recurrence_id=?)`).run(id);
    db.prepare(`DELETE FROM recurrences WHERE id=?`).run(id);
    audit(db, user.id, 'recurrence', id, 'delete', before, null);
  })();
  return { ok: true };
}

/**
 * Gera (de forma idempotente) as cobranças com vencimento até hoje.
 * UNIQUE(recurrence_id, due_date) + INSERT OR IGNORE garantem que nunca há duplicatas,
 * não importa quantas vezes isto rode.
 */
export function materializeCharges(db, user, upTo = today(user.timezone)) {
  const recs = db.prepare(`SELECT * FROM recurrences WHERE user_id=? AND status='active'`).all(user.id);
  const ins = db.prepare(`INSERT OR IGNORE INTO recurrence_charges (recurrence_id, user_id, due_date, amount_cents) VALUES (?,?,?,?)`);
  let created = 0;
  db.transaction(() => {
    for (const r of recs) {
      for (const d of occurrences(r, r.active_from, upTo)) {
        const info = ins.run(r.id, user.id, d, r.amount_cents);
        if (info.changes) {
          created++;
          if (r.auto_confirm) confirmCharge(db, user, info.lastInsertRowid, {}, 'auto');
        }
      }
    }
  })();
  return created;
}

function getCharge(db, userId, id) {
  return db.prepare(`SELECT ch.*, r.name, r.category_id, r.direction FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id WHERE ch.id=? AND ch.user_id=?`).get(id, userId);
}

/** Confirma o pagamento: a cobrança vira uma despesa realizada (uma única vez). */
export function confirmCharge(db, user, chargeId, { amount_cents, date } = {}, source = 'manual') {
  const ch = getCharge(db, user.id, chargeId);
  if (!ch) throw notFound('Cobrança');
  if (ch.status === 'paid') {
    if (ch.direction === 'income') return { charge: ch, income: db.prepare(`SELECT * FROM incomes WHERE charge_id=?`).get(ch.id), already: true };
    return { charge: ch, expense: getExpense(db, user.id, ch.expense_id), already: true };
  }
  const ts = nowUtcIso();
  const amount = amount_cents || ch.amount_cents;
  if (ch.direction === 'income') {
    // Salário/renda recorrente: vira uma entrada.
    let incomeId;
    db.transaction(() => {
      incomeId = db.prepare(`INSERT INTO incomes (user_id, description, amount_cents, date, source, charge_id, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(user.id, ch.name, amount, date || ch.due_date, 'recurring', ch.id, ts).lastInsertRowid;
      db.prepare(`UPDATE recurrence_charges SET status='paid', paid_at=?, amount_cents=? WHERE id=?`).run(ts, amount, ch.id);
      audit(db, user.id, 'charge', ch.id, 'confirm', ch, { amount_cents: amount, income_id: incomeId }, source);
    })();
    return { charge: getCharge(db, user.id, chargeId), income: db.prepare(`SELECT * FROM incomes WHERE id=?`).get(incomeId) };
  }
  let expenseId;
  db.transaction(() => {
    expenseId = db.prepare(`INSERT INTO expenses (user_id, description, amount_cents, category_id, date, source, charge_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(user.id, ch.name, amount, ch.category_id, date || ch.due_date, 'recurring', ch.id, ts, ts).lastInsertRowid;
    db.prepare(`UPDATE recurrence_charges SET status='paid', paid_at=?, expense_id=?, amount_cents=? WHERE id=?`).run(ts, expenseId, amount, ch.id);
    audit(db, user.id, 'charge', ch.id, 'confirm', ch, { amount_cents: amount, expense_id: expenseId }, source);
  })();
  return { charge: getCharge(db, user.id, chargeId), expense: getExpense(db, user.id, expenseId) };
}

export function skipCharge(db, user, chargeId) {
  const ch = getCharge(db, user.id, chargeId);
  if (!ch) throw notFound('Cobrança');
  if (ch.status === 'paid') throw new AppError('Esta cobrança já foi paga. Exclua a despesa para desfazer.');
  db.prepare(`UPDATE recurrence_charges SET status='skipped' WHERE id=?`).run(chargeId);
  audit(db, user.id, 'charge', chargeId, 'skip', ch, null);
  return getCharge(db, user.id, chargeId);
}

/**
 * Registra o pagamento da cobrança mais adequada de uma recorrência:
 * a pendente mais antiga; se não houver, a próxima (pagamento antecipado).
 */
export function payRecurrence(db, user, recId, opts = {}, source = 'manual') {
  const rec = getRecurrence(db, user.id, recId);
  if (!rec) throw notFound('Assinatura');
  materializeCharges(db, user);
  let ch = db.prepare(`SELECT id FROM recurrence_charges WHERE recurrence_id=? AND status='pending' ORDER BY due_date LIMIT 1`).get(recId);
  if (!ch) {
    const t = today(user.timezone);
    const lastPaid = db.prepare(`SELECT MAX(due_date) d FROM recurrence_charges WHERE recurrence_id=?`).get(recId).d;
    const from = lastPaid && lastPaid >= t ? DateTime.fromISO(lastPaid).plus({ days: 1 }).toISODate() : rec.active_from > t ? rec.active_from : t;
    const due = nextOccurrence(rec, from);
    if (!due) throw new AppError('Não há próxima cobrança para esta assinatura.');
    db.prepare(`INSERT OR IGNORE INTO recurrence_charges (recurrence_id, user_id, due_date, amount_cents) VALUES (?,?,?,?)`).run(recId, user.id, due, rec.amount_cents);
    ch = db.prepare(`SELECT id FROM recurrence_charges WHERE recurrence_id=? AND due_date=?`).get(recId, due);
  }
  return confirmCharge(db, user, ch.id, opts, source);
}

export function listRecurrences(db, user) {
  const t = today(user.timezone);
  return db.prepare(`${REC_SELECT} WHERE r.user_id=? ORDER BY r.status='active' DESC, r.name`).all(user.id).map((r) => decorate(db, r, t));
}

function decorate(db, r, t) {
  const pending = db.prepare(`SELECT * FROM recurrence_charges WHERE recurrence_id=? AND status='pending' ORDER BY due_date`).all(r.id);
  const lastMat = db.prepare(`SELECT MAX(due_date) d FROM recurrence_charges WHERE recurrence_id=?`).get(r.id).d;
  let next = null;
  if (r.status === 'active') {
    const from = [t, r.active_from, lastMat ? DateTime.fromISO(lastMat).plus({ days: 1 }).toISODate() : null].filter(Boolean).sort().pop();
    next = nextOccurrence(r, from);
  }
  return {
    ...r,
    frequency_label: frequencyLabel(r),
    monthly_cents: Math.round(monthlyEquivalent(r)),
    yearly_cents: Math.round(monthlyEquivalent(r) * 12),
    next_due: pending[0]?.due_date || next,
    next_future_due: next,
    pending_charges: pending,
  };
}

export function chargeHistory(db, userId, recId) {
  return db.prepare(`SELECT * FROM recurrence_charges WHERE recurrence_id=? AND user_id=? ORDER BY due_date DESC`).all(recId, userId);
}

/**
 * Previsão de cobranças no intervalo: inclui cobranças já geradas (pagas/pendentes)
 * e ocorrências futuras ainda não geradas (status "forecast"). Nunca duplica.
 */
export function forecast(db, user, from, to) {
  const out = [];
  const charges = db.prepare(`SELECT ch.*, r.name, r.kind, r.direction, r.category_id, c.name category_name, c.icon category_icon, c.color category_color
    FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id LEFT JOIN categories c ON c.id=r.category_id
    WHERE ch.user_id=? AND ch.due_date BETWEEN ? AND ? AND ch.status != 'skipped'`).all(user.id, from, to);
  const seen = new Set(charges.map((c) => `${c.recurrence_id}|${c.due_date}`));
  for (const c of charges) out.push({ recurrence_id: c.recurrence_id, charge_id: c.id, name: c.name, kind: c.kind, direction: c.direction, due_date: c.due_date, amount_cents: c.amount_cents, status: c.status, category_name: c.category_name, category_icon: c.category_icon, category_color: c.category_color });
  const t = today(user.timezone);
  const recs = db.prepare(`${REC_SELECT} WHERE r.user_id=? AND r.status='active'`).all(user.id);
  for (const r of recs) {
    const start = [from, r.active_from, DateTime.fromISO(t).plus({ days: 1 }).toISODate()].sort().pop();
    for (const d of occurrences(r, start, to)) {
      if (seen.has(`${r.id}|${d}`)) continue;
      out.push({ recurrence_id: r.id, charge_id: null, name: r.name, kind: r.kind, direction: r.direction, due_date: d, amount_cents: r.amount_cents, status: 'forecast', category_name: r.category_name, category_icon: r.category_icon, category_color: r.category_color });
    }
  }
  return out.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.name.localeCompare(b.name));
}

export function recurringTotals(db, user) {
  const all = db.prepare(`${REC_SELECT} WHERE r.user_id=? AND r.status='active'`).all(user.id);
  const recs = all.filter((r) => r.direction !== 'income');
  const incomeRecs = all.filter((r) => r.direction === 'income');
  const sum = (arr) => Math.round(arr.reduce((a, r) => a + monthlyEquivalent(r), 0));
  const subs = recs.filter((r) => r.kind === 'subscription');
  const fixed = recs.filter((r) => r.kind === 'fixed');
  const fitness = recs.filter((r) => r.category_key === 'academia');
  return {
    subscriptions_monthly_cents: sum(subs),
    subscriptions_yearly_cents: sum(subs) * 12,
    fixed_monthly_cents: sum(fixed),
    fixed_yearly_cents: sum(fixed) * 12,
    fitness_monthly_cents: sum(fitness),
    fitness_yearly_cents: sum(fitness) * 12,
    all_monthly_cents: sum(recs),
    all_yearly_cents: sum(recs) * 12,
    count_active: recs.length,
    income_monthly_cents: sum(incomeRecs),
  };
}
