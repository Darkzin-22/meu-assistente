// Testa o caminho da IA (Claude) contra um servidor local que imita a API de Mensagens.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let mode = 'ok';
let lastBody = null;
const srv = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    lastBody = JSON.parse(b || '{}');
    if (mode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } })); }
    const actions = [
      { type: 'create_expense', description: 'Pastel', amount: 12.5, category: 'Alimentação', date: '2026-11-23', installments: null, title: null, time: null, duration_min: null, location: null, name: null, frequency: null, interval: null, day_of_month: null, month: null, start_date: null, kind: null, direction: null, target: null, changes: null, period: null, within_days: null, text: null, question: null, missing: null },
      null, // preenchida abaixo: válida para o esquema, mas com data fora do formato → descartada
    ];
    actions[1] = { ...actions[0], description: 'Inválida', date: 'amanhã' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: lastBody.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify({ actions }) }] }));
  });
});

let db, user, runCommand;
before(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${srv.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'sk-teste';
  process.env.AI_EFFORT = 'low';
  process.env.AI_MODEL = 'claude-opus-5-5';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-llm-'));
  const { openDb } = await import('../server/db.js');
  const auth = await import('../server/auth.js');
  ({ runCommand } = await import('../server/nlp/execute.js'));
  (await import('../server/time.js')).setNow('2026-11-23T09:00:00-03:00');
  db = openDb(':memory:');
  user = await auth.register(db, { email: 'a@b.com', password: '12345678' });
});
after(() => srv.close());

test('comando interpretado pelo Claude e validado antes de executar', async () => {
  const r = await runCommand(db, user, 'comi um pastel de doze e cinquenta');
  assert.equal(r.engine, 'claude', r.fallback_reason);
  assert.equal(r.results.length, 1); // a ação inválida foi descartada
  assert.equal(r.results[0].data.expenses[0].amount_cents, 1250);
  assert.equal(lastBody.model, 'claude-opus-5-5');
  assert.equal(lastBody.output_config.effort, 'low');
  assert.equal(lastBody.output_config.format.type, 'json_schema');
  assert.equal(lastBody.fallbacks, 'default');
  assert.match(lastBody.messages[0].content, /Hoje é 2026-11-23/);
});

test('falha da IA → usa o interpretador local automaticamente', async () => {
  mode = 'fail';
  const r = await runCommand(db, user, 'Gastei 80 reais com gasolina.');
  assert.equal(r.engine, 'local');
  assert.ok(r.fallback_reason);
  assert.equal(r.results[0].data.expenses[0].category_name, 'Transporte e combustível');
});
