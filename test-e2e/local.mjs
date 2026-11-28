// Teste da versão local (sem servidor), servida como no GitHub Pages em /meu-assistente/.
// Uso: VITE_LOCAL=1 npm run build && node test-e2e/local.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'web', 'dist');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const PREFIX = '/meu-assistente/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

// Servidor estático simples (igual ao GitHub Pages: só arquivos, sem API).
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith(PREFIX)) { res.writeHead(404).end(); return; }
  let f = path.join(DIST, decodeURIComponent(u.pathname.slice(PREFIX.length)) || 'index.html');
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404).end('404'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => srv.listen(4010, r));
const BASE = `http://localhost:4010${PREFIX}`;

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['✅', name]); console.log('✅', name); } catch (err) { results.push(['❌', name]); console.log('❌', name, '\n   ', err.message.slice(0, 400)); }
}

const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch());
const context = await browser.newContext({ ...devices['iPhone 14 Pro'], locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', colorScheme: 'dark' });
await context.addInitScript(() => {
  window.__nextSpeech = '';
  class FakeSR {
    start() { this._t = setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: window.__nextSpeech }], { isFinal: true })] }), 300); }
    stop() { clearTimeout(this._t); setTimeout(() => { this.onresult?.({ results: [Object.assign([{ transcript: window.__nextSpeech }], { isFinal: true })] }); this.onend?.(); }, 50); }
    abort() { this.onend?.(); }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const requests = [];
page.on('request', (r) => requests.push(r.url()));

const sheetText = () => page.locator('.sheet .assistant').innerText();
async function textCommand(t) {
  await page.fill('.dock-input input', t);
  await page.press('.dock-input input', 'Enter');
  await page.waitForSelector('.sheet .result', { timeout: 10000 });
  await page.waitForTimeout(300);
  return sheetText();
}
async function closeSheet() {
  await page.click('.sheet-head button[aria-label="Fechar"]');
  await page.waitForTimeout(450);
}
async function holdMic(speech) {
  await page.evaluate((s) => { window.__nextSpeech = s; }, speech);
  const box = await page.locator('button.mic').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForSelector('.sheet .result', { timeout: 10000 });
  await page.waitForTimeout(300);
  return sheetText();
}

await step('Primeira abertura pede só o nome (sem e-mail/senha)', async () => {
  await page.goto(BASE);
  await page.waitForSelector('text=Começar');
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.fill('input[placeholder="Como você quer ser chamado?"]', 'Eduardo');
  await page.screenshot({ path: path.join(SHOTS, 'local-00-inicio.png') });
  await page.click('button:has-text("Começar")');
  await page.waitForSelector('.hero-card');
  assert.match(await page.locator('.large-title').innerText(), /Eduardo/i);
});

await step('Despesa por texto', async () => {
  const t = await textCommand('Hoje comprei um açaí de 8 reais.');
  assert.match(t, /Registrado: Açaí — R\$\s?8,00 em Alimentação/);
  await closeSheet();
});

await step('Despesas por voz (duas numa frase)', async () => {
  const t = await holdMic('Gastei 20 reais em um lanche e 35 reais de gasolina');
  assert.match(t, /Lanche — R\$\s?20,00/);
  assert.match(t, /Gasolina — R\$\s?35,00 em Transporte/);
  await closeSheet();
});

await step('Compromisso por voz + botão "Adicionar ao Calendário"', async () => {
  const t = await holdMic('Dia 25 de dezembro me lembre que tenho que passar no mercado às 4 da tarde');
  assert.match(t, /Agendado: Passar no mercado/);
  assert.equal(await page.locator('button:has-text("Adicionar ao Calendário")').count(), 1);
  await page.screenshot({ path: path.join(SHOTS, 'local-01-compromisso.png') });
  await closeSheet();
});

await step('Assinatura, correção e exclusão com confirmação', async () => {
  let t = await textCommand('Cadastre minha assinatura da Netflix por 39 reais mensais, todo dia 15.');
  assert.match(t, /Cadastrado: Netflix/);
  await closeSheet();
  t = await textCommand('Corrija o valor do açaí de hoje para 12 reais.');
  assert.match(t, /para R\$\s?12,00/);
  await closeSheet();
  t = await textCommand('Apague a despesa do lanche de hoje');
  await page.click('.result-confirm button:has-text("Confirmar")');
  await page.waitForSelector('.result-done');
  await closeSheet();
});

await step('Painel: R$ 47,00 (12 + 35)', async () => {
  await page.click('.tabbar button:has-text("Início")');
  await page.waitForTimeout(400);
  assert.match(await page.locator('.hero-value').innerText(), /R\$\s?47,00/);
  await page.screenshot({ path: path.join(SHOTS, 'local-02-painel.png') });
});

await step('Dados continuam após fechar e reabrir o app', async () => {
  await page.close();
  const p2 = await context.newPage();
  await p2.goto(BASE);
  await p2.waitForSelector('.hero-value');
  assert.match(await p2.locator('.hero-value').innerText(), /R\$\s?47,00/);
  await p2.close();
});

const page2 = await context.newPage();
await step('Funciona sem internet (app e dados no aparelho)', async () => {
  await page2.goto(BASE);
  await page2.waitForSelector('.hero-value');
  await page2.waitForTimeout(1500); // service worker instala e guarda os arquivos
  await page2.reload();
  await page2.waitForSelector('.hero-value');
  await context.setOffline(true);
  await page2.reload();
  await page2.waitForSelector('.hero-value', { timeout: 10000 });
  await page2.fill('.dock-input input', 'gastei 15 reais de estacionamento');
  await page2.press('.dock-input input', 'Enter');
  await page2.waitForSelector('.result-done');
  assert.match(await page2.locator('.sheet .assistant').innerText(), /Estacionamento — R\$\s?15,00/);
  await context.setOffline(false);
});

await step('Nenhuma chamada a servidor de dados (só arquivos estáticos)', async () => {
  const api = requests.filter((u) => u.includes('/api/'));
  assert.deepEqual(api, []);
});

await step('Sem erros de JavaScript', async () => {
  assert.deepEqual(pageErrors, []);
});

// Arquivo .ics do compromisso (num navegador de computador ele é baixado; no iPhone abre o Calendário)
const desk = await browser.newContext({ acceptDownloads: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
await step('.ics do compromisso tem os 4 alarmes', async () => {
  const p = await desk.newPage();
  await p.goto(BASE);
  await p.fill('input[placeholder="Como você quer ser chamado?"]', 'Teste');
  await p.click('button:has-text("Começar")');
  await p.waitForSelector('.hero-card');
  await p.fill('.dock-input input', 'Dia 25 de dezembro me lembre que tenho que passar no mercado às 4 da tarde');
  await p.press('.dock-input input', 'Enter');
  await p.waitForSelector('button:has-text("Adicionar ao Calendário")');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('button:has-text("Adicionar ao Calendário")')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  assert.match(ics, /SUMMARY:Passar no mercado/);
  assert.match(ics, /DTSTART:20261225T190000Z/);
  assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 4, ics);
  assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20261220T130000Z/);
  assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20261225T185000Z/);
});

await browser.close();
srv.close();
const failed = results.filter((r) => r[0] === '❌');
console.log(`\n${results.length - failed.length}/${results.length} etapas OK.`);
process.exit(failed.length ? 1 : 0);
