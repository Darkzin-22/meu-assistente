import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseLocal } from '../server/nlp/parse-local.js';
import { DEFAULT_EXPENSE_CATEGORIES } from '../server/categories.js';

// "Hoje" = segunda-feira, 23/11/2026, 09:00 em São Paulo
const ctx = {
  timezone: 'America/Sao_Paulo',
  now: DateTime.fromISO('2026-11-23T09:00:00', { zone: 'America/Sao_Paulo' }),
  categories: DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name),
  recurrences: ['Netflix', 'Claude', 'Spotify', 'Academia'],
};
const p = (s, extra = {}) => parseLocal(s, { ...ctx, ...extra }).actions;
const one = (s, extra) => {
  const a = p(s, extra);
  assert.equal(a.length, 1, `esperava 1 ação para "${s}", veio ${JSON.stringify(a)}`);
  return a[0];
};

test('despesa simples: açaí de 8 reais', () => {
  const a = one('Hoje comprei um açaí de 8 reais.');
  assert.equal(a.type, 'create_expense');
  assert.equal(a.description, 'Açaí');
  assert.equal(a.amount, 8);
  assert.equal(a.category, 'Alimentação');
  assert.equal(a.date, '2026-11-23');
});

test('gastei 45 reais almoçando', () => {
  const a = one('Hoje gastei 45 reais almoçando.');
  assert.equal(a.type, 'create_expense');
  assert.equal(a.amount, 45);
  assert.equal(a.category, 'Alimentação');
  assert.equal(a.description, 'Almoço');
});

test('presente para namorada ontem', () => {
  const a = one('Ontem comprei um presente de 150 reais para minha namorada.');
  assert.equal(a.amount, 150);
  assert.equal(a.category, 'Namorada e relacionamento');
  assert.equal(a.date, '2026-11-22');
  assert.match(a.description, /^Presente/);
});

test('gasolina → transporte', () => {
  const a = one('Gastei 80 reais com gasolina.');
  assert.equal(a.amount, 80);
  assert.equal(a.category, 'Transporte e combustível');
  assert.equal(a.description, 'Gasolina');
});

test('duas despesas em uma frase', () => {
  const a = p('Gastei 20 reais em um lanche e 35 reais de gasolina.');
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => [x.description, x.amount, x.category]), [
    ['Lanche', 20, 'Alimentação'],
    ['Gasolina', 35, 'Transporte e combustível'],
  ]);
});

test('valores com centavos, R$ e por extenso', () => {
  assert.equal(one('paguei R$ 12,50 no café').amount, 12.5);
  assert.equal(one('gastei cento e cinquenta reais no mercado').amount, 150);
  assert.equal(one('comprei um tênis de 1.299,90').amount === null ? 0 : 1, 1);
  assert.equal(one('gastei 8 reais e 50 centavos em um sorvete').amount, 8.5);
});

test('parcelado', () => {
  const a = one('Comprei um celular de 1200 reais em 6 vezes');
  assert.equal(a.amount, 1200);
  assert.equal(a.installments, 6);
  assert.equal(a.category, 'Eletrônicos');
  const b = one('comprei uma jaqueta em 3 parcelas de 100 reais');
  assert.equal(b.amount, 300);
  assert.equal(b.installments, 3);
});

test('corrigir valor do açaí de hoje', () => {
  const a = one('Corrija o valor do açaí de hoje para 12 reais.');
  assert.equal(a.type, 'update_expense');
  assert.equal(a.target.text.toLowerCase(), 'açaí');
  assert.equal(a.target.date, '2026-11-23');
  assert.equal(a.changes.amount, 12);
});

test('apagar despesa de alimentação de ontem', () => {
  const a = one('Apague a despesa de alimentação de ontem.');
  assert.equal(a.type, 'delete_expense');
  assert.equal(a.target.date, '2026-11-22');
  assert.equal(a.target.category, 'Alimentação');
});

test('assinatura sem nome pede o nome', () => {
  const a = one('Tenho uma assinatura que custa 110 reais por mês e é cobrada todo dia 23.');
  assert.equal(a.type, 'create_recurrence');
  assert.equal(a.amount, 110);
  assert.equal(a.frequency, 'monthly');
  assert.equal(a.day_of_month, 23);
  assert.deepEqual(a.missing, ['name']);
});

test('cadastrar Netflix', () => {
  const a = one('Cadastre minha assinatura da Netflix por 39 reais mensais, todo dia 15.', { recurrences: [] });
  assert.equal(a.type, 'create_recurrence');
  assert.equal(a.name, 'Netflix');
  assert.equal(a.amount, 39);
  assert.equal(a.day_of_month, 15);
  assert.equal(a.kind, 'subscription');
  assert.equal(a.category, 'Assinaturas');
});

test('academia como despesa fixa', () => {
  const a = one('Minha academia custa 150 reais por mês e vence todo dia 10.', { recurrences: [] });
  assert.equal(a.type, 'create_recurrence');
  assert.equal(a.name, 'Academia');
  assert.equal(a.amount, 150);
  assert.equal(a.day_of_month, 10);
  assert.equal(a.kind, 'fixed');
  assert.equal(a.category, 'Academia');
});

test('assinatura anual e semanal', () => {
  const a = one('Cadastre o plano anual do iCloud de 200 reais todo dia 5 de março', { recurrences: [] });
  assert.equal(a.frequency, 'yearly');
  assert.equal(a.month, 3);
  assert.equal(a.day_of_month, 5);
  const b = one('Beach tennis custa 80 reais por semana toda quinta', { recurrences: [] });
  assert.equal(b.frequency, 'weekly');
  assert.equal(b.start_date, '2026-11-26');
  assert.equal(b.name, 'Beach tennis');
});

test('assinatura aumentou', () => {
  const a = one('Minha assinatura do Claude aumentou para 130 reais.');
  assert.equal(a.type, 'update_recurrence');
  assert.equal(a.target.text, 'Claude');
  assert.equal(a.changes.amount, 130);
});

test('cancelei Spotify', () => {
  const a = one('Cancelei minha assinatura do Spotify.');
  assert.equal(a.type, 'cancel_recurrence');
  assert.equal(a.target.text, 'Spotify');
});

test('paguei a academia', () => {
  const a = one('Paguei a academia');
  assert.equal(a.type, 'pay_recurrence');
  assert.equal(a.target.text, 'Academia');
});

test('consultas de assinaturas', () => {
  const a = one('Quanto estou gastando por mês com assinaturas?');
  assert.equal(a.type, 'query_recurrences');
  assert.equal(a.kind, 'subscription');
  const b = one('Quais assinaturas vencem nos próximos 7 dias?');
  assert.equal(b.type, 'query_recurrences');
  assert.equal(b.within_days, 7);
  const c = one('Quanto gasto por mês com academia e atividades físicas?');
  assert.equal(c.type, 'query_recurrences');
  assert.equal(c.category, 'Academia');
});

test('previsão próximo mês', () => {
  const a = one('Quanto vou gastar no próximo mês contando minhas despesas fixas?');
  assert.equal(a.type, 'forecast');
  assert.deepEqual(a.period, { start: '2026-12-01', end: '2026-12-31' });
});

test('quanto gastei com namorada neste mês', () => {
  const a = one('Quanto gastei com minha namorada neste mês?');
  assert.equal(a.type, 'query_expenses');
  assert.equal(a.category, 'Namorada e relacionamento');
  assert.deepEqual(a.period, { start: '2026-11-01', end: '2026-11-30' });
});

test('quanto gastei hoje / na semana', () => {
  assert.deepEqual(one('Quanto gastei hoje?').period, { start: '2026-11-23', end: '2026-11-23' });
  assert.deepEqual(one('quanto gastei essa semana').period, { start: '2026-11-23', end: '2026-11-29' });
  assert.deepEqual(one('Quanto gastei com transporte em outubro?').period, { start: '2026-10-01', end: '2026-10-31' });
});

test('compromisso: mercado dia 25 de dezembro às 4 da tarde', () => {
  const a = one('Dia 25 de dezembro me lembre que tenho que passar no mercado às 4 da tarde.');
  assert.equal(a.type, 'create_event');
  assert.equal(a.title, 'Passar no mercado');
  assert.equal(a.date, '2026-12-25');
  assert.equal(a.time, '16:00');
  assert.equal(a.missing, null);
});

test('compromisso sem horário pede o horário', () => {
  const a = one('Me lembre de pagar o boleto dia 30');
  assert.equal(a.type, 'create_event');
  assert.equal(a.date, '2026-11-30');
  assert.deepEqual(a.missing, ['time']);
});

test('data sem ano usa a próxima ocorrência', () => {
  const a = one('Marque dentista dia 10 de março às 9h');
  assert.equal(a.date, '2027-03-10');
  assert.equal(a.time, '09:00');
});

test('almoço com namorada domingo ao meio-dia', () => {
  const a = one('Marque um almoço com minha namorada domingo ao meio-dia.');
  assert.equal(a.type, 'create_event');
  assert.equal(a.date, '2026-11-29');
  assert.equal(a.time, '12:00');
  assert.match(a.title, /^Almoço com/);
});

test('desmarcar compromisso do dia 25 de dezembro', () => {
  const a = one('Desmarque meu compromisso do dia 25 de dezembro.');
  assert.equal(a.type, 'cancel_event');
  assert.equal(a.target.date, '2026-12-25');
  assert.equal(a.target.text, null);
});

test('remarcar consulta de amanhã para sexta às 15h', () => {
  const a = one('Remarque minha consulta de amanhã para sexta-feira às 15 horas.');
  assert.equal(a.type, 'update_event');
  assert.equal(a.target.text, 'consulta');
  assert.equal(a.target.date, '2026-11-24');
  assert.equal(a.changes.date, '2026-11-27');
  assert.equal(a.changes.time, '15:00');
});

test('consultas de agenda', () => {
  const a = one('Quais compromissos tenho amanhã?');
  assert.equal(a.type, 'query_events');
  assert.deepEqual(a.period, { start: '2026-11-24', end: '2026-11-24' });
  const b = one('Tenho algum compromisso na sexta-feira?');
  assert.equal(b.type, 'query_events');
  assert.deepEqual(b.period, { start: '2026-11-27', end: '2026-11-27' });
  const c = one('Tenho algum compromisso marcado para o Natal?');
  assert.equal(c.type, 'query_events');
  assert.deepEqual(c.period, { start: '2026-12-25', end: '2026-12-25' });
});

test('horários variados', () => {
  assert.equal(one('reunião amanhã às 8 da noite').time, '20:00');
  assert.equal(one('reunião amanhã às 14:30').time, '14:30');
  assert.equal(one('reunião amanhã 9h15').time, '09:15');
  assert.equal(one('consulta amanhã às 3 e meia da tarde').time, '15:30');
  assert.equal(one('marque academia amanhã às sete da manhã').time, '07:00');
});

test('pesquisa por voz', () => {
  const a = one('Procure açaí');
  assert.equal(a.type, 'search');
  assert.equal(a.text, 'açaí');
});
