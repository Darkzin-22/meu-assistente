// Rendimentos (entradas de dinheiro) e saldo das contas.
// O saldo é informado pelo usuário ("meu saldo no Nubank é 2.300") e depois estimado
// automaticamente: saldo informado + entradas − despesas registradas desde então.
import { audit } from './db-util.js';
import { AppError, notFound } from './errors.js';
import { norm } from './categories.js';
import { nowUtcIso, today, isValidDate } from './time.js';
import { sumExpenses } from './finance.js';

// ---------------------------------------------------------------- Entradas
export function createIncome(db, user, input) {
  const data = {
    description: String(input.description || '').trim() || 'Entrada',
    amount_cents: input.amount_cents,
    date: input.date || today(user.timezone),
    source: input.source || 'manual',
    client_id: input.client_id || null,
  };
  if (!Number.isInteger(data.amount_cents) || data.amount_cents <= 0) throw new AppError('Informe um valor válido maior que zero.');
  if (!isValidDate(data.date)) throw new AppError('Data inválida.');
  if (data.client_id) {
    const prev = db.prepare(`SELECT * FROM incomes WHERE user_id=? AND client_id=?`).get(user.id, data.client_id);
    if (prev) return prev;
  }
  const id = db.prepare(`INSERT INTO incomes (user_id, description, amount_cents, date, source, client_id, created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(user.id, data.description, data.amount_cents, data.date, data.source, data.client_id, nowUtcIso()).lastInsertRowid;
  audit(db, user.id, 'income', id, 'create', null, data, data.source);
  return getIncome(db, user.id, id);
}

export function getIncome(db, userId, id) {
  return db.prepare(`SELECT * FROM incomes WHERE id=? AND user_id=?`).get(id, userId) || null;
}

export function updateIncome(db, user, id, patch) {
  const before = getIncome(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Entrada');
  const next = {
    description: patch.description !== undefined ? String(patch.description).trim() : before.description,
    amount_cents: patch.amount_cents !== undefined ? patch.amount_cents : before.amount_cents,
    date: patch.date || before.date,
  };
  if (!Number.isInteger(next.amount_cents) || next.amount_cents <= 0) throw new AppError('Informe um valor válido.');
  if (!isValidDate(next.date)) throw new AppError('Data inválida.');
  db.prepare(`UPDATE incomes SET description=?, amount_cents=?, date=? WHERE id=?`).run(next.description, next.amount_cents, next.date, id);
  audit(db, user.id, 'income', id, 'update', before, next);
  return getIncome(db, user.id, id);
}

export function deleteIncome(db, user, id) {
  const before = getIncome(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Entrada');
  db.transaction(() => {
    db.prepare(`UPDATE incomes SET deleted_at=? WHERE id=?`).run(nowUtcIso(), id);
    // Se veio de um salário recorrente, a cobrança volta a ficar pendente.
    if (before.charge_id) {
      db.prepare(`UPDATE recurrence_charges SET status='pending', paid_at=NULL, expense_id=NULL WHERE id=?`).run(before.charge_id);
      db.prepare(`UPDATE incomes SET charge_id=NULL WHERE id=?`).run(id);
    }
    audit(db, user.id, 'income', id, 'delete', before, null);
  })();
  return { ok: true };
}

export function listIncomes(db, userId, { start, end, limit = 500 } = {}) {
  const where = ['user_id=?', 'deleted_at IS NULL'];
  const args = [userId];
  if (start) { where.push('date >= ?'); args.push(start); }
  if (end) { where.push('date <= ?'); args.push(end); }
  return db.prepare(`SELECT * FROM incomes WHERE ${where.join(' AND ')} ORDER BY date DESC, id DESC LIMIT ${Math.min(Number(limit) || 500, 5000)}`).all(...args);
}

export function sumIncomes(db, userId, { start, end } = {}) {
  const where = ['user_id=?', 'deleted_at IS NULL'];
  const args = [userId];
  if (start) { where.push('date >= ?'); args.push(start); }
  if (end) { where.push('date <= ?'); args.push(end); }
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) total, COUNT(*) n FROM incomes WHERE ${where.join(' AND ')}`).get(...args);
  return { total_cents: r.total, count: r.n };
}

// ---------------------------------------------------------------- Contas e saldo
export function listAccounts(db, userId) {
  return db.prepare(`SELECT * FROM accounts WHERE user_id=? AND archived=0 ORDER BY name`).all(userId);
}

export function findAccount(db, userId, name) {
  const q = norm(name).replace(/^(no|na|do|da|o|a|meu|minha|conta)\s+/g, '').trim();
  return listAccounts(db, userId).find((a) => norm(a.name) === q || norm(a.name).includes(q) || q.includes(norm(a.name))) || null;
}

/** Informa o saldo atual de uma conta (cria a conta se não existir). */
export function setAccountBalance(db, user, { name, amount_cents }) {
  if (!Number.isInteger(amount_cents)) throw new AppError('Informe o valor do saldo.');
  const label = String(name || '').trim() || 'Conta principal';
  const existing = findAccount(db, user.id, label);
  const ts = nowUtcIso();
  let id;
  if (existing) {
    db.prepare(`UPDATE accounts SET balance_cents=?, balance_at=? WHERE id=?`).run(amount_cents, ts, existing.id);
    id = existing.id;
    audit(db, user.id, 'account', id, 'balance', existing, { balance_cents: amount_cents });
  } else {
    const nice = label[0].toUpperCase() + label.slice(1);
    id = db.prepare(`INSERT INTO accounts (user_id, name, balance_cents, balance_at) VALUES (?,?,?,?)`).run(user.id, nice, amount_cents, ts).lastInsertRowid;
    audit(db, user.id, 'account', id, 'create', null, { name: nice, balance_cents: amount_cents });
  }
  return db.prepare(`SELECT * FROM accounts WHERE id=?`).get(id);
}

export function deleteAccount(db, user, id) {
  const a = db.prepare(`SELECT * FROM accounts WHERE id=? AND user_id=?`).get(id, user.id);
  if (!a) throw notFound('Conta');
  db.prepare(`UPDATE accounts SET archived=1 WHERE id=?`).run(id);
  audit(db, user.id, 'account', id, 'delete', a, null);
  return { ok: true };
}

/**
 * Saldo estimado = soma dos saldos informados
 *   + entradas lançadas depois do último saldo informado
 *   − despesas realizadas lançadas depois do último saldo informado.
 */
export function balanceSummary(db, user) {
  const accounts = listAccounts(db, user.id);
  const t = today(user.timezone);
  if (!accounts.length) return { accounts: [], informed_cents: 0, estimated_cents: null, since: null };
  const informed = accounts.reduce((s, a) => s + a.balance_cents, 0);
  const since = accounts.map((a) => a.balance_at).sort().pop();
  const inc = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM incomes WHERE user_id=? AND deleted_at IS NULL AND created_at > ? AND date <= ?`).get(user.id, since, t).s;
  const exp = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM expenses WHERE user_id=? AND deleted_at IS NULL AND created_at > ? AND date <= ?`).get(user.id, since, t).s;
  return { accounts, informed_cents: informed, incomes_since_cents: inc, expenses_since_cents: exp, estimated_cents: informed + inc - exp, since };
}

/** Resumo do período: entradas, despesas e quanto sobrou. */
export function periodSummary(db, user, { start, end }) {
  const t = today(user.timezone);
  const realEnd = end && end < t ? end : t;
  const income = sumIncomes(db, user.id, { start, end: realEnd }).total_cents;
  const expense = sumExpenses(db, user.id, { start, end: realEnd }).total_cents;
  return { start, end: realEnd, income_cents: income, expense_cents: expense, net_cents: income - expense };
}
