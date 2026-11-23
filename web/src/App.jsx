import { useCallback, useEffect, useMemo, useState } from 'react';
import { House, Wallet, CalendarDays, Repeat, Settings, Search, WifiOff, CloudUpload } from 'lucide-react';
import { api, onApiEvent, flushQueue, getQueue, brl, relDay } from './api.js';
import { AppCtx } from './context.js';
import { ToastProvider, ConfirmProvider, Sheet, Spinner, useToast } from './ui.jsx';
import VoiceDock from './VoiceDock.jsx';
import Home from './pages/Home.jsx';
import Finance from './pages/Finance.jsx';
import Agenda from './pages/Agenda.jsx';
import Subscriptions from './pages/Subscriptions.jsx';
import SettingsPage from './pages/Settings.jsx';
import { IconBadge } from './icons.jsx';

const TABS = [
  { id: 'inicio', label: 'Início', icon: House, C: Home },
  { id: 'financas', label: 'Finanças', icon: Wallet, C: Finance },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, C: Agenda },
  { id: 'assinaturas', label: 'Assinaturas', icon: Repeat, C: Subscriptions },
  { id: 'config', label: 'Ajustes', icon: Settings, C: SettingsPage },
];

function applyTheme(theme) {
  const t = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme || 'dark';
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'light' ? '#F2F2F7' : '#000000');
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <Root />
      </ConfirmProvider>
    </ToastProvider>
  );
}

function Root() {
  const [status, setStatus] = useState(null);
  const load = useCallback(async () => {
    try {
      const s = await api.get('/api/auth/status');
      setStatus(s);
    } catch (err) {
      setStatus({ error: err.message, offline: err.status === 0 });
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => onApiEvent((e) => e.type === 'unauthenticated' && load()), [load]);
  useEffect(() => { applyTheme(localStorage.getItem('assist.theme') || 'dark'); }, []);

  if (!status) return <div className="splash"><Spinner size={32} /></div>;
  if (status.error && !status.offline) return <div className="splash"><p>{status.error}</p><button className="btn primary" onClick={load}>Tentar novamente</button></div>;
  if (status.user || status.offline) return <Main onLogout={load} offlineBoot={status.offline} />;
  return <Auth setup={status.needsSetup} allowSignup={status.allowSignup} local={status.local} onDone={load} />;
}

function Auth({ setup, allowSignup, local, onDone }) {
  const [mode, setMode] = useState(setup ? 'register' : 'login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      await api.post(mode === 'register' ? '/api/auth/register' : '/api/auth/login', { ...f, timezone: tz });
      onDone();
    } catch (er) { setErr(er.message); } finally { setBusy(false); }
  }
  return (
    <div className="auth">
      <div className="auth-logo"><IconBadge name="sparkles" color="linear-gradient(135deg,#5E5CE6,#BF5AF2)" size={72} /></div>
      <h1>Meu Assistente</h1>
      <p className="muted">{local ? 'Suas finanças e sua agenda, por voz. Tudo fica guardado só neste aparelho.' : mode === 'register' ? 'Crie sua conta para começar. Seus dados ficam protegidos por senha.' : 'Entre para acessar suas finanças e sua agenda.'}</p>
      <form onSubmit={submit} className="auth-form">
        {mode === 'register' && <input placeholder={local ? 'Como você quer ser chamado?' : 'Seu nome'} required={local} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="given-name" />}
        {!local && <input type="email" placeholder="E-mail" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="username" />}
        {!local && <input type="password" placeholder="Senha (mín. 8 caracteres)" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />}
        {err && <div className="form-error">{err}</div>}
        <button className="btn primary big" disabled={busy}>{busy ? <Spinner size={18} /> : local ? 'Começar' : mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
      </form>
      {!setup && allowSignup && <button className="link-btn" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>{mode === 'login' ? 'Criar uma conta' : 'Já tenho conta'}</button>}
    </div>
  );
}

function Main({ onLogout, offlineBoot }) {
  const toast = useToast();
  const params = new URLSearchParams(location.search);
  const [tab, setTabState] = useState(TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'inicio');
  const [me, setMe] = useState(null);
  const [categories, setCategories] = useState({ expense: [], event: [] });
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(navigator.onLine && !offlineBoot);
  const [queue, setQueue] = useState(getQueue().length);
  const [search, setSearch] = useState(false);

  const setTab = (t) => {
    setTabState(t);
    const u = new URL(location.href);
    u.searchParams.set('tab', t);
    for (const k of ['event', 'new']) u.searchParams.delete(k);
    history.replaceState(null, '', u);
    window.scrollTo({ top: 0 });
  };

  const loadMe = useCallback(async () => {
    try {
      const [m, c] = await Promise.all([api.get('/api/me'), api.get('/api/categories')]);
      setMe(m);
      setCategories(c);
      const theme = m.user.settings.theme || 'dark';
      localStorage.setItem('assist.theme', theme);
      applyTheme(theme);
    } catch (err) {
      if (err.status !== 401) toast(err.message, { tone: 'error' });
    }
  }, [toast]);
  useEffect(() => { loadMe(); }, [loadMe]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // Sincronização da fila offline
  useEffect(() => {
    const goOnline = async () => {
      setOnline(true);
      const res = await flushQueue();
      if (res.length) { toast(`${res.length} lançamento(s) feitos offline foram sincronizados.`, { tone: 'ok' }); refresh(); }
    };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    const off = onApiEvent((e) => { if (e.type === 'queue') setQueue(e.size); });
    if (navigator.onLine) goOnline();
    const vis = () => { if (document.visibilityState === 'visible') { refresh(); if (navigator.onLine) goOnline(); } };
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); off(); document.removeEventListener('visibilitychange', vis); };
  }, [refresh, toast]);

  const ctx = useMemo(() => ({
    user: me?.user, caps: me?.capabilities, categories, version, refresh, reloadMe: loadMe, setTab,
    tz: me?.user?.timezone || 'America/Sao_Paulo', onLogout,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [me, categories, version, refresh, loadMe, onLogout]);

  const Current = TABS.find((t) => t.id === tab).C;
  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <header className="topbar">
          <div className="topbar-status">
            {!online && <span className="pill warn"><WifiOff size={13} /> Offline</span>}
            {queue > 0 && <span className="pill"><CloudUpload size={13} /> {queue} na fila</span>}
          </div>
          <button className="icon-btn" aria-label="Pesquisar" onClick={() => setSearch(true)}><Search size={22} /></button>
        </header>
        <main className="content" key={tab}>
          {me ? <Current /> : <div className="splash inline"><Spinner /></div>}
        </main>
        <VoiceDock />
        <nav className="tabbar">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}>
              <t.icon size={24} strokeWidth={tab === t.id ? 2.4 : 1.9} />
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <SearchSheet open={search} onClose={() => setSearch(false)} />
      </div>
    </AppCtx.Provider>
  );
}

function SearchSheet({ open, onClose }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const ctx = useMemo(() => ({}), []);
  void ctx;
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(async () => {
      try { setRes(await api.get(`/api/search?q=${encodeURIComponent(q.trim())}`, { cache: false })); } catch { setRes(null); }
    }, 220);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <Sheet open={open} onClose={onClose} title="Pesquisar" tall>
      <input className="search-input" autoFocus placeholder="Despesas, compromissos, assinaturas…" value={q} onChange={(e) => setQ(e.target.value)} />
      {res && (
        <div className="search-results">
          {!res.expenses.length && !res.events.length && !res.recurrences.length && <p className="muted center">Nada encontrado.</p>}
          {res.expenses.length > 0 && <h4>Despesas</h4>}
          {res.expenses.map((e) => (
            <div key={`e${e.id}`} className="row"><div className="row-icon"><IconBadge name={e.category_icon} color={e.category_color} size={30} /></div><div className="row-main"><div className="row-title">{e.description}</div><div className="row-sub">{relDay(e.date)} · {e.category_name}</div></div><div className="row-value">{brl(e.amount_cents)}</div></div>
          ))}
          {res.events.length > 0 && <h4>Compromissos</h4>}
          {res.events.map((e) => (
            <div key={`v${e.id}`} className="row"><div className="row-icon"><IconBadge name={e.icon || e.category_icon} color={e.category_color} size={30} image={e.image} /></div><div className="row-main"><div className="row-title">{e.title}{e.status === 'cancelled' ? ' (cancelado)' : ''}</div><div className="row-sub">{relDay(e.date)}{e.time ? ` · ${e.time}` : ''}</div></div></div>
          ))}
          {res.recurrences.length > 0 && <h4>Assinaturas</h4>}
          {res.recurrences.map((r) => (
            <div key={`r${r.id}`} className="row"><div className="row-icon"><IconBadge name={r.category_icon} color={r.category_color} size={30} /></div><div className="row-main"><div className="row-title">{r.name}</div><div className="row-sub">{r.status === 'active' ? 'Ativa' : r.status === 'paused' ? 'Pausada' : 'Cancelada'}</div></div><div className="row-value">{brl(r.amount_cents)}</div></div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
