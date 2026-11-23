// Camada de acesso à API com: cookies de sessão, proteção CSRF, cache para leitura offline
// e fila de lançamentos offline (reenviados ao reconectar, sem duplicar graças ao client_id).

const QUEUE_KEY = 'assist.queue.v1';
const CACHE_PREFIX = 'assist.cache.v1:';

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

const listeners = new Set();
export function onApiEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const emit = (e) => listeners.forEach((fn) => fn(e));

/** true = versão que roda inteira no aparelho (sem servidor). */
export const IS_LOCAL = import.meta.env.VITE_LOCAL === '1';
let localBackend = null;

async function request(method, url, body, { isForm = false } = {}) {
  if (IS_LOCAL) {
    localBackend ||= await import('./local/backend.js');
    try {
      return await localBackend.handle(method, url, body);
    } catch (err) {
      if (err.status === 401) emit({ type: 'unauthenticated' });
      throw new ApiError(err.message, err.status || 500, err.data);
    }
  }
  const headers = { 'x-requested-with': 'fetch' };
  if (body && !isForm) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(url, { method, headers, credentials: 'include', body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  } catch (err) {
    throw new ApiError('Sem conexão com o servidor.', 0, { offline: true });
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (res.status === 401 && !url.startsWith('/api/auth/')) emit({ type: 'unauthenticated' });
  if (!res.ok) throw new ApiError((data && data.error) || `Erro ${res.status}`, res.status, data);
  return data;
}

function cacheSet(url, data) {
  try { localStorage.setItem(CACHE_PREFIX + url, JSON.stringify({ t: Date.now(), data })); } catch { /* armazenamento cheio */ }
}
function cacheGet(url) {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + url) || 'null'); } catch { return null; }
}

export const api = {
  /** GET com cache: sem internet, devolve a última cópia salva (marcada com _offline). */
  async get(url, { cache = true } = {}) {
    try {
      const data = await request('GET', url);
      if (cache) cacheSet(url, data);
      return data;
    } catch (err) {
      if (err.status === 0 && cache) {
        const c = cacheGet(url);
        if (c) return { ...c.data, _offline: true, _cachedAt: c.t };
      }
      throw err;
    }
  },
  post: (url, body) => request('POST', url, body),
  patch: (url, body) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, form) => request('POST', url, form, { isForm: true }),

  /**
   * Baixa um arquivo gerado pela API (CSV, backup, .ics).
   * Compromissos (.ics) são abertos para o iPhone oferecer "Adicionar ao Calendário" com os alarmes.
   */
  async download(url) {
    let filename, mime, content;
    if (IS_LOCAL) {
      const r = await request('GET', url);
      ({ filename, mime, content } = r.__download);
    } else {
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new ApiError('Não foi possível gerar o arquivo.', res.status);
      mime = res.headers.get('content-type') || 'application/octet-stream';
      filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'arquivo';
      content = await res.blob();
    }
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const file = new File([blob], filename, { type: mime });
    const isCalendar = /calendar/.test(mime);
    const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
    // No iPhone, arquivos comuns vão pela folha de compartilhamento ("Salvar em Arquivos").
    if (!isCalendar && isApple && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    // No iPhone, abrir o .ics (sem "download") mostra a tela nativa de adicionar ao Calendário.
    if (!(isCalendar && isApple)) a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  },

  /** Mutação que pode ser enfileirada sem internet. body deve conter client_id. */
  async queued(url, body, label) {
    try {
      return await request('POST', url, body);
    } catch (err) {
      if (err.status !== 0) throw err;
      enqueue({ url, body, label, at: Date.now() });
      return { queued: true };
    }
  },
};

// ---------------------------------------------------------------- fila offline
export function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function setQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  emit({ type: 'queue', size: q.length });
}
function enqueue(item) {
  setQueue([...getQueue(), item]);
}

let flushing = false;
/** Reenvia os itens pendentes. O servidor ignora repetições (client_id), então é seguro tentar de novo. */
export async function flushQueue() {
  if (flushing) return [];
  flushing = true;
  const results = [];
  try {
    let q = getQueue();
    while (q.length) {
      const item = q[0];
      try {
        const r = await request('POST', item.url, item.body);
        results.push({ item, result: r });
      } catch (err) {
        if (err.status === 0) break; // ainda offline
        results.push({ item, error: err.message }); // erro definitivo: descarta para não travar a fila
      }
      q = getQueue().slice(1);
      setQueue(q);
    }
  } finally {
    flushing = false;
  }
  if (results.length) emit({ type: 'flushed', results });
  return results;
}

// ---------------------------------------------------------------- formatação
const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const brl = (cents) => brlFmt.format((cents || 0) / 100);
export const toCents = (v) => {
  if (v === '' || v == null) return null;
  let s = String(v).trim().replace(/r\$\s*/i, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
export const centsToInput = (c) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export function todayISO(tz = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function parseISO(iso) { return new Date(`${iso}T12:00:00Z`); }
export function fmtDate(iso, opts = { day: '2-digit', month: 'short' }) {
  return new Intl.DateTimeFormat('pt-BR', { ...opts, timeZone: 'UTC' }).format(parseISO(iso)).replace('.', '');
}
export function relDay(iso, tz) {
  const t = todayISO(tz);
  if (iso === t) return 'Hoje';
  if (iso === addDaysISO(t, 1)) return 'Amanhã';
  if (iso === addDaysISO(t, -1)) return 'Ontem';
  return cap(fmtDate(iso, { weekday: 'short', day: '2-digit', month: 'short' }));
}
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export function urlB64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
