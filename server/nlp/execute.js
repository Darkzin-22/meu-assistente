import { DateTime } from 'luxon';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { norm } from '../categories.js';
import { brl, toCents } from '../money.js';
import { now, today, addDays, formatDateLong } from '../time.js';
import * as fin from '../finance.js';
import * as rec from '../recurring.js';
import * as ag from '../agenda.js';
import * as cf from '../cashflow.js';
import { parseLocal } from './parse-local.js';
import { parseWithClaude, claudeAvailable } from './llm.js';
import { validateAction, action as mkAction } from './schema.js';
import { nowUtcIso } from '../time.js';

// ---------------------------------------------------------------------------
// Interpretação
// ---------------------------------------------------------------------------

export function aiMode(user) {
  const m = user.settings?.ai_mode || 'auto';
  if (m === 'local') return 'local';
  if (m === 'claude' || m === 'auto') return claudeAvailable() ? 'claude' : 'local';
  return 'local';
}

function buildCtx(db, user) {
  const tz = user.timezone;
  const n = now(tz);
  const recs = db.prepare(`SELECT name, amount_cents, status, frequency FROM recurrences WHERE user_id=?`).all(user.id);
  const upcoming = ag.upcomingEvents(db, user, 25);
  const recent = fin.listExpenses(db, user.id, { start: addDays(today(tz), -10), limit: 25 });
  return {
    timezone: tz,
    now: n,
    today: n.toISODate(),
    nowLabel: n.setLocale('pt-BR').toFormat("cccc, dd 'de' LLLL 'de' yyyy, HH:mm"),
    categories: fin.listCategories(db, user.id, 'expense').map((c) => c.name),
    eventCategories: fin.listCategories(db, user.id, 'event').map((c) => c.name),
    recurrences: recs.filter((r) => r.status !== 'cancelled').map((r) => r.name),
    recurrenceInfo: recs.map((r) => `${r.name} (${brl(r.amount_cents)}, ${r.status === 'active' ? 'ativa' : r.status === 'paused' ? 'pausada' : 'cancelada'})`),
    upcomingInfo: upcoming.map((e) => `${e.title} em ${e.date}${e.time ? ' ' + e.time : ''}`),
    recentExpenses: recent.map((e) => `${e.description} ${brl(e.amount_cents)} em ${e.date}`),
  };
}

export async function interpret(db, user, text) {
  const ctx = buildCtx(db, user);
  const mode = aiMode(user);
  if (mode === 'claude') {
    try {
      const r = await parseWithClaude(text, ctx);
      return { engine: 'claude', actions: r.actions };
    } catch (err) {
      const r = parseLocal(text, ctx);
      return { engine: 'local', fallback_reason: String(err.message || err), actions: r.actions };
    }
  }
  return { engine: 'local', actions: parseLocal(text, ctx).actions };
}

/** Processa um comando de texto/voz completo. Idempotente por client_id. */
export async function runCommand(db, user, text, { client_id = null, source = 'text' } = {}) {
  text = String(text || '').trim().slice(0, 2000);
  if (!text) throw new AppError('Comando vazio.');
  if (client_id) {
    const prev = db.prepare(`SELECT response_json FROM commands WHERE user_id=? AND client_id=?`).get(user.id, client_id);
    if (prev?.response_json) return { ...JSON.parse(prev.response_json), replayed: true };
  }
  const { engine, actions, fallback_reason } = await interpret(db, user, text);
  const results = [];
  for (const a of actions) {
    try {
      results.push(executeAction(db, user, a, { source }));
    } catch (err) {
      results.push({ type: 'error', message: err instanceof AppError ? err.message : 'Erro ao executar o comando.', action: a });
      if (!(err instanceof AppError)) console.error(err);
    }
  }
  const response = { text, engine, fallback_reason: fallback_reason || null, results, message: results.map((r) => r.message).filter(Boolean).join('\n') };
  db.prepare(`INSERT OR IGNORE INTO commands (user_id, client_id, text, engine, response_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(user.id, client_id, text, engine, JSON.stringify(response), nowUtcIso());
  return response;
}

// ---------------------------------------------------------------------------
// Execução de ações (sempre via funções validadas do servidor)
// ---------------------------------------------------------------------------

const done = (message, data = {}, extra = {}) => ({ type: 'done', message, data, ...extra });
const answer = (message, data = {}) => ({ type: 'answer', message, data });
const needsInput = (message, draft, missing) => ({ type: 'needs_input', message, draft, missing });
const confirm = (message, act, data = {}) => ({ type: 'confirm', message, action: act, data });
const choose = (message, options) => ({ type: 'choose', message, options });

function dateLabel(date, tz) {
  const t = today(tz);
  if (date === t) return 'hoje';
  if (date === addDays(t, 1)) return 'amanhã';
  if (date === addDays(t, -1)) return 'ontem';
  return formatDateLong(date);
}

function periodLabel(p, tz) {
  if (!p?.start) return '';
  if (p.start === p.end) return dateLabel(p.start, tz);
  const s = DateTime.fromISO(p.start), e = DateTime.fromISO(p.end);
  if (s.day === 1 && e.equals(s.endOf('month').startOf('day'))) {
    return s.hasSame(now(tz), 'month') ? 'neste mês' : `em ${s.setLocale('pt-BR').toFormat("LLLL 'de' yyyy")}`;
  }
  if (s.ordinal === 1 && e.equals(s.endOf('year').startOf('day'))) return s.year === now(tz).year ? 'neste ano' : `em ${s.year}`;
  return `de ${s.toFormat('dd/LL')} a ${e.toFormat('dd/LL')}`;
}

function evLabel(e, tz) {
  return `${e.title} — ${dateLabel(e.date, tz)}${e.time ? ` às ${e.time}` : ' (dia inteiro)'}`;
}
function expLabel(e, tz) {
  return `${e.description} — ${brl(e.amount_cents)} (${dateLabel(e.date, tz)})`;
}

export function executeAction(db, user, input, { confirmed = false, source = 'text' } = {}) {
  const a = validateAction(input);
  const target_id = input.target_id ? Number(input.target_id) : null;
  const tz = user.timezone;
  const src = source === 'voice' ? 'voice' : source === 'manual' ? 'manual' : 'text';

  switch (a.type) {
    // ------------------------------------------------------------ despesas
    case 'create_expense': {
      if (!a.amount || a.amount <= 0) return needsInput(`Qual foi o valor${a.description ? ` de "${a.description}"` : ''}?`, a, ['amount']);
      if (!a.description) return needsInput('Qual é a descrição da despesa?', a, ['description']);
      const r = fin.createExpense(db, user, {
        description: a.description, amount_cents: toCents(a.amount), date: a.date || today(tz),
        category: a.category, installments: a.installments, source: src, client_id: input.client_id || null,
      });
      const e = r.expenses[0];
      const msg = r.expenses.length > 1
        ? `Registrado: ${a.description} — ${brl(toCents(a.amount))} em ${r.expenses.length}x de ${brl(e.amount_cents)} (${e.category_name}).`
        : `Registrado: ${e.description} — ${brl(e.amount_cents)} em ${e.category_name} (${dateLabel(e.date, tz)}).`;
      return done(msg, { expenses: r.expenses }, { kind: 'expense_created', warnings: r.warnings });
    }
    case 'update_expense': {
      const c = target_id ? [fin.getExpense(db, user.id, target_id)].filter((x) => x && !x.deleted_at) : findExpenses(db, user, a.target);
      if (!c.length) return { type: 'error', message: 'Não encontrei essa despesa. Confira a descrição e a data.' };
      if (c.length > 1) return choose('Encontrei mais de uma despesa. Qual delas?', c.slice(0, 8).map((e) => ({ label: expLabel(e, tz), action: { ...a, target_id: e.id } })));
      const ch = a.changes || {};
      const patch = {};
      if (ch.amount) patch.amount_cents = toCents(ch.amount);
      if (ch.description) patch.description = ch.description;
      if (ch.category) patch.category = ch.category;
      if (ch.date) patch.date = ch.date;
      if (!Object.keys(patch).length) return needsInput('O que você quer alterar nessa despesa?', { ...a, target_id: c[0].id }, ['changes']);
      const before = c[0];
      const r = fin.updateExpense(db, user, before.id, patch, src);
      const what = patch.amount_cents ? `valor de ${brl(before.amount_cents)} para ${brl(patch.amount_cents)}` : patch.category ? `categoria para ${r.expense.category_name}` : patch.date ? `data para ${dateLabel(patch.date, tz)}` : `descrição para "${patch.description}"`;
      return done(`Atualizado: ${before.description} — ${what}.`, { expense: r.expense, before }, { kind: 'expense_updated', warnings: r.warnings });
    }
    case 'delete_expense': {
      const c = target_id ? [fin.getExpense(db, user.id, target_id)].filter((x) => x && !x.deleted_at) : findExpenses(db, user, a.target);
      if (!c.length) return { type: 'error', message: 'Não encontrei essa despesa para apagar.' };
      if (c.length > 1) return choose('Encontrei mais de uma despesa. Qual delas devo apagar?', c.slice(0, 8).map((e) => ({ label: expLabel(e, tz), action: { ...a, target_id: e.id } })));
      if (!confirmed) return confirm(`Apagar ${expLabel(c[0], tz)}?`, { ...a, target_id: c[0].id }, { expense: c[0] });
      fin.deleteExpense(db, user, c[0].id, src);
      return done(`Despesa apagada: ${expLabel(c[0], tz)}. Você pode recuperá-la na lixeira.`, { expense: c[0] }, { kind: 'expense_deleted' });
    }

    // ------------------------------------------------------------ recorrências
    case 'create_recurrence': {
      const missing = [];
      if (!a.name) missing.push('name');
      if (!a.amount) missing.push('amount');
      if (!a.day_of_month && !a.start_date && a.frequency !== 'weekly' && a.frequency !== 'days') missing.push('day_of_month');
      if (missing.length) {
        const q = missing.includes('name') ? 'Qual é o nome dessa assinatura/despesa fixa?' : missing.includes('amount') ? 'Qual é o valor?' : 'Em que dia ela é cobrada?';
        return needsInput(q, a, missing);
      }
      const r = rec.createRecurrence(db, user, {
        name: a.name, amount_cents: toCents(a.amount), frequency: a.frequency || 'monthly', interval: a.interval || 1,
        day_of_month: a.day_of_month, month: a.month, anchor_date: a.start_date || undefined,
        kind: a.kind || 'subscription', category: a.category,
        direction: a.direction || 'expense', auto_confirm: a.direction === 'income',
      }, src);
      const d = rec.listRecurrences(db, user).find((x) => x.id === r.id);
      if (r.direction === 'income') return done(`Cadastrado: ${r.name} de ${brl(r.amount_cents)} (${rec.frequencyLabel(r).toLowerCase()}). Próximo recebimento: ${dateLabel(d.next_due, tz)}. Ele entra automaticamente no seu saldo na data.`, { recurrence: d }, { kind: 'recurrence_created' });
      return done(`Cadastrado: ${r.name} — ${brl(r.amount_cents)} (${rec.frequencyLabel(r).toLowerCase()}). Próxima cobrança: ${dateLabel(d.next_due, tz)}.`, { recurrence: d }, { kind: 'recurrence_created' });
    }
    case 'update_recurrence':
    case 'cancel_recurrence':
    case 'pause_recurrence':
    case 'resume_recurrence':
    case 'pay_recurrence': {
      const name = a.target?.text || a.name;
      const c = target_id ? [rec.getRecurrence(db, user.id, target_id)].filter(Boolean) : name ? rec.findRecurrenceByName(db, user.id, name, { includeEnded: a.type === 'resume_recurrence' }) : [];
      if (!c.length) return { type: 'error', message: `Não encontrei a assinatura${name ? ` "${name}"` : ''}. Veja a lista em Assinaturas.` };
      if (c.length > 1) return choose('Qual delas?', c.slice(0, 8).map((r) => ({ label: `${r.name} — ${brl(r.amount_cents)}`, action: { ...a, target_id: r.id } })));
      const r0 = c[0];
      if (a.type === 'update_recurrence') {
        const ch = a.changes || {};
        const patch = {};
        if (ch.amount) patch.amount_cents = toCents(ch.amount);
        if (ch.day_of_month) patch.day_of_month = ch.day_of_month;
        if (ch.description || ch.title) patch.name = ch.description || ch.title;
        if (!Object.keys(patch).length && a.amount) patch.amount_cents = toCents(a.amount);
        if (!Object.keys(patch).length) return needsInput(`O que mudou em ${r0.name}? (valor ou dia de cobrança)`, { ...a, target_id: r0.id }, ['changes']);
        const r = rec.updateRecurrence(db, user, r0.id, patch, src);
        const parts = [];
        if (patch.amount_cents) parts.push(`valor de ${brl(r0.amount_cents)} para ${brl(r.amount_cents)}`);
        if (patch.day_of_month) parts.push(`cobrança agora todo dia ${patch.day_of_month}`);
        if (patch.name) parts.push(`nome para "${r.name}"`);
        return done(`${r0.name} atualizada: ${parts.join(', ')}. As próximas cobranças já usam o novo valor.`, { recurrence: r }, { kind: 'recurrence_updated' });
      }
      if (a.type === 'cancel_recurrence') {
        const r = rec.setRecurrenceStatus(db, user, r0.id, 'cancelled', src);
        return done(`${r0.name} cancelada. Ela não será mais contabilizada a partir de agora (o histórico foi mantido).`, { recurrence: r }, { kind: 'recurrence_cancelled', undo: { type: 'resume_recurrence', target_id: r0.id } });
      }
      if (a.type === 'pause_recurrence') {
        const r = rec.setRecurrenceStatus(db, user, r0.id, 'paused', src);
        return done(`${r0.name} pausada.`, { recurrence: r }, { kind: 'recurrence_paused' });
      }
      if (a.type === 'resume_recurrence') {
        const r = rec.setRecurrenceStatus(db, user, r0.id, 'active', src);
        return done(`${r0.name} reativada.`, { recurrence: r }, { kind: 'recurrence_resumed' });
      }
      const r = rec.payRecurrence(db, user, r0.id, { amount_cents: a.amount ? toCents(a.amount) : undefined, date: a.date || undefined }, src);
      if (r.already) return answer(`O pagamento de ${r0.name} (${dateLabel(r.charge.due_date, tz)}) já estava registrado.`);
      if (r.income) return done(`Recebimento registrado: ${r0.name} — ${brl(r.income.amount_cents)}.`, { income: r.income, charge: r.charge }, { kind: 'income_created' });
      return done(`Pagamento registrado: ${r0.name} — ${brl(r.expense.amount_cents)} (vencimento ${dateLabel(r.charge.due_date, tz)}).`, { expense: r.expense, charge: r.charge }, { kind: 'charge_paid' });
    }

    // ------------------------------------------------------------ agenda
    case 'create_event': {
      if (!a.title) return needsInput('Qual é o compromisso?', a, ['title']);
      if (!a.date) return needsInput(`Em que dia é "${a.title}"?`, a, ['date', ...(a.time ? [] : ['time'])]);
      if (!a.time && !input.all_day) return needsInput(`Que horas é "${a.title}" (${dateLabel(a.date, tz)})?`, a, ['time']);
      const r = ag.createEvent(db, user, { title: a.title, date: a.date, time: a.time, category: a.category || undefined, location: a.location, duration_min: a.duration_min, source: src, client_id: input.client_id || null });
      const n = r.reminders.filter((x) => x.status === 'pending').length;
      return done(`Agendado: ${evLabel(r.event, tz)}. ${n ? `${n} lembrete${n > 1 ? 's' : ''} programado${n > 1 ? 's' : ''}.` : ''}`.trim(), { event: r.event, reminders: r.reminders }, { kind: 'event_created', warnings: r.warnings });
    }
    case 'update_event':
    case 'cancel_event':
    case 'complete_event': {
      const c = target_id ? [ag.getEvent(db, user.id, target_id)].filter((x) => x && !x.deleted_at) : ag.findEvents(db, user, a.target || {});
      if (!c.length) return { type: 'error', message: 'Não encontrei esse compromisso na agenda.' };
      const verb = a.type === 'cancel_event' ? 'cancelar' : a.type === 'complete_event' ? 'concluir' : 'alterar';
      if (c.length > 1) return choose(`Encontrei ${c.length} compromissos. Qual você quer ${verb}?`, c.slice(0, 8).map((e) => ({ label: evLabel(e, tz), action: { ...a, target_id: e.id } })));
      const e0 = c[0];
      if (a.type === 'cancel_event') {
        if (!confirmed) return confirm(`Desmarcar ${evLabel(e0, tz)}?`, { ...a, target_id: e0.id }, { event: e0 });
        const r = ag.cancelEvent(db, user, e0.id, src);
        return done(`Compromisso desmarcado: ${evLabel(e0, tz)}. Os lembretes foram cancelados.`, { event: r.event }, { kind: 'event_cancelled' });
      }
      if (a.type === 'complete_event') {
        const r = ag.updateEvent(db, user, e0.id, { status: 'done' }, src);
        return done(`Concluído: ${e0.title}.`, { event: r.event }, { kind: 'event_completed' });
      }
      const ch = a.changes || {};
      const patch = {};
      if (ch.date) patch.date = ch.date;
      if (ch.time) patch.time = ch.time;
      if (ch.title) patch.title = ch.title;
      if (!Object.keys(patch).length) return needsInput(`Para quando devo remarcar "${e0.title}"?`, { ...a, target_id: e0.id }, ['date', 'time']);
      const r = ag.updateEvent(db, user, e0.id, patch, src);
      const n = r.reminders.filter((x) => x.status === 'pending').length;
      return done(`Remarcado: ${e0.title} — agora ${dateLabel(r.event.date, tz)}${r.event.time ? ` às ${r.event.time}` : ''}. Lembretes atualizados (${n}).`, { event: r.event, before: e0, reminders: r.reminders }, { kind: 'event_updated' });
    }

    // ------------------------------------------------------------ consultas
    case 'query_expenses': {
      const t = today(tz);
      const p = a.period?.start ? a.period : { start: DateTime.fromISO(t).startOf('month').toISODate(), end: t };
      const cat = a.category ? fin.findCategory(db, user.id, 'expense', a.category) : null;
      let list = fin.listExpenses(db, user.id, { start: p.start, end: p.end, category_id: cat?.id, q: !cat && a.text ? a.text : undefined, limit: 1000 });
      if (!cat && a.text && !list.length) list = [];
      const total = list.reduce((s, e) => s + e.amount_cents, 0);
      const pl = periodLabel(p, tz);
      const subject = cat ? ` com ${cat.name}` : a.text ? ` com "${a.text}"` : '';
      let msg = list.length
        ? `Você gastou ${brl(total)}${subject} ${pl} (${list.length} lançamento${list.length > 1 ? 's' : ''}).`
        : `Nenhum gasto${subject} ${pl}.`;
      if (list.length && (a.description === 'list' || list.length <= 5)) msg += '\n' + list.slice(0, 10).map((e) => `• ${expLabel(e, tz)}`).join('\n');
      return answer(msg, { total_cents: total, expenses: list.slice(0, 50), period: p, category: cat });
    }
    case 'query_events': {
      const t = today(tz);
      const p = a.period?.start ? a.period : { start: t, end: addDays(t, 7) };
      let list = ag.listEvents(db, user.id, { start: p.start, end: p.end }).filter((e) => e.status === 'scheduled');
      if (a.text) {
        const words = norm(a.text).split(/\W+/).filter((w) => w.length > 2);
        const f = list.filter((e) => words.some((w) => norm(`${e.title} ${e.category_name}`).includes(w)));
        if (f.length) list = f;
      }
      const pl = a.period?.start ? periodLabel(p, tz) : 'nos próximos 7 dias';
      const msg = list.length
        ? `Você tem ${list.length} compromisso${list.length > 1 ? 's' : ''} ${pl}:\n` + list.map((e) => `• ${evLabel(e, tz)}`).join('\n')
        : `Você não tem compromissos ${pl}.`;
      return answer(msg, { events: list, period: p });
    }
    case 'query_recurrences': {
      const all = rec.listRecurrences(db, user).filter((r) => r.status === 'active' && r.direction !== 'income');
      const cat = a.category ? fin.findCategory(db, user.id, 'expense', a.category) : null;
      let list = all;
      if (a.kind) list = list.filter((r) => r.kind === a.kind);
      if (cat) list = list.filter((r) => r.category_id === cat.id);
      const label = cat ? `com ${cat.name.toLowerCase()}` : a.kind === 'subscription' ? 'com assinaturas' : a.kind === 'fixed' ? 'com despesas fixas' : 'com assinaturas e despesas fixas';
      if (a.within_days !== null && a.within_days !== undefined) {
        const t = today(tz);
        const end = addDays(t, a.within_days);
        const ids = new Set(list.map((r) => r.id));
        const items = rec.forecast(db, user, t, end).filter((o) => ids.has(o.recurrence_id) && o.status !== 'paid');
        const overdue = db.prepare(`SELECT ch.*, r.name FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id WHERE ch.user_id=? AND ch.status='pending' AND ch.due_date < ?`).all(user.id, t).filter((o) => ids.has(o.recurrence_id));
        const all2 = [...overdue.map((o) => ({ ...o, status: 'overdue' })), ...items];
        const total = all2.reduce((s, o) => s + o.amount_cents, 0);
        const msg = all2.length
          ? `${all2.length} cobrança${all2.length > 1 ? 's' : ''} nos próximos ${a.within_days} dias (${brl(total)}):\n` + all2.map((o) => `• ${o.name} — ${brl(o.amount_cents)} (${o.status === 'overdue' ? 'pendente desde ' : ''}${dateLabel(o.due_date, tz)})`).join('\n')
          : `Nenhuma cobrança nos próximos ${a.within_days} dias.`;
        return answer(msg, { items: all2, total_cents: total });
      }
      const monthly = Math.round(list.reduce((s, r) => s + r.monthly_cents, 0));
      const msg = list.length
        ? `Você gasta ${brl(monthly)} por mês ${label} (${brl(monthly * 12)} por ano), em ${list.length} item${list.length > 1 ? 's' : ''}:\n` + list.map((r) => `• ${r.name} — ${brl(r.amount_cents)} (${r.frequency_label.toLowerCase()})`).join('\n')
        : `Nenhuma assinatura ou despesa fixa ativa ${label}.`;
      return answer(msg, { monthly_cents: monthly, yearly_cents: monthly * 12, recurrences: list });
    }
    case 'forecast': {
      const t = today(tz);
      const p = a.period?.start ? a.period : { start: t, end: DateTime.fromISO(t).endOf('month').toISODate() };
      const items = rec.forecast(db, user, p.start, p.end).filter((o) => o.status !== 'paid' && o.direction !== 'income');
      const recurring = items.reduce((s, o) => s + o.amount_cents, 0);
      const logged = fin.listExpenses(db, user.id, { start: p.start > t ? p.start : addDays(t, 1), end: p.end });
      const loggedTotal = logged.reduce((s, e) => s + e.amount_cents, 0);
      const pl = periodLabel(p, tz);
      let msg = `Previsão ${pl}: ${brl(recurring + loggedTotal)}`;
      msg += ` — ${brl(recurring)} em assinaturas e despesas fixas (${items.length} cobrança${items.length === 1 ? '' : 's'})`;
      if (loggedTotal) msg += ` + ${brl(loggedTotal)} em despesas já lançadas (parcelas)`;
      msg += '.';
      if (items.length) msg += '\n' + items.slice(0, 12).map((o) => `• ${o.name} — ${brl(o.amount_cents)} (${dateLabel(o.due_date, tz)})`).join('\n');
      return answer(msg, { total_cents: recurring + loggedTotal, recurring_cents: recurring, logged_cents: loggedTotal, items, period: p });
    }
    // ------------------------------------------------------------ rendimentos e saldo
    case 'create_income': {
      if (!a.amount || a.amount <= 0) return needsInput(`Qual foi o valor recebido${a.description ? ` (${a.description})` : ''}?`, a, ['amount']);
      const inc = cf.createIncome(db, user, { description: a.description, amount_cents: toCents(a.amount), date: a.date || today(tz), source: src, client_id: input.client_id || null });
      return done(`Entrada registrada: ${inc.description} — ${brl(inc.amount_cents)} (${dateLabel(inc.date, tz)}).`, { income: inc }, { kind: 'income_created' });
    }
    case 'set_balance': {
      if (a.amount === null || a.amount === undefined) return needsInput('Qual é o saldo atual?', a, ['amount']);
      const acc = cf.setAccountBalance(db, user, { name: a.name, amount_cents: toCents(a.amount) });
      const sum = cf.balanceSummary(db, user);
      const extra = sum.accounts.length > 1 ? ` Saldo total: ${brl(sum.estimated_cents)}.` : '';
      return done(`Saldo atualizado: ${acc.name} — ${brl(acc.balance_cents)}.${extra}`, { account: acc }, { kind: 'balance_set' });
    }
    case 'query_balance': {
      const b = cf.balanceSummary(db, user);
      if (!b.accounts.length) return answer('Você ainda não informou nenhum saldo. Diga, por exemplo: "meu saldo no Nubank é 2.300 reais".');
      let msg = `Seu saldo estimado é ${brl(b.estimated_cents)}.`;
      if (b.incomes_since_cents || b.expenses_since_cents) msg += ` Desde o último saldo informado entraram ${brl(b.incomes_since_cents)} e saíram ${brl(b.expenses_since_cents)}.`;
      if (b.accounts.length > 1) msg += '\n' + b.accounts.map((x) => `• ${x.name}: ${brl(x.balance_cents)} (informado ${dateLabel(DateTime.fromISO(x.balance_at).setZone(tz).toISODate(), tz)})`).join('\n');
      return answer(msg, b);
    }
    case 'query_income': {
      const t = today(tz);
      const p = a.period?.start ? a.period : { start: DateTime.fromISO(t).startOf('month').toISODate(), end: DateTime.fromISO(t).endOf('month').toISODate() };
      const sm = cf.periodSummary(db, user, p);
      const list = cf.listIncomes(db, user.id, { start: p.start, end: sm.end });
      const pl = periodLabel(p, tz);
      let msg = `${pl[0].toUpperCase()}${pl.slice(1)} você recebeu ${brl(sm.income_cents)} e gastou ${brl(sm.expense_cents)}. `;
      msg += sm.net_cents >= 0 ? `Sobraram ${brl(sm.net_cents)}.` : `Faltaram ${brl(-sm.net_cents)}.`;
      if (list.length && list.length <= 6) msg += '\n' + list.map((i) => `• ${i.description} — ${brl(i.amount_cents)} (${dateLabel(i.date, tz)})`).join('\n');
      const upcoming = rec.forecast(db, user, addDays(t, 1), p.end).filter((o) => o.direction === 'income' && o.status !== 'paid');
      if (upcoming.length) msg += `\nAinda vai entrar: ${upcoming.map((o) => `${o.name} ${brl(o.amount_cents)} (${dateLabel(o.due_date, tz)})`).join(', ')}.`;
      return answer(msg, { ...sm, incomes: list });
    }
    case 'search': {
      const q = a.text || '';
      const exps = fin.listExpenses(db, user.id, { q, limit: 20 });
      const evs = ag.listEvents(db, user.id, { q, includeCancelled: true, limit: 20 });
      const recs = rec.findRecurrenceByName(db, user.id, q, { includeEnded: true });
      const total = exps.length + evs.length + recs.length;
      let msg = total ? `Resultados para "${q}":` : `Nada encontrado para "${q}".`;
      if (exps.length) msg += '\n' + exps.slice(0, 5).map((e) => `• ${expLabel(e, tz)}`).join('\n');
      if (evs.length) msg += '\n' + evs.slice(0, 5).map((e) => `• ${evLabel(e, tz)}`).join('\n');
      if (recs.length) msg += '\n' + recs.slice(0, 5).map((r) => `• ${r.name} — ${brl(r.amount_cents)}`).join('\n');
      return answer(msg, { expenses: exps, events: evs, recurrences: recs });
    }
    case 'clarify':
    default:
      return { type: 'clarify', message: a.question || 'Não entendi. Pode reformular?' };
  }
}

/** Procura despesas a partir de pistas (descrição, data, categoria, valor). */
function findExpenses(db, user, target) {
  const tz = user.timezone;
  const t = today(tz);
  const tg = target || {};
  const cat = tg.category ? fin.findCategory(db, user.id, 'expense', tg.category) : null;
  let rows = fin.listExpenses(db, user.id, tg.date ? { start: tg.date, end: tg.date, category_id: cat?.id } : { start: addDays(t, -45), end: addDays(t, 400), category_id: cat?.id, limit: 1000 });
  if (tg.amount) {
    const cents = toCents(tg.amount);
    const f = rows.filter((e) => e.amount_cents === cents);
    if (f.length) rows = f;
  }
  const words = norm(tg.text || '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['despesa', 'gasto', 'compra', 'valor', 'para', 'com', 'que', 'reais'].includes(w));
  if (words.length) {
    const scored = rows.map((e) => ({ e, s: words.filter((w) => norm(`${e.description} ${e.category_name || ''}`).includes(w)).length })).filter((x) => x.s > 0);
    if (!scored.length) return [];
    const best = Math.max(...scored.map((x) => x.s));
    rows = scored.filter((x) => x.s === best).map((x) => x.e);
  } else if (!tg.date && !cat && !tg.amount) {
    return [];
  }
  return rows;
}

export { mkAction };
export const _engineInfo = () => ({ claude: claudeAvailable(), model: config.claudeModel });
