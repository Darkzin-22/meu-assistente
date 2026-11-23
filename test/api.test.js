import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-test-'));
process.env.ANTHROPIC_API_KEY = ''; // testes usam o interpretador local (determinístico)

const { openDb } = await import('../server/db.js');
const { buildApp } = await import('../server/app.js');
const { setNow } = await import('../server/time.js');
const { setPushSender } = await import('../server/push.js');
const { sendDueReminders } = await import('../server/scheduler.js');
const { loadUser } = await import('../server/auth.js');
const { materializeCharges } = await import('../server/recurring.js');

const dbFile = path.join(process.env.DATA_DIR, 'test.db');
let db, app, cookie;
const pushed = [];

async function call(method, url, body, { raw = false, headers = {} } = {}) {
  const res = await app.inject({
    method, url,
    headers: { 'x-requested-with': 'fetch', ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    payload: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const data = res.headers['content-type']?.includes('json') ? res.json() : res.body;
  if (res.statusCode >= 400) throw Object.assign(new Error(`${res.statusCode} ${JSON.stringify(data)}`), { status: res.statusCode, data });
  return data;
}
const cmd = (text, extra = {}) => call('POST', '/api/command', { text, ...extra });
const exec = (action, confirmed = false) => call('POST', '/api/actions/execute', { action, confirmed });
const user = () => loadUser(db, 1);

before(async () => {
  setNow('2026-11-23T09:00:00-03:00'); // segunda-feira
  db = openDb(dbFile);
  app = await buildApp(db, { serveStatic: false });
  setPushSender(async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });
});
after(async () => { await app.close(); db.close(); setNow(null); });
beforeEach(() => setNow('2026-11-23T09:00:00-03:00'));

test('cadastro, login e proteção', async () => {
  const st = await call('GET', '/api/auth/status');
  assert.equal(st.needsSetup, true);
  const res = await call('POST', '/api/auth/register', { email: 'eu@exemplo.com', name: 'Eu', password: 'senha-forte-123' }, { raw: true });
  assert.equal(res.statusCode, 200);
  const sc = res.headers['set-cookie'];
  assert.match(sc, /HttpOnly/i);
  cookie = sc.split(';')[0];
  // segundo cadastro bloqueado
  const r2 = await call('POST', '/api/auth/register', { email: 'outro@exemplo.com', password: 'outra-senha-123' }, { raw: true, headers: { cookie: '' } });
  assert.equal(r2.statusCode, 403);
  // sem cookie → 401
  const saved = cookie; cookie = null;
  assert.equal((await call('GET', '/api/me', null, { raw: true })).statusCode, 401);
  // senha errada → 401
  assert.equal((await call('POST', '/api/auth/login', { email: 'eu@exemplo.com', password: 'errada' }, { raw: true })).statusCode, 401);
  cookie = saved;
  // CSRF: mutação sem cabeçalho → 403
  const r3 = await app.inject({ method: 'POST', url: '/api/command', headers: { cookie, 'content-type': 'application/json' }, payload: '{"text":"x"}' });
  assert.equal(r3.statusCode, 403);
  const me = await call('GET', '/api/me');
  assert.equal(me.user.timezone, 'America/Sao_Paulo');
  assert.equal(me.capabilities.engine, 'local');
});

test('despesa por comando: açaí de 8 reais', async () => {
  const r = await cmd('Hoje comprei um açaí de 8 reais.', { source: 'voice' });
  assert.equal(r.results[0].type, 'done');
  const e = r.results[0].data.expenses[0];
  assert.equal(e.description, 'Açaí');
  assert.equal(e.amount_cents, 800);
  assert.equal(e.category_name, 'Alimentação');
  assert.equal(e.date, '2026-11-23');
  assert.equal(e.source, 'voice');
  const list = await call('GET', '/api/expenses');
  assert.equal(list.expenses.length, 1);
});

test('idempotência: mesmo comando reenviado (sincronização offline) não duplica', async () => {
  await cmd('Gastei 80 reais com gasolina.', { client_id: 'abc-1' });
  const again = await cmd('Gastei 80 reais com gasolina.', { client_id: 'abc-1' });
  assert.equal(again.replayed, true);
  const list = await call('GET', '/api/expenses?q=Gasolina');
  assert.equal(list.expenses.length, 1);
});

test('duas despesas numa frase + corrigir + apagar com confirmação + lixeira', async () => {
  const r = await cmd('Gastei 20 reais em um lanche e 35 reais de gasolina.');
  assert.equal(r.results.length, 2);
  const up = await cmd('Corrija o valor do açaí de hoje para 12 reais.');
  assert.equal(up.results[0].type, 'done', JSON.stringify(up.results[0]));
  assert.equal(up.results[0].data.expense.amount_cents, 1200);

  setNow('2026-11-22T12:00:00-03:00');
  await cmd('Gastei 45 reais almoçando.');
  setNow('2026-11-23T09:00:00-03:00');
  const del = await cmd('Apague a despesa de alimentação de ontem.');
  assert.equal(del.results[0].type, 'confirm');
  // ainda não apagou
  assert.equal((await call('GET', '/api/expenses?start=2026-11-22&end=2026-11-22')).expenses.length, 1);
  const ok = await exec(del.results[0].action, true);
  assert.equal(ok.result.type, 'done');
  assert.equal((await call('GET', '/api/expenses?start=2026-11-22&end=2026-11-22')).expenses.length, 0);
  const trash = await call('GET', '/api/expenses/trash');
  assert.equal(trash.expenses.length, 1);
  await call('POST', `/api/expenses/${trash.expenses[0].id}/restore`);
  assert.equal((await call('GET', '/api/expenses?start=2026-11-22&end=2026-11-22')).expenses.length, 1);
});

test('totais do painel: hoje, semana, mês, ano', async () => {
  // Hoje (23/11): açaí 12 + gasolina 80 + lanche 20 + gasolina 35 = 147
  // Ontem (22/11, domingo — semana anterior): almoço 45
  await call('POST', '/api/expenses', { description: 'Cinema', amount: '30,00', date: '2026-11-02', category: 'Lazer' });
  await call('POST', '/api/expenses', { description: 'Tênis', amount: 300, date: '2026-10-15', category: 'Roupas e acessórios' });
  const d = await call('GET', '/api/dashboard');
  assert.equal(d.stats.totals.today_cents, 14700);
  assert.equal(d.stats.totals.week_cents, 14700);
  assert.equal(d.stats.totals.month_cents, 14700 + 4500 + 3000);
  assert.equal(d.stats.totals.year_cents, 14700 + 4500 + 3000 + 30000);
  const oct = d.stats.months.find((m) => m.month === '2026-10');
  assert.equal(oct.total_cents, 30000);
  const alim = d.stats.by_category.find((c) => c.name === 'Alimentação');
  assert.equal(alim.total, 1200 + 2000 + 4500);
});

test('consulta por voz: quanto gastei com namorada neste mês', async () => {
  await cmd('Ontem comprei um presente de 150 reais para minha namorada.');
  const r = await cmd('Quanto gastei com minha namorada neste mês?');
  assert.equal(r.results[0].type, 'answer');
  assert.equal(r.results[0].data.total_cents, 15000);
  assert.match(r.message, /R\$\s?150,00/);
});

test('parcelado: 1200 em 6x', async () => {
  const r = await cmd('Comprei um celular de 1200 reais em 6 vezes');
  const ex = r.results[0].data.expenses;
  assert.equal(ex.length, 6);
  assert.deepEqual(ex.map((e) => e.date), ['2026-11-23', '2026-12-23', '2027-01-23', '2027-02-23', '2027-03-23', '2027-04-23']);
  assert.ok(ex.every((e) => e.amount_cents === 20000));
  const f = await cmd('Quanto vou gastar no próximo mês contando minhas despesas fixas?');
  assert.equal(f.results[0].data.logged_cents, 20000);
});

test('assinaturas: cadastro, cobrança sem duplicar, confirmação, aumento, cancelamento', async () => {
  const r = await cmd('Cadastre minha assinatura da Netflix por 39 reais mensais, todo dia 15.');
  assert.equal(r.results[0].type, 'done', JSON.stringify(r.results[0]));
  const netflix = r.results[0].data.recurrence;
  assert.equal(netflix.next_due, '2026-12-15');
  // Assinatura sem nome → pede o nome, depois cria
  const q = await cmd('Tenho uma assinatura que custa 110 reais por mês e é cobrada todo dia 23.');
  assert.equal(q.results[0].type, 'needs_input');
  const c = await exec({ ...q.results[0].draft, name: 'Claude' });
  assert.equal(c.result.type, 'done');
  // Dia 23 é hoje → primeira cobrança já está pendente (prevista até confirmação)
  let recs = (await call('GET', '/api/recurrences')).recurrences;
  const claude = recs.find((x) => x.name === 'Claude');
  assert.equal(claude.pending_charges.length, 1);
  assert.equal(claude.pending_charges[0].due_date, '2026-11-23');
  // Academia
  await cmd('Minha academia custa 150 reais por mês e vence todo dia 10.');

  // Avança 2 meses; materializa várias vezes → nada duplica
  setNow('2027-01-20T09:00:00-03:00');
  for (let i = 0; i < 5; i++) materializeCharges(db, user());
  await call('GET', '/api/recurrences');
  const ch = db.prepare(`SELECT r.name, ch.due_date FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id ORDER BY r.name, ch.due_date`).all();
  assert.deepEqual(ch.filter((x) => x.name === 'Netflix').map((x) => x.due_date), ['2026-12-15', '2027-01-15']);
  assert.deepEqual(ch.filter((x) => x.name === 'Claude').map((x) => x.due_date), ['2026-11-23', '2026-12-23']);
  assert.deepEqual(ch.filter((x) => x.name === 'Academia').map((x) => x.due_date), ['2026-12-10', '2027-01-10']);
  // Pendentes não contam como gasto realizado
  const before = (await call('GET', '/api/dashboard')).stats.totals.month_cents;
  // Confirmar pagamento da academia (cobrança mais antiga pendente)
  const pay = await cmd('Paguei a academia');
  assert.equal(pay.results[0].type, 'done', JSON.stringify(pay.results[0]));
  assert.equal(pay.results[0].data.charge.due_date, '2026-12-10');
  const pay2 = await cmd('Paguei a academia');
  assert.equal(pay2.results[0].data.charge.due_date, '2027-01-10');
  const after1 = (await call('GET', '/api/dashboard')).stats.totals.month_cents;
  assert.equal(after1 - before, 15000); // só a de janeiro entra no mês corrente
  // Confirmar a mesma cobrança de novo → não duplica
  const chargeId = pay2.results[0].data.charge.id;
  const again = await call('POST', `/api/charges/${chargeId}/confirm`);
  assert.equal(again.already, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM expenses WHERE charge_id=?`).get(chargeId).n, 1);

  // Aumento de preço
  const inc = await cmd('Minha assinatura do Claude aumentou para 130 reais.');
  assert.equal(inc.results[0].type, 'done', JSON.stringify(inc.results[0]));
  recs = (await call('GET', '/api/recurrences')).recurrences;
  assert.equal(recs.find((x) => x.name === 'Claude').amount_cents, 13000);
  // Previsão de fevereiro: Netflix 39 + Claude 130 + Academia 150 + parcela 200
  const f = await call('GET', '/api/forecast?start=2027-02-01&end=2027-02-28');
  assert.equal(f.total_cents, 3900 + 13000 + 15000);
  // Totais mensais/anuais
  const tot = (await call('GET', '/api/recurrences')).totals;
  assert.equal(tot.subscriptions_monthly_cents, 3900 + 13000);
  assert.equal(tot.fitness_monthly_cents, 15000);
  assert.equal(tot.fitness_yearly_cents, 180000);
  const qa = await cmd('Quanto estou gastando por mês com assinaturas?');
  assert.equal(qa.results[0].data.monthly_cents, 16900);
  const qv = await cmd('Quais assinaturas vencem nos próximos 7 dias?');
  assert.ok(qv.results[0].data.items.some((i) => i.name === 'Claude' && i.due_date === '2027-01-23'));

  // Cancelar Netflix → nenhuma cobrança nova depois
  const cn = await cmd('Cancelei minha assinatura da Netflix.');
  assert.equal(cn.results[0].type, 'done', JSON.stringify(cn.results[0]));
  setNow('2027-04-20T09:00:00-03:00');
  materializeCharges(db, user());
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id WHERE r.name='Netflix'`).get().n, 2);
});

test('mensal no dia 31 respeita meses curtos', async () => {
  const { occurrences } = await import('../server/recurring.js');
  const r = { anchor_date: '2027-01-31', frequency: 'monthly', interval: 1 };
  assert.deepEqual(occurrences(r, '2027-01-01', '2027-05-31'), ['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  const y = { anchor_date: '2027-03-05', frequency: 'yearly', interval: 1 };
  assert.deepEqual(occurrences(y, '2027-01-01', '2029-12-31'), ['2027-03-05', '2028-03-05', '2029-03-05']);
  const w = { anchor_date: '2026-11-26', frequency: 'weekly', interval: 2 };
  assert.deepEqual(occurrences(w, '2026-11-01', '2026-12-31'), ['2026-11-26', '2026-12-10', '2026-12-24']);
});

test('compromisso por comando + 4 lembretes nos horários exatos', async () => {
  const r = await cmd('Dia 25 de dezembro me lembre que tenho que passar no mercado às 4 da tarde.', { source: 'voice' });
  assert.equal(r.results[0].type, 'done', JSON.stringify(r.results[0]));
  const ev = r.results[0].data.event;
  assert.equal(ev.title, 'Passar no mercado');
  assert.equal(ev.icon, 'cart');
  const rem = r.results[0].data.reminders.map((x) => [x.kind, x.fire_at]);
  // São Paulo = UTC-3 (sem horário de verão)
  assert.deepEqual(rem, [
    ['d5', '2026-12-20T13:00:00.000Z'], // 20/12 10h
    ['d1', '2026-12-24T13:00:00.000Z'], // 24/12 10h
    ['h2', '2026-12-25T17:00:00.000Z'], // 25/12 14h
    ['m10', '2026-12-25T18:50:00.000Z'], // 25/12 15h50
  ]);
  const body = r.results[0].data.reminders[0].body;
  assert.match(body, /Daqui a 5 dias/);
  assert.match(body, /25\/12 às 16h00/);
});

test('compromisso criado tarde programa só os lembretes futuros', async () => {
  setNow('2026-12-24T11:00:00-03:00');
  const r = await cmd('Marque cabeleireiro amanhã às 16h');
  const kinds = r.results[0].data.reminders.map((x) => x.kind);
  assert.deepEqual(kinds, ['h2', 'm10']);
});

test('sem horário → pergunta; depois cria', async () => {
  const r = await cmd('Me lembre de pagar o boleto dia 30');
  assert.equal(r.results[0].type, 'needs_input');
  assert.deepEqual(r.results[0].missing, ['time']);
  const c = await exec({ ...r.results[0].draft, time: '09:00' });
  assert.equal(c.result.type, 'done');
  assert.equal(c.result.data.event.date, '2026-11-30');
});

test('remarcar atualiza lembretes; desmarcar pede confirmação e cancela lembretes', async () => {
  const c = await cmd('Marque consulta no dentista amanhã às 10h');
  const id = c.results[0].data.event.id;
  const r = await cmd('Remarque minha consulta de amanhã para sexta-feira às 15 horas.');
  assert.equal(r.results[0].type, 'done', JSON.stringify(r.results[0]));
  assert.equal(r.results[0].data.event.date, '2026-11-27');
  assert.equal(r.results[0].data.event.time, '15:00');
  const pend = db.prepare(`SELECT kind, fire_at FROM reminders WHERE event_id=? AND status='pending' ORDER BY fire_at`).all(id);
  assert.deepEqual(pend.map((p) => [p.kind, p.fire_at]), [
    ['d1', '2026-11-26T13:00:00.000Z'],
    ['h2', '2026-11-27T16:00:00.000Z'],
    ['m10', '2026-11-27T17:50:00.000Z'],
  ]); // d5 (22/11) já passou
  const d = await cmd('Desmarque minha consulta de sexta.');
  assert.equal(d.results[0].type, 'confirm');
  await exec(d.results[0].action, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM reminders WHERE event_id=? AND status='pending'`).get(id).n, 0);
  assert.equal(db.prepare(`SELECT status FROM events WHERE id=?`).get(id).status, 'cancelled');
});

test('vários compromissos no mesmo dia → pergunta qual', async () => {
  await cmd('Marque reunião com cliente dia 3 de dezembro às 9h');
  await cmd('Marque almoço com a namorada dia 3 de dezembro ao meio-dia');
  const r = await cmd('Desmarque meu compromisso do dia 3 de dezembro');
  assert.equal(r.results[0].type, 'choose');
  assert.equal(r.results[0].options.length, 2);
  const pick = await exec(r.results[0].options[1].action);
  assert.equal(pick.result.type, 'confirm');
  const q = await cmd('Tenho algum compromisso dia 3 de dezembro?');
  assert.equal(q.results[0].data.events.length, 2);
  const nat = await cmd('Tenho algum compromisso marcado para o Natal?');
  assert.equal(nat.results[0].data.events.length, 2); // mercado + cabeleireiro
});

test('entrega dos lembretes: envia no horário, uma única vez, e descarta cancelados', async () => {
  await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'BPk', auth: 'xyz' } } });
  pushed.length = 0;
  // Antes do horário: nada
  setNow('2026-12-20T09:59:00-03:00');
  await sendDueReminders(db);
  assert.equal(pushed.filter((p) => p.title === 'Passar no mercado').length, 0);
  // No horário (20/12 10h)
  setNow('2026-12-20T10:00:20-03:00');
  await sendDueReminders(db);
  const m = pushed.filter((p) => p.title === 'Passar no mercado');
  assert.equal(m.length, 1);
  assert.match(m[0].body, /Daqui a 5 dias/);
  await sendDueReminders(db); // segunda execução: não reenviar
  assert.equal(pushed.filter((p) => p.title === 'Passar no mercado').length, 1);
  // Os outros três
  for (const t of ['2026-12-24T10:00:30-03:00', '2026-12-25T14:00:30-03:00', '2026-12-25T15:50:30-03:00']) {
    setNow(t);
    await sendDueReminders(db);
  }
  const all = pushed.filter((p) => p.title === 'Passar no mercado').map((p) => p.body.split(' — ')[0]);
  assert.deepEqual(all, ['Daqui a 5 dias', 'É amanhã', 'Em 2 horas', 'Em 10 minutos']);
  const st = await call('GET', '/api/push/status');
  assert.ok(st.recent.some((r) => r.status === 'sent'));
});

test('assinatura expirada (410) é removida', async () => {
  setPushSender(async () => { throw Object.assign(new Error('Gone'), { statusCode: 410 }); });
  const r = await call('POST', '/api/push/test');
  assert.equal(r.failed, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM push_subscriptions`).get().n, 0);
  setPushSender(async (sub, payload) => { pushed.push(JSON.parse(payload)); });
});

test('exportação CSV/Excel e .ics', async () => {
  const csv = await call('GET', '/api/export/expenses.csv', null, { raw: true });
  assert.equal(csv.statusCode, 200);
  assert.ok(csv.body.startsWith('﻿Data;Descrição;Categoria;Valor (R$)'));
  assert.match(csv.body, /Açaí;Alimentação;12,00/);
  const xlsx = await call('GET', '/api/export/expenses.xlsx', null, { raw: true });
  assert.equal(xlsx.rawPayload.subarray(0, 2).toString(), 'PK');
  const evs = (await call('GET', '/api/events?start=2026-12-25&end=2026-12-25')).events;
  const ics = await call('GET', `/api/events/${evs[0].id}/ics`, null, { raw: true });
  assert.match(ics.body, /BEGIN:VEVENT/);
  assert.match(ics.body, /DTSTART:20261225T190000Z/);
  assert.equal((ics.body.match(/BEGIN:VALARM/g) || []).length, 4);
  const me = await call('GET', '/api/me');
  const feed = await app.inject({ method: 'GET', url: `/api/feed/${me.user.feed_token}.ics` });
  assert.equal(feed.statusCode, 200);
  assert.match(feed.body, /Passar no mercado/);
  assert.equal((await app.inject({ method: 'GET', url: '/api/feed/token-errado.ics' })).statusCode, 404);
});

test('categorias: criar, editar orçamento, alerta de orçamento, excluir', async () => {
  const c = await call('POST', '/api/categories', { kind: 'expense', name: 'Pets', icon: 'paw', color: '#FF9F0A' });
  await call('PATCH', `/api/categories/${c.id}`, { budget: 100 });
  const r = await call('POST', '/api/expenses', { description: 'Ração', amount: 90, category_id: c.id, date: '2026-11-20' });
  assert.match(r.warnings.join(), /90%/);
  const r2 = await call('POST', '/api/expenses', { description: 'Veterinário', amount: 50, category_id: c.id, date: '2026-11-21' });
  assert.match(r2.warnings.join(), /ultrapassado/);
  await call('DELETE', `/api/categories/${c.id}`);
  const moved = (await call('GET', '/api/expenses?q=Ração')).expenses[0];
  assert.equal(moved.category_name, 'Outros');
});

test('backup e restauração', async () => {
  const backup = await call('GET', '/api/backup');
  const n = backup.expenses.length;
  assert.ok(n > 5);
  await call('DELETE', `/api/expenses/${backup.expenses[0].id}/purge`, null, { raw: true }); // precisa estar na lixeira → erro esperado
  await call('POST', '/api/restore', { confirm: 'RESTAURAR', data: backup });
  assert.equal((await call('GET', '/api/backup')).expenses.length, n);
  const bad = await call('POST', '/api/restore', { data: backup }, { raw: true });
  assert.equal(bad.statusCode, 400);
});

test('persistência: dados continuam após fechar e reabrir o banco', async () => {
  const count = db.prepare(`SELECT COUNT(*) n FROM expenses`).get().n;
  const evs = db.prepare(`SELECT COUNT(*) n FROM events`).get().n;
  await app.close();
  db.close();
  db = openDb(dbFile);
  app = await buildApp(db, { serveStatic: false });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM expenses`).get().n, count);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM events`).get().n, evs);
  // a sessão (cookie) também continua válida
  const me = await call('GET', '/api/me');
  assert.equal(me.user.email, 'eu@exemplo.com');
});

test('histórico de alterações registrado', async () => {
  const a = await call('GET', '/api/audit?limit=500');
  const actions = new Set(a.entries.map((e) => `${e.entity}:${e.action}`));
  for (const k of ['expense:create', 'expense:update', 'expense:delete', 'expense:restore', 'recurrence:create', 'recurrence:update', 'recurrence:cancel', 'event:create', 'event:reschedule', 'event:cancel', 'charge:confirm']) {
    assert.ok(actions.has(k), `faltou ${k}`);
  }
});
