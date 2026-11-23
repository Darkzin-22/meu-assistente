// Gera os ícones PNG do app a partir de um SVG (usa o Chromium do Playwright).
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import path from 'node:path';
const out = path.resolve('web/public/icons');
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3A8DFF"/><stop offset=".55" stop-color="#6E5BFF"/><stop offset="1" stop-color="#B05CFF"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <g transform="translate(256 256) scale(${pad}) translate(-256 -256)" fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <rect x="196" y="96" width="120" height="196" rx="60" fill="#fff" stroke="none"/>
    <path d="M140 246a116 116 0 0 0 232 0"/><path d="M256 362v54"/><path d="M196 416h120"/>
  </g>
  <circle cx="392" cy="128" r="34" fill="#FFD60A"/>
</svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192.png', 192, 1], ['icon-512.png', 512, 1], ['apple-touch-icon.png', 180, 1], ['icon-maskable-512.png', 512, 0.78]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg(pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: false });
}
await browser.close();
console.log('ícones gerados em', out);
