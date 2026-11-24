// Teste de ponta a ponta no navegador (Chromium emulando um iPhone).
// Uso: npm run build && npm run e2e
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-e2e-'));

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ANTHROPIC_API_KEY: '', GROQ_API_KEY: '', OPENAI_API_KEY: '', SCHEDULER_INTERVAL_MS: '2000' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => d.toString().includes('rodando') && res());
  server.on('exit', (c) => rej(new Error(`servidor saiu (${c})`)));
});

const results = [];
async function step(name, fn) {
  try { await fn(); results.push(['✅', name]); console.log('✅', name); } catch (err) { results.push(['❌', name, err.message]); console.log('❌', name, '\n   ', err.message.slice(0, 400)); }
}

// channel 'chromium' = modo headless novo (suporta notificações); cai para o padrão se indisponível.
const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch());
const iphone = devices['iPhone 14 Pro'] || devices['iPhone 13'];
const context = await browser.newContext({ ...iphone, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo', colorScheme: 'dark' });
await context.grantPermissions(['notifications'], { origin: BASE });
// Simula o motor de reconhecimento de voz do aparelho (não há microfone no ambiente de teste).
await context.addInitScript(() => {
  window.__nextSpeech = '';
  class FakeSR {
    constructor() { this.lang = ''; }
    start() { this._t = setTimeout(() => this.onresult?.({ results: [Object.assign([{ transcript: window.__nextSpeech }], { isFinal: true })] }), 300); }
    stop() { clearTimeout(this._t); setTimeout(() => { this.onresult?.({ results: [Object.assign([{ transcript: window.__nextSpeech }], { isFinal: true })] }); this.onend?.(); }, 50); }
    abort() { this.onend?.(); }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('   [erro na página]', e.message));

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
  await page.waitForTimeout(400);
}
async function holdMic(speech, ms = 900) {
  await page.evaluate((s) => { window.__nextSpeech = s; }, speech);
  const box = await page.locator('button.mic').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForSelector('.sheet .result', { timeout: 10000 });
  await page.waitForTimeout(300);
  return sheetText();
}

await step('Cadastro da conta', async () => {
  await page.goto(BASE);
  await page.fill('input[placeholder="Seu nome"]', 'Eduardo');
  await page.fill('input[type=email]', 'eu@exemplo.com');
  await page.fill('input[type=password]', 'senha-segura-123');
  await page.screenshot({ path: path.join(SHOTS, '00-cadastro.png') });
  await page.click('button:has-text("Criar conta")');
  await page.waitForSelector('.hero-card');
});

await step('Despesa por texto: "Hoje comprei um açaí de 8 reais."', async () => {
  const t = await textCommand('Hoje comprei um açaí de 8 reais.');
  assert.match(t, /Registrado: Açaí — R\$\s?8,00 em Alimentação \(hoje\)/);
  await closeSheet();
});

await step('Despesa por VOZ (pressionar e segurar o microfone)', async () => {
  const t = await holdMic('Gastei 20 reais em um lanche e 35 reais de gasolina');
  assert.match(t, /você disse/i);
  assert.match(t, /Lanche — R\$\s?20,00 em Alimentação/);
  assert.match(t, /Gasolina — R\$\s?35,00 em Transporte e combustível/);
  await page.screenshot({ path: path.join(SHOTS, '02-voz-resultado.png') });
  await closeSheet();
});

await step('Compromisso por VOZ com 4 lembretes', async () => {
  const t = await holdMic('Dia 25 de dezembro me lembre que tenho que passar no mercado às 4 da tarde');
  assert.match(t, /Agendado: Passar no mercado — .*25 de dez.* às 16:00\. 4 lembretes programados/);
  assert.equal(await page.locator('.reminder-list li').count(), 4);
  await page.screenshot({ path: path.join(SHOTS, '03-compromisso-voz.png') });
  await closeSheet();
});

await step('Compromisso sem horário → pergunta o horário', async () => {
  const t = await textCommand('Me lembre de buscar o terno dia 28');
  assert.match(t, /Que horas é "Buscar o terno"/);
  await page.fill('.result-input input[type=time]', '11:30');
  await page.click('.result-input button:has-text("Salvar")');
  await page.waitForSelector('.result-done');
  assert.match(await sheetText(), /Agendado: Buscar o terno .* às 11:30/);
  await closeSheet();
});

await step('Assinatura por texto + consulta de total', async () => {
  let t = await textCommand('Cadastre minha assinatura da Netflix por 39 reais mensais, todo dia 15.');
  assert.match(t, /Cadastrado: Netflix — R\$\s?39,00 \(mensal\)/);
  await closeSheet();
  t = await textCommand('Minha academia custa 150 reais por mês e vence todo dia 10.');
  assert.match(t, /Cadastrado: Academia/);
  await closeSheet();
  t = await textCommand('Quanto estou gastando por mês com assinaturas?');
  assert.match(t, /R\$\s?39,00 por mês com assinaturas/);
  await closeSheet();
});

await step('Corrigir valor por comando', async () => {
  const t = await textCommand('Corrija o valor do açaí de hoje para 12 reais.');
  assert.match(t, /de R\$\s?8,00 para R\$\s?12,00/);
  await closeSheet();
});

await step('Apagar exige confirmação', async () => {
  const t = await textCommand('Apague a despesa do lanche de hoje');
  assert.match(t, /Apagar Lanche/);
  await page.click('.result-confirm button:has-text("Confirmar")');
  await page.waitForSelector('.result-done');
  assert.match(await sheetText(), /Despesa apagada/);
  await closeSheet();
});

await step('Painel mostra totais corretos (12 + 35 = R$ 47,00)', async () => {
  await page.click('.tabbar button:has-text("Início")');
  await page.waitForSelector('.hero-value');
  assert.match(await page.locator('.hero-value').innerText(), /R\$\s?47,00/);
  await page.screenshot({ path: path.join(SHOTS, '01-inicio.png') });
});

await step('Persistência após recarregar o app', async () => {
  await page.reload();
  await page.waitForSelector('.hero-value');
  assert.match(await page.locator('.hero-value').innerText(), /R\$\s?47,00/);
});

await step('Tela Finanças (gráficos e histórico)', async () => {
  await page.click('.tabbar button:has-text("Finanças")');
  await page.waitForSelector('.donut-wrap');
  assert.match(await page.locator('.page').innerText(), /Açaí/);
  await page.screenshot({ path: path.join(SHOTS, '04-financas.png'), fullPage: true });
});

await step('Tela Agenda (calendário com ícones) e detalhes do compromisso', async () => {
  await page.click('.tabbar button:has-text("Agenda")');
  await page.waitForSelector('.month-grid');
  await page.click('button[aria-label="Próximo"]');
  await page.click('.day:not(.out) >> text="25"');
  await page.waitForSelector('text=Passar no mercado');
  await page.screenshot({ path: path.join(SHOTS, '05-agenda.png') });
  await page.click('.row:has-text("Passar no mercado")');
  await page.waitForSelector('.event-detail');
  assert.equal(await page.locator('.event-detail .group-body').nth(1).locator('.row').count(), 4);
  await page.screenshot({ path: path.join(SHOTS, '06-detalhe-compromisso.png') });
  await closeSheet();
});

await step('Tela Assinaturas', async () => {
  await page.click('.tabbar button:has-text("Assinaturas")');
  await page.waitForSelector('text=Netflix');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '07-assinaturas.png') });
});

await step('Saldo e rendimento por comando aparecem no Início', async () => {
  await page.click('.tabbar button:has-text("Início")');
  await page.waitForSelector('.hero-value');
  let t = await textCommand('Meu saldo no Nubank é 2.000 reais');
  assert.match(t, /Saldo atualizado: Nubank — R\$\s?2\.000,00/);
  await closeSheet();
  t = await textCommand('Recebi 300 reais de um freela');
  assert.match(t, /Entrada registrada: Freela — R\$\s?300,00/);
  await closeSheet();
  await page.waitForTimeout(500);
  const box = await page.locator('.group:has-text("Saldo e rendimento")').innerText();
  assert.match(box, /2\.300,00/);
  assert.match(box, /300,00/);
  await page.screenshot({ path: path.join(SHOTS, '10-saldo.png') });
});

await step('Ajustes › Jarvis: gerar chave mostra endereço e chave', async () => {
  await page.click('.tabbar button:has-text("Ajustes")');
  await page.waitForSelector('text=Jarvis — assistente pela Siri');
  await page.click('.group:has-text("Jarvis") button:has-text("Gerar chave")');
  await page.waitForSelector('.sheet:has-text("Chave do Jarvis")');
  const txt = await page.locator('.sheet').innerText();
  assert.match(txt, /\/api\/jarvis/);
  assert.match(txt, /jv_[\w-]{20,}/);
  await page.screenshot({ path: path.join(SHOTS, '11-jarvis-chave.png') });
  const token = /jv_[\w-]+/.exec(txt)[0];
  await closeSheet();
  // Simula o atalho da Siri chamando o servidor com a chave
  const r = await fetch(`${BASE}/api/jarvis`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ texto: 'Jarvis, qual é meu saldo?' }) });
  const j = await r.json();
  assert.equal(j.modo, 'assistente');
  assert.match(j.resposta, /saldo estimado é R\$\s?2\.300,00/);
});

await step('Notificações: inscrição push e exibição pelo service worker', async () => {
  await page.click('.tabbar button:has-text("Ajustes")');
  await page.waitForSelector('text=Notificações');
  await page.screenshot({ path: path.join(SHOTS, '08-ajustes.png') });
  // O Chromium de teste não alcança o serviço de push do Google; simulamos a chegada de um push
  // diretamente no service worker (o mesmo código que roda no iPhone ao receber a notificação).
  const cdp = await context.newCDPSession(page);
  const regP = new Promise((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => { const r = e.registrations.find((x) => x.scopeURL.startsWith(BASE) && !x.isDeleted); if (r) resolve(r); });
  });
  await cdp.send('ServiceWorker.enable');
  const reg = await regP;
  await cdp.send('ServiceWorker.deliverPushMessage', { origin: `${BASE}/`, registrationId: reg.registrationId, data: JSON.stringify({ title: 'Passar no mercado', body: 'Em 10 minutos — qui 25/12 às 16h00. Está quase na hora!', tag: 'ev-1-m10', url: '/?tab=agenda' }) });
  await page.waitForTimeout(800);
  const notes = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body })));
  assert.ok(notes.some((n) => n.title === 'Passar no mercado' && /10 minutos/.test(n.body)), JSON.stringify(notes));
});

await step('Lançamento offline é enfileirado e sincronizado ao reconectar', async () => {
  await page.click('.tabbar button:has-text("Início")');
  await page.waitForSelector('.hero-value');
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  const t = await textCommand('Gastei 15 reais de estacionamento');
  assert.match(t, /Sem internet: o comando foi salvo/);
  await closeSheet();
  assert.match(await page.locator('.topbar').innerText(), /1 na fila/);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForFunction(() => !document.querySelector('.topbar')?.innerText.includes('na fila'), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  assert.match(await page.locator('.hero-value').innerText(), /R\$\s?62,00/);
});

await step('Tema claro', async () => {
  await page.click('.tabbar button:has-text("Ajustes")');
  await page.click('.segmented button:has-text("Claro")');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.click('.tabbar button:has-text("Início")');
  await page.waitForSelector('.hero-value');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, '09-inicio-claro.png') });
});

await browser.close();
server.kill();
const failed = results.filter((r) => r[0] === '❌');
console.log(`\n${results.length - failed.length}/${results.length} etapas OK. Capturas em docs/screenshots/`);
process.exit(failed.length ? 1 : 0);
