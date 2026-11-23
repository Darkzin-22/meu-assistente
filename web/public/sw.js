/* Service worker: funciona offline (app shell) e recebe notificações push mesmo com o app fechado. */
const VERSION = 'v2';
// Caminhos relativos ao local onde o app está publicado (raiz do servidor ou /meu-assistente/ no GitHub Pages).
const BASE = new URL('./', self.registration.scope).pathname;
const at = (p) => BASE + p;
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll([at(''), at('manifest.webmanifest'), at('icons/icon-192.png')])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ![SHELL, ASSETS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith(at('api/'))) return; // dados sempre da rede
  if (req.mode === 'navigate') {
    // Rede primeiro; sem internet, abre o app a partir do cache.
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(at(''), copy));
        return res;
      }).catch(() => caches.match(at(''))),
    );
    return;
  }
  if (url.pathname.startsWith(at('assets/')) || url.pathname.startsWith(at('icons/'))) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(ASSETS).then((c) => c.put(req, copy));
        return res;
      })),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Lembrete', body: event.data && event.data.text() }; }
  const title = data.title || 'Meu Assistente';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: at('icons/icon-192.png'),
      badge: at('icons/icon-192.png'),
      tag: data.tag,
      renotify: Boolean(data.tag),
      timestamp: Date.now(),
      data: { url: data.url || at('') },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || at(''), self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.navigate?.(target);
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});

// Se o navegador renovar a inscrição de push, reenvia ao servidor.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const r = await fetch(at('api/push/key'));
      const { publicKey } = await r.json();
      const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await fetch(at('api/push/subscribe'), { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    })(),
  );
});
