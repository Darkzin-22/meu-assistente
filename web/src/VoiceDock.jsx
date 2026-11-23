import { useEffect, useRef, useState } from 'react';
import { Mic, SendHorizontal, Check, TriangleAlert, Undo2, Pencil, Sparkles, CircleCheck, Info } from 'lucide-react';
import { api, uid, brl, cap } from './api.js';
import { Sheet, Spinner, useToast } from './ui.jsx';
import { useApp } from './context.js';

const SR = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/aac', 'audio/ogg']) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

/**
 * Gravação por voz: "pressione e segure" (ou toque para iniciar / toque para parar).
 * Usa transcrição no servidor quando configurada; senão, o reconhecimento de voz do próprio aparelho.
 */
function useVoice({ serverTranscription, onText, onError }) {
  const [state, setState] = useState('idle'); // idle | starting | recording | transcribing
  const [live, setLive] = useState('');
  const ref = useRef({});

  const useServer = serverTranscription && typeof MediaRecorder !== 'undefined' && navigator.mediaDevices?.getUserMedia;
  const supported = Boolean(useServer || SR);

  async function start() {
    if (state !== 'idle') return;
    const r = (ref.current = { startedAt: Date.now(), stopRequested: false, chunks: [], text: '' });
    setLive('');
    setState('starting');
    navigator.vibrate?.(10);
    try {
      if (useServer) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        r.stream = stream;
        const mime = pickMime();
        const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        r.rec = rec;
        rec.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
        rec.onstop = () => finishServer(r, rec.mimeType || mime || 'audio/webm');
        rec.start(250);
      } else if (SR) {
        const rec = new SR();
        r.sr = rec;
        rec.lang = 'pt-BR';
        rec.interimResults = true;
        rec.continuous = true;
        rec.maxAlternatives = 1;
        rec.onresult = (e) => {
          let finalText = '', interim = '';
          for (let i = 0; i < e.results.length; i++) {
            const t = e.results[i][0].transcript;
            if (e.results[i].isFinal) finalText += t; else interim += t;
          }
          r.text = (finalText + ' ' + interim).trim();
          setLive(r.text);
        };
        rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') r.error = e.error; };
        rec.onend = () => finishSR(r);
        rec.start();
      } else {
        throw new Error('unsupported');
      }
      setState('recording');
      if (r.stopRequested) stop();
    } catch (err) {
      cleanup(r);
      setState('idle');
      onError(err.name === 'NotAllowedError' ? 'Permita o acesso ao microfone nas configurações do iPhone (Ajustes › Safari › Microfone).' : 'Não foi possível usar o microfone. Use o campo de texto — o ditado do teclado do iPhone também funciona.');
    }
  }

  function stop() {
    const r = ref.current;
    if (!r) return;
    if (state === 'starting' || !(r.rec || r.sr)) { r.stopRequested = true; return; }
    navigator.vibrate?.(8);
    if (r.rec && r.rec.state !== 'inactive') r.rec.stop();
    if (r.sr) r.sr.stop();
  }

  function cleanup(r) {
    r.stream?.getTracks().forEach((t) => t.stop());
  }

  async function finishServer(r, mime) {
    cleanup(r);
    const dur = Date.now() - r.startedAt;
    const blob = new Blob(r.chunks, { type: mime });
    if (dur < 600 || blob.size < 1500) { setState('idle'); onError('Gravação muito curta. Segure o botão enquanto fala.'); return; }
    setState('transcribing');
    try {
      const form = new FormData();
      form.append('audio', blob, `audio.${mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm'}`);
      const { text } = await api.upload('/api/transcribe', form);
      setState('idle');
      if (!text) onError('Não consegui ouvir nada. Tente novamente mais perto do microfone.');
      else onText(text);
    } catch (err) {
      setState('idle');
      onError(err.status === 0 ? 'Sem internet para transcrever o áudio. Digite o comando — ele será enviado quando a conexão voltar.' : err.message);
    }
  }

  function finishSR(r) {
    setState('idle');
    if (r.error === 'not-allowed' || r.error === 'service-not-allowed') return onError('Permita o reconhecimento de voz e o microfone para o app nos Ajustes do iPhone.');
    const text = (r.text || '').trim();
    if (!text) return onError('Não consegui ouvir nada. Segure o botão enquanto fala.');
    onText(text);
  }

  return { state, live, start, stop, supported, engine: useServer ? 'server' : SR ? 'device' : 'none' };
}

// ---------------------------------------------------------------------------

export default function VoiceDock() {
  const { caps, user, refresh, tz } = useApp();
  const toast = useToast();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState(null); // { transcript, loading, response, source }
  const [editing, setEditing] = useState(false);
  const pressRef = useRef(0);
  const tapMode = useRef(false);
  const inputRef = useRef(null);

  const voice = useVoice({
    serverTranscription: caps?.transcription,
    onText: (t) => submit(t, 'voice'),
    onError: (m) => toast(m, { tone: 'warn', duration: 5000 }),
  });

  async function submit(t, source = 'text') {
    t = (t || '').trim();
    if (!t) return;
    const autoSend = source !== 'voice' || user?.settings?.voice_auto_send !== false;
    setEditing(false);
    if (!autoSend) { setSheet({ transcript: t, source, loading: false, response: null }); setEditing(true); return; }
    setSheet({ transcript: t, source, loading: true, response: null });
    setText('');
    const client_id = uid();
    try {
      const r = await api.queued('/api/command', { text: t, client_id, source }, t);
      if (r.queued) {
        setSheet({ transcript: t, source, loading: false, response: { results: [{ type: 'answer', message: 'Sem internet: o comando foi salvo e será processado automaticamente quando a conexão voltar.' }] } });
        return;
      }
      setSheet({ transcript: t, source, loading: false, response: r });
      if (r.results.some((x) => x.type === 'done')) refresh();
    } catch (err) {
      setSheet({ transcript: t, source, loading: false, response: { results: [{ type: 'error', message: err.message }] } });
    }
  }

  // Pressionar e segurar
  const onDown = (e) => {
    e.preventDefault();
    if (voice.state === 'recording' && tapMode.current) { tapMode.current = false; voice.stop(); return; }
    if (voice.state !== 'idle') return;
    if (!voice.supported) { toast('Reconhecimento de voz indisponível neste navegador. Use o campo de texto (o ditado do teclado funciona).', { tone: 'warn', duration: 5000 }); inputRef.current?.focus(); return; }
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pressRef.current = Date.now();
    voice.start();
  };
  const onUp = (e) => {
    e.preventDefault();
    if (tapMode.current) return;
    if (Date.now() - pressRef.current < 350) { tapMode.current = true; return; } // toque rápido → modo "toque para parar"
    voice.stop();
  };
  useEffect(() => { if (voice.state === 'idle') tapMode.current = false; }, [voice.state]);

  const recording = voice.state === 'recording' || voice.state === 'starting';

  return (
    <>
      <div className="dock">
        {recording && (
          <div className="live-bubble">
            <span className="rec-dot" /> {voice.live || (tapMode.current ? 'Ouvindo… toque para parar' : 'Ouvindo… solte para enviar')}
          </div>
        )}
        {voice.state === 'transcribing' && <div className="live-bubble"><Spinner size={14} /> Transcrevendo…</div>}
        <form className="dock-input" onSubmit={(e) => { e.preventDefault(); submit(text); }}>
          <Sparkles size={18} className="dock-spark" />
          <input ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Diga ou digite: gastei 20 no almoço…" enterKeyHint="send" aria-label="Comando de texto" />
          {text && <button className="dock-send" aria-label="Enviar"><SendHorizontal size={18} /></button>}
        </form>
        <button
          className={`mic ${recording ? 'recording' : ''} ${voice.state === 'transcribing' ? 'busy' : ''}`}
          onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={onUp}
          onContextMenu={(e) => e.preventDefault()}
          aria-label="Segure para falar"
        >
          {voice.state === 'transcribing' ? <Spinner size={26} /> : <Mic size={30} strokeWidth={2.2} />}
        </button>
      </div>

      <Sheet open={!!sheet} onClose={() => { setSheet(null); setEditing(false); }} title="Assistente">
        {sheet && (
          <div className="assistant">
            <div className="transcript">
              <div className="transcript-label">{sheet.source === 'voice' ? 'Você disse' : 'Comando'}</div>
              {editing ? (
                <form onSubmit={(e) => { e.preventDefault(); submit(sheet.transcript, 'text'); }}>
                  <textarea autoFocus rows={3} value={sheet.transcript} onChange={(e) => setSheet({ ...sheet, transcript: e.target.value })} />
                  <div className="row-actions"><button className="btn primary" type="submit"><SendHorizontal size={16} /> Enviar</button></div>
                </form>
              ) : (
                <div className="transcript-text" onClick={() => setEditing(true)}>
                  “{sheet.transcript}” <button className="link-btn" aria-label="Corrigir transcrição"><Pencil size={14} /> Corrigir</button>
                </div>
              )}
            </div>
            {sheet.loading && <div className="thinking"><Spinner /> Entendendo…</div>}
            {sheet.response?.results?.map((r, i) => (
              <ResultCard key={i} result={r} tz={tz} onChange={(nr) => {
                const results = [...sheet.response.results];
                results[i] = nr;
                setSheet({ ...sheet, response: { ...sheet.response, results } });
              }} onRefresh={refresh} />
            ))}
            {sheet.response?.engine && (
              <div className="engine-note">
                {sheet.response.engine === 'claude' ? 'Interpretado pela IA (Claude)' : sheet.response.fallback_reason ? 'IA indisponível — interpretado localmente' : 'Interpretado localmente'}
              </div>
            )}
          </div>
        )}
      </Sheet>
    </>
  );
}

// ---------------------------------------------------------------------------

function ResultCard({ result, onChange, onRefresh, tz }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [undone, setUndone] = useState(false);

  async function exec(action, confirmed = false) {
    setBusy(true);
    try {
      const { result: nr } = await api.post('/api/actions/execute', { action, confirmed });
      onChange(nr);
      if (nr.type === 'done') onRefresh();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    try {
      const d = result.data || {};
      if (result.kind === 'expense_created') for (const e of d.expenses) await api.del(`/api/expenses/${e.id}`);
      else if (result.kind === 'event_created') await api.del(`/api/events/${d.event.id}`);
      else if (result.kind === 'recurrence_created') await api.del(`/api/recurrences/${d.recurrence.id}`);
      else if (result.kind === 'expense_updated') await api.patch(`/api/expenses/${d.before.id}`, { amount: d.before.amount_cents / 100, description: d.before.description, date: d.before.date, category_id: d.before.category_id });
      else if (result.kind === 'event_updated') await api.patch(`/api/events/${d.before.id}`, { date: d.before.date, time: d.before.time, title: d.before.title });
      else if (result.undo) await api.post('/api/actions/execute', { action: result.undo, confirmed: true });
      else if (result.kind === 'charge_paid') await api.del(`/api/expenses/${d.expense.id}`);
      setUndone(true);
      onRefresh();
      toast('Desfeito.');
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const canUndo = ['expense_created', 'event_created', 'recurrence_created', 'expense_updated', 'event_updated', 'recurrence_cancelled', 'charge_paid'].includes(result.kind);

  if (result.type === 'done') {
    return (
      <div className={`result result-done ${undone ? 'undone' : ''}`}>
        <div className="result-icon ok"><CircleCheck size={20} /></div>
        <div className="result-main">
          <div className="result-msg">{undone ? <s>{result.message}</s> : result.message}</div>
          {result.warnings?.map((w, i) => <div key={i} className="result-warn"><TriangleAlert size={14} /> {w}</div>)}
          {result.kind === 'event_created' && result.data.reminders?.length > 0 && !undone && (
            <ul className="reminder-list">
              {result.data.reminders.map((r) => <li key={r.kind}><Check size={12} /> {fmtFire(r.fire_at, tz)}</li>)}
            </ul>
          )}
          {canUndo && !undone && <button className="btn small ghost" disabled={busy} onClick={undo}><Undo2 size={14} /> Desfazer</button>}
        </div>
      </div>
    );
  }
  if (result.type === 'confirm') {
    return (
      <div className="result result-confirm">
        <div className="result-icon warn"><TriangleAlert size={20} /></div>
        <div className="result-main">
          <div className="result-msg">{result.message}</div>
          <div className="row-actions">
            <button className="btn ghost" disabled={busy} onClick={() => onChange({ type: 'answer', message: 'Cancelado. Nada foi alterado.' })}>Cancelar</button>
            <button className="btn danger" disabled={busy} onClick={() => exec(result.action, true)}>{busy ? <Spinner size={16} /> : 'Confirmar'}</button>
          </div>
        </div>
      </div>
    );
  }
  if (result.type === 'choose') {
    return (
      <div className="result">
        <div className="result-icon info"><Info size={20} /></div>
        <div className="result-main">
          <div className="result-msg">{result.message}</div>
          <div className="choices">
            {result.options.map((o, i) => <button key={i} className="choice" disabled={busy} onClick={() => exec(o.action)}>{o.label}</button>)}
          </div>
        </div>
      </div>
    );
  }
  if (result.type === 'needs_input') return <NeedsInput result={result} busy={busy} onSubmit={(a) => exec(a)} onCancel={() => onChange({ type: 'answer', message: 'Cancelado.' })} />;
  const tone = result.type === 'error' ? 'err' : result.type === 'clarify' ? 'warn' : 'info';
  return (
    <div className={`result result-${result.type}`}>
      <div className={`result-icon ${tone}`}>{result.type === 'error' ? <TriangleAlert size={20} /> : <Info size={20} />}</div>
      <div className="result-main"><div className="result-msg pre">{result.message}</div></div>
    </div>
  );
}

function fmtFire(iso, tz) {
  return cap(new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)));
}

const FIELD_LABEL = { amount: 'Valor (R$)', description: 'Descrição', title: 'Compromisso', date: 'Data', time: 'Horário', name: 'Nome', day_of_month: 'Dia da cobrança', changes: 'Alteração' };

function NeedsInput({ result, busy, onSubmit, onCancel }) {
  const d = result.draft;
  let fields = [...result.missing];
  if (fields.includes('changes')) {
    fields = d.type === 'update_event' ? ['date', 'time'] : d.type === 'update_recurrence' ? ['amount', 'day_of_month'] : ['amount'];
  }
  const isChanges = result.missing.includes('changes') || d.type === 'update_event';
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f, (isChanges ? d.changes?.[f] : d[f]) ?? ''])));
  const set = (k, v) => setVals((x) => ({ ...x, [k]: v }));
  function send(e) {
    e.preventDefault();
    const conv = {};
    for (const [k, v] of Object.entries(vals)) {
      if (v === '' || v == null) continue;
      if (k === 'amount') conv[k] = Number(String(v).replace(/\./g, '').replace(',', '.'));
      else if (k === 'day_of_month') conv[k] = Number(v);
      else conv[k] = v;
    }
    const a = isChanges ? { ...d, changes: { ...(d.changes || {}), ...conv } } : { ...d, ...conv, missing: null };
    onSubmit(a);
  }
  return (
    <form className="result result-input" onSubmit={send}>
      <div className="result-icon info"><Pencil size={18} /></div>
      <div className="result-main">
        <div className="result-msg">{result.message}</div>
        {d.type === 'create_expense' && d.description && <div className="muted small">{d.description}{d.category ? ` · ${d.category}` : ''}</div>}
        <div className="inline-fields">
          {fields.map((f) => (
            <label key={f} className="inline-field">
              <span>{FIELD_LABEL[f] || f}</span>
              {f === 'date' ? <input type="date" required={!isChanges} value={vals[f]} onChange={(e) => set(f, e.target.value)} />
                : f === 'time' ? <input type="time" required={!isChanges} value={vals[f]} onChange={(e) => set(f, e.target.value)} autoFocus />
                  : f === 'amount' ? <input inputMode="decimal" placeholder="0,00" required={!isChanges} value={vals[f]} onChange={(e) => set(f, e.target.value)} autoFocus />
                    : f === 'day_of_month' ? <input type="number" min="1" max="31" required={!isChanges} value={vals[f]} onChange={(e) => set(f, e.target.value)} />
                      : <input value={vals[f]} required onChange={(e) => set(f, e.target.value)} autoFocus />}
            </label>
          ))}
        </div>
        <div className="row-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancelar</button>
          <button className="btn primary" disabled={busy}>{busy ? <Spinner size={16} /> : 'Salvar'}</button>
        </div>
      </div>
    </form>
  );
}

export { brl };
