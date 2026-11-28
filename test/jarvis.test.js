// Testa o canal do Jarvis exatamente como o atalho da Siri o usa (POST /api/jarvis com a chave no cabeçalho).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-jarvis-'));
process.env.ANTHROPIC_API_KEY = '';

const { openDb } = await import('../server/db.js');
const { buildApp } = await import('../server/app.js');
const { setNow } = await import('../server/time.js');
const { toSpeech } = await import('../server/jarvis.js');

let db, app, cookie, token;
const web = async (method, url, body) => {
  const r = await app.inject({ method, url, headers: { cookie, 'x-requested-with': 'fetch', ...(body ? { 'content-type': 'application/json' } : {}) }, payload: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const jarvis = async (texto, tk = token) => {
  const r = await app.inject({ method: 'POST', url: '/api/jarvis', headers: { authorization: `Bearer ${tk}`, 'content-type': 'application/json' }, payload: JSON.stringify({ texto }) });
  return { status: r.statusCode, ...r.json() };
};

before(async () => {
  setNow('2026-11-23T09:00:00-03:00');
  db = openDb(':memory:');
  app = await buildApp(db, { serveStatic: false });
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'eu@x.com', password: '12345678', name: 'Eduardo' }) });
  cookie = r.headers['set-cookie'].split(';')[0];
});
after(async () => { await app.close(); setNow(null); });

test('chave: sem chave ou chave errada → 401; chave criada pelo app funciona', async () => {
  assert.equal((await jarvis('oi', 'jv_errada')).status, 401);
  const r = await app.inject({ method: 'POST', url: '/api/jarvis', headers: { 'content-type': 'application/json' }, payload: '{"texto":"oi"}' });
  assert.equal(r.statusCode, 401);
  token = (await web('POST', '/api/jarvis/token')).token;
  assert.match(token, /^jv_/);
  assert.equal((await web('GET', '/api/jarvis/status')).active, true);
  // a chave fica guardada só como hash
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM api_tokens WHERE token_hash=?`).get(token).n, 0);
});

test('despesa por voz via Siri, resposta pronta para ser falada', async () => {
  const r = await jarvis('Jarvis, gastei 45 reais no almoço');
  assert.equal(r.status, 200);
  assert.equal(r.entendeu, true);
  assert.equal(r.aguardando, false);
  assert.match(r.resposta, /^Registrado: Almoço, R\$\s?45,00 em Alimentação, hoje\.$/);
});

test('rendimento e saldo', async () => {
  setNow('2026-11-23T09:05:00-03:00');
  let r = await jarvis('Meu saldo no Nubank é 2.300 reais');
  setNow('2026-11-23T09:10:00-03:00');
  assert.match(r.resposta, /Saldo atualizado: Nubank, R\$\s?2\.300,00/);
  r = await jarvis('Recebi 500 reais de um freela');
  assert.match(r.resposta, /Entrada registrada: Freela, R\$\s?500,00/);
  r = await jarvis('Gastei 80 reais com gasolina');
  r = await jarvis('Qual é meu saldo?');
  assert.match(r.resposta, /saldo estimado é R\$\s?2\.720,00/); // 2300 + 500 − 80
  r = await jarvis('Quanto sobrou este mês?');
  assert.match(r.resposta, /recebeu R\$\s?500,00 e gastou R\$\s?125,00\. Sobraram R\$\s?375,00/);
});

test('salário recorrente entra sozinho no dia e conta no saldo', async () => {
  let r = await jarvis('Meu salário de 4.500 reais cai todo dia 5');
  assert.match(r.resposta, /Cadastrado: Salário de R\$\s?4\.500,00.*Próximo recebimento: .*05 de dez/);
  // não conta como despesa fixa
  const tot = (await web('GET', '/api/recurrences')).totals;
  assert.equal(tot.all_monthly_cents, 0);
  assert.equal(tot.income_monthly_cents, 450000);
  setNow('2026-12-05T12:00:00-03:00');
  try {
    await web('GET', '/api/recurrences'); // gera as cobranças/recebimentos vencidos
    r = await jarvis('Quanto recebi este mês?');
    assert.match(r.resposta, /recebeu R\$\s?4\.500,00/);
    r = await jarvis('Qual é meu saldo?');
    assert.match(r.resposta, /R\$\s?7\.220,00/); // 2720 + 4500
  } finally {
    setNow('2026-11-23T09:00:00-03:00');
  }
});

test('conversa: compromisso sem horário → Jarvis pergunta → resposta curta completa', async () => {
  let r = await jarvis('Me lembre de buscar o terno sexta');
  assert.equal(r.aguardando, true);
  assert.equal(r.continuar, 'sim');
  assert.match(r.resposta, /Que horas é "Buscar o terno"/);
  r = await jarvis('às 3 da tarde');
  assert.equal(r.aguardando, false);
  assert.match(r.resposta, /Agendado: Buscar o terno, .*27 de nov.* às 15:00/);
});

test('conversa: apagar pede confirmação por voz ("sim"/"não")', async () => {
  let r = await jarvis('Apague a despesa do almoço de hoje');
  assert.equal(r.aguardando, true);
  assert.match(r.resposta, /Apagar Almoço.*Diga sim ou não\./);
  r = await jarvis('não');
  assert.match(r.resposta, /não alterei nada/);
  assert.equal((await web('GET', '/api/expenses?q=Almoço')).expenses.length, 1);
  r = await jarvis('Apague a despesa do almoço de hoje');
  r = await jarvis('Sim');
  assert.match(r.resposta, /Despesa apagada/);
  assert.equal((await web('GET', '/api/expenses?q=Almoço')).expenses.length, 0);
});

test('conversa: vários compromissos → "o segundo" → confirmação', async () => {
  await jarvis('Marque reunião com cliente dia 3 de dezembro às 9h');
  await jarvis('Marque dentista dia 3 de dezembro às 14h');
  let r = await jarvis('Desmarque meu compromisso do dia 3 de dezembro');
  assert.match(r.resposta, /Primeiro: Reunião com cliente.*Segundo: Dentista/);
  r = await jarvis('o segundo');
  assert.match(r.resposta, /Desmarcar Dentista.*Diga sim ou não/);
  r = await jarvis('pode');
  assert.match(r.resposta, /Compromisso desmarcado: Dentista/);
});

test('pergunta geral → entendeu=false (o atalho usa a IA da Apple)', async () => {
  for (const q of ['Qual a capital da Austrália?', 'Quanto é 2 mais 2?', 'Vai chover amanhã?']) {
    const r = await jarvis(q);
    assert.equal(r.entendeu, false, q);
    assert.equal(r.modo, 'pergunta_geral');
    assert.equal(r.resposta, '');
  }
});

test('consultas de agenda por voz', async () => {
  const r = await jarvis('Quais compromissos tenho dia 3 de dezembro?');
  assert.match(r.resposta, /Você tem 1 compromisso.*Reunião com cliente/);
  assert.ok(!r.resposta.includes('•'));
});

test('texto para fala fica limpo', () => {
  assert.equal(toSpeech('Você tem 2 compromissos:\n• Mercado — hoje às 16:00\n• Dentista — amanhã às 10:00'), 'Você tem 2 compromissos: Mercado, hoje às 16:00. Dentista, amanhã às 10:00.');
});

test('personalidade: bom dia traz o resumo do dia; conversa simpática', async () => {
  setNow('2026-12-03T08:00:00-03:00');
  try {
    let r = await jarvis('Bom dia, Jarvis');
    assert.equal(r.modo, 'assistente');
    assert.match(r.resposta, /^Bom dia, Eduardo\./);
    assert.match(r.resposta, /Hoje você tem um compromisso: Reunião com cliente às 09:00\./);
    assert.match(r.resposta, /Neste mês você gastou R\$/);
    assert.match(r.resposta, /saldo estimado/);
    assert.match(r.resposta, /Em que posso ajudar\?$/);
    r = await jarvis('Obrigado!');
    assert.match(r.resposta, /Disponha|Sempre às ordens|Por nada/);
    r = await jarvis('Quem é você?');
    assert.match(r.resposta, /Sou o Jarvis/);
    r = await jarvis('Tudo bem?');
    assert.equal(r.modo, 'assistente');
    // "bom dia" seguido de um comando executa o comando
    r = await jarvis('Bom dia, gastei 20 reais no café');
    assert.match(r.resposta, /Registrado: Café, R\$\s?20,00/);
  } finally {
    setNow('2026-11-23T09:00:00-03:00');
  }
});
