import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { audit } from './db.js';
import { AppError, notFound } from './errors.js';
import { norm } from './categories.js';
import { splitInstallments, brl } from './money.js';
import { now, nowUtcIso, today, isValidDate, monthRange, weekRange, yearRange } from './time.js';

// ---------- Categorias ----------

export function listCategories(db, userId, kind) {
  return db
    .prepare(`SELECT * FROM categories WHERE user_id = ? AND kind = ? AND archived = 0 ORDER BY sort, name`)
    .all(userId, kind);
}

/** Encontra categoria por id, chave interna ou nome (tolerante a acentos e nomes parciais). */
export function findCategory(db, userId, kind, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    return db.prepare(`SELECT * FROM categories WHERE id = ? AND user_id = ? AND kind = ?`).get(Number(ref), userId, kind) || null;
  }
  const cats = listCategories(db, userId, kind);
  const r = norm(ref).trim();
  return (
    cats.find((c) => c.key === ref) ||
    cats.find((c) => norm(c.name) === r) ||
    cats.find((c) => norm(c.name).startsWith(r) || r.startsWith(norm(c.name))) ||
    cats.find((c) => norm(c.name).split(/\s+/).some((w) => w.length > 3 && r.includes(w))) ||
    null
  );
}

export function categoryIdOrDefault(db, userId, kind, ref) {
  const c = findCategory(db, userId, kind, ref);
  if (c) return c.id;
  const fallbackKey = kind === 'expense' ? 'outros' : 'tarefa';
  return findCategory(db, userId, kind, fallbackKey)?.id ?? null;
}

export function createCategory(db, userId, { kind, name, icon, color, budget_cents }) {
  if (!['expense', 'event'].includes(kind)) throw new AppError('Tipo de categoria inválido.');
  if (!name || !String(name).trim()) throw new AppError('Informe o nome da categoria.');
  const exists = db.prepare(`SELECT * FROM categories WHERE user_id=? AND kind=? AND name=?`).get(userId, kind, name.trim());
  if (exists && !exists.archived) throw new AppError('Já existe uma categoria com esse nome.');
  if (exists) {
    db.prepare(`UPDATE categories SET archived=0, icon=?, color=? WHERE id=?`).run(icon || exists.icon, color || exists.color, exists.id);
    return db.prepare(`SELECT * FROM categories WHERE id=?`).get(exists.id);
  }
  const sort = db.prepare(`SELECT COALESCE(MAX(sort),0)+1 s FROM categories WHERE user_id=? AND kind=?`).get(userId, kind).s;
  const info = db
    .prepare(`INSERT INTO categories (user_id, kind, name, icon, color, budget_cents, sort) VALUES (?,?,?,?,?,?,?)`)
    .run(userId, kind, name.trim(), icon || 'dots', color || '#8E8E93', budget_cents ?? null, sort);
  audit(db, userId, 'category', info.lastInsertRowid, 'create', null, { name });
  return db.prepare(`SELECT * FROM categories WHERE id=?`).get(info.lastInsertRowid);
}

export function updateCategory(db, userId, id, patch) {
  const c = db.prepare(`SELECT * FROM categories WHERE id=? AND user_id=?`).get(id, userId);
  if (!c) throw notFound('Categoria');
  const next = {
    name: patch.name?.trim() || c.name,
    icon: patch.icon || c.icon,
    color: patch.color || c.color,
    budget_cents: patch.budget_cents === undefined ? c.budget_cents : patch.budget_cents,
  };
  db.prepare(`UPDATE categories SET name=?, icon=?, color=?, budget_cents=? WHERE id=?`).run(next.name, next.icon, next.color, next.budget_cents, id);
  audit(db, userId, 'category', id, 'update', c, next);
  return db.prepare(`SELECT * FROM categories WHERE id=?`).get(id);
}

/** Exclui (arquiva) a categoria; os registros passam para "Outros"/"Tarefa pessoal". */
export function deleteCategory(db, userId, id) {
  const c = db.prepare(`SELECT * FROM categories WHERE id=? AND user_id=?`).get(id, userId);
  if (!c) throw notFound('Categoria');
  const fallback = categoryIdOrDefault(db, userId, c.kind, c.kind === 'expense' ? 'outros' : 'tarefa');
  if (fallback === id) throw new AppError('Esta categoria padrão não pode ser excluída.');
  db.transaction(() => {
    if (c.kind === 'expense') {
      db.prepare(`UPDATE expenses SET category_id=? WHERE category_id=?`).run(fallback, id);
      db.prepare(`UPDATE recurrences SET category_id=? WHERE category_id=?`).run(fallback, id);
    } else {
      db.prepare(`UPDATE events SET category_id=? WHERE category_id=?`).run(fallback, id);
    }
    db.prepare(`UPDATE categories SET archived=1 WHERE id=?`).run(id);
    audit(db, userId, 'category', id, 'delete', c, null);
  })();
  return { ok: true };
}

// ---------- Despesas ----------

const EXPENSE_SELECT = `
  SELECT e.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
  FROM expenses e LEFT JOIN categories c ON c.id = e.category_id`;

export function getExpense(db, userId, id) {
  return db.prepare(`${EXPENSE_SELECT} WHERE e.id = ? AND e.user_id = ?`).get(id, userId) || null;
}

function validateExpense({ description, amount_cents, date }) {
  if (!description || !String(description).trim()) throw new AppError('Informe a descrição da despesa.');
  if (!Number.isInteger(amount_cents) || amount_cents <= 0) throw new AppError('Informe um valor válido maior que zero.');
  if (amount_cents > 100_000_000_00) throw new AppError('Valor muito alto — confira se está correto.');
  if (!isValidDate(date)) throw new AppError('Data inválida.');
}

/**
 * Cria uma despesa (ou N parcelas). Idempotente por client_id.
 * Retorna { expenses, warnings }.
 */
export function createExpense(db, user, input) {
  const tz = user.timezone;
  const data = {
    description: String(input.description || '').trim(),
    amount_cents: input.amount_cents,
    date: input.date || today(tz),
    category_id: input.category_id ?? categoryIdOrDefault(db, user.id, 'expense', input.category),
    notes: input.notes || null,
    source: input.source || 'manual',
    client_id: input.client_id || null,
  };
  validateExpense(data);
  if (data.client_id) {
    const prev = db.prepare(`${EXPENSE_SELECT} WHERE e.user_id=? AND (e.client_id=? OR e.client_id LIKE ?) ORDER BY e.id`).all(user.id, data.client_id, `${data.client_id}#%`);
    if (prev.length) return { expenses: prev, warnings: [], duplicate: true };
  }
  const warnings = [];
  // Proteção contra duplicidade acidental: mesma descrição, valor e data criada há menos de 2 minutos.
  const recent = db
    .prepare(`SELECT id FROM expenses WHERE user_id=? AND deleted_at IS NULL AND amount_cents=? AND date=? AND lower(description)=lower(?) AND created_at >= ?`)
    .get(user.id, data.amount_cents, data.date, data.description, now().toUTC().minus({ minutes: 2 }).toISO());
  if (recent) warnings.push('Possível duplicata: uma despesa idêntica foi registrada há instantes.');

  const n = Math.max(1, Math.min(72, Number(input.installments) || 1));
  const ts = nowUtcIso();
  const ins = db.prepare(`INSERT INTO expenses
    (user_id, description, amount_cents, category_id, date, notes, source, installment_group, installment_no, installment_total, client_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ids = [];
  db.transaction(() => {
    if (n === 1) {
      ids.push(ins.run(user.id, data.description, data.amount_cents, data.category_id, data.date, data.notes, data.source, null, null, null, data.client_id, ts, ts).lastInsertRowid);
    } else {
      const group = crypto.randomUUID();
      const parts = splitInstallments(data.amount_cents, n);
      const start = DateTime.fromISO(data.date);
      parts.forEach((cents, i) => {
        ids.push(ins.run(user.id, `${data.description} (${i + 1}/${n})`, cents, data.category_id, start.plus({ months: i }).toISODate(), data.notes, data.source, group, i + 1, n, data.client_id ? `${data.client_id}#${i + 1}` : null, ts, ts).lastInsertRowid);
      });
    }
    for (const id of ids) audit(db, user.id, 'expense', id, 'create', null, { ...data, id }, data.source);
  })();
  const expenses = ids.map((id) => getExpense(db, user.id, id));
  warnings.push(...budgetWarnings(db, user, data.category_id, data.date));
  return { expenses, warnings };
}

export function updateExpense(db, user, id, patch, source = 'manual') {
  const before = getExpense(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Despesa');
  const next = {
    description: patch.description !== undefined ? String(patch.description).trim() : before.description,
    amount_cents: patch.amount_cents !== undefined ? patch.amount_cents : before.amount_cents,
    date: patch.date || before.date,
    category_id: patch.category_id !== undefined ? patch.category_id : patch.category ? categoryIdOrDefault(db, user.id, 'expense', patch.category) : before.category_id,
    notes: patch.notes !== undefined ? patch.notes : before.notes,
  };
  validateExpense(next);
  db.prepare(`UPDATE expenses SET description=?, amount_cents=?, date=?, category_id=?, notes=?, updated_at=? WHERE id=?`)
    .run(next.description, next.amount_cents, next.date, next.category_id, next.notes, nowUtcIso(), id);
  audit(db, user.id, 'expense', id, 'update', before, next, source);
  return { expense: getExpense(db, user.id, id), warnings: budgetWarnings(db, user, next.category_id, next.date) };
}

/** Exclusão reversível (vai para a lixeira). */
export function deleteExpense(db, user, id, source = 'manual') {
  const before = getExpense(db, user.id, id);
  if (!before || before.deleted_at) throw notFound('Despesa');
  db.transaction(() => {
    db.prepare(`UPDATE expenses SET deleted_at=? WHERE id=?`).run(nowUtcIso(), id);
    // Se for pagamento de assinatura, a cobrança volta a ficar pendente.
    if (before.charge_id) {
      db.prepare(`UPDATE recurrence_charges SET status='pending', paid_at=NULL, expense_id=NULL WHERE id=?`).run(before.charge_id);
      db.prepare(`UPDATE expenses SET charge_id=NULL WHERE id=?`).run(id);
    }
    audit(db, user.id, 'expense', id, 'delete', before, null, source);
  })();
  return { ok: true, expense: before };
}

export function restoreExpense(db, user, id) {
  const e = getExpense(db, user.id, id);
  if (!e || !e.deleted_at) throw notFound('Despesa na lixeira');
  db.prepare(`UPDATE expenses SET deleted_at=NULL, updated_at=? WHERE id=?`).run(nowUtcIso(), id);
  audit(db, user.id, 'expense', id, 'restore', null, e);
  return getExpense(db, user.id, id);
}

export function purgeExpense(db, user, id) {
  const e = getExpense(db, user.id, id);
  if (!e || !e.deleted_at) throw notFound('Despesa na lixeira');
  db.prepare(`DELETE FROM expenses WHERE id=?`).run(id);
  audit(db, user.id, 'expense', id, 'purge', e, null);
  return { ok: true };
}

export function listExpenses(db, userId, f = {}) {
  const where = ['e.user_id = ?'];
  const args = [userId];
  where.push(f.deleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL');
  if (f.start) { where.push('e.date >= ?'); args.push(f.start); }
  if (f.end) { where.push('e.date <= ?'); args.push(f.end); }
  if (f.category_id) { where.push('e.category_id = ?'); args.push(Number(f.category_id)); }
  if (f.min_cents != null && f.min_cents !== '') { where.push('e.amount_cents >= ?'); args.push(Number(f.min_cents)); }
  if (f.max_cents != null && f.max_cents !== '') { where.push('e.amount_cents <= ?'); args.push(Number(f.max_cents)); }
  if (f.q) { where.push('(e.description LIKE ? OR e.notes LIKE ? OR c.name LIKE ?)'); args.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`); }
  const order = f.order === 'amount' ? 'e.amount_cents DESC' : 'e.date DESC, e.id DESC';
  const limit = Math.min(Number(f.limit) || 500, 5000);
  return db.prepare(`${EXPENSE_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit}`).all(...args);
}

export function sumExpenses(db, userId, { start, end, category_id } = {}) {
  const where = ['user_id = ?', 'deleted_at IS NULL'];
  const args = [userId];
  if (start) { where.push('date >= ?'); args.push(start); }
  if (end) { where.push('date <= ?'); args.push(end); }
  if (category_id) { where.push('category_id = ?'); args.push(category_id); }
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) total, COUNT(*) n FROM expenses WHERE ${where.join(' AND ')}`).get(...args);
  return { total_cents: r.total, count: r.n };
}

// ---------- Orçamento ----------

export function budgetWarnings(db, user, categoryId, date) {
  if (!categoryId) return [];
  const cat = db.prepare(`SELECT * FROM categories WHERE id=?`).get(categoryId);
  if (!cat?.budget_cents) return [];
  const { start, end } = monthRange(date);
  const { total_cents } = sumExpenses(db, user.id, { start, end, category_id: categoryId });
  const pct = total_cents / cat.budget_cents;
  if (pct >= 1) return [`Orçamento de ${cat.name} ultrapassado: ${brl(total_cents)} de ${brl(cat.budget_cents)} no mês.`];
  if (pct >= 0.8) return [`Atenção: você já usou ${Math.round(pct * 100)}% do orçamento de ${cat.name} (${brl(total_cents)} de ${brl(cat.budget_cents)}).`];
  return [];
}

export function budgetStatus(db, user, date = today(user.timezone)) {
  const { start, end } = monthRange(date);
  return listCategories(db, user.id, 'expense')
    .filter((c) => c.budget_cents)
    .map((c) => {
      const spent = sumExpenses(db, user.id, { start, end, category_id: c.id }).total_cents;
      return { category_id: c.id, name: c.name, icon: c.icon, color: c.color, budget_cents: c.budget_cents, spent_cents: spent, pct: spent / c.budget_cents };
    });
}

// ---------- Painel / estatísticas ----------

export function financeStats(db, user, { forecastFn } = {}) {
  const tz = user.timezone;
  const t = today(tz);
  const m = monthRange(t);
  const sumTo = (r) => sumExpenses(db, user.id, { start: r.start, end: t < r.end ? t : r.end }).total_cents;

  const byCategory = db.prepare(`
    SELECT c.id, c.name, c.icon, c.color, SUM(e.amount_cents) total, COUNT(*) n
    FROM expenses e LEFT JOIN categories c ON c.id=e.category_id
    WHERE e.user_id=? AND e.deleted_at IS NULL AND e.date BETWEEN ? AND ?
    GROUP BY c.id ORDER BY total DESC`).all(user.id, m.start, t);

  const months = [];
  const base = DateTime.fromISO(t).startOf('month');
  for (let i = 11; i >= 0; i--) {
    const d = base.minus({ months: i });
    const r = monthRange(d.toISODate());
    const end = r.end > t ? t : r.end;
    months.push({ month: d.toFormat('yyyy-LL'), label: d.setLocale('pt-BR').toFormat('LLL').replace('.', ''), total_cents: sumExpenses(db, user.id, { start: r.start, end }).total_cents });
  }

  const top = listExpenses(db, user.id, { start: m.start, end: t, order: 'amount', limit: 5 });

  // Despesas já lançadas com data futura dentro do mês (ex.: parcelas).
  const futureLogged = db.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM expenses WHERE user_id=? AND deleted_at IS NULL AND date > ? AND date <= ?`).get(user.id, t, m.end).s;
  const upcoming = forecastFn ? forecastFn(t, m.end) : [];
  const recurringForecast = upcoming.filter((o) => o.status !== 'paid').reduce((a, o) => a + o.amount_cents, 0);
  const month_cents = sumTo(m);

  return {
    today: t,
    totals: {
      today_cents: sumExpenses(db, user.id, { start: t, end: t }).total_cents,
      week_cents: sumTo(weekRange(t)),
      month_cents,
      year_cents: sumTo(yearRange(t)),
    },
    by_category: byCategory,
    months,
    top,
    forecast: {
      logged_future_cents: futureLogged,
      recurring_pending_cents: recurringForecast,
      month_close_cents: month_cents + futureLogged + recurringForecast,
      items: upcoming,
    },
    budgets: budgetStatus(db, user, t),
  };
}
