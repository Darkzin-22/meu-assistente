import { useEffect, useMemo, useState } from 'react';
import { Plus, ChevronLeft, ChevronRight, MapPin, Clock, Bell, CalendarPlus, Check, X, Trash2, Pencil, RotateCcw } from 'lucide-react';
import { api, todayISO, addDaysISO, fmtDate, relDay, parseISO, cap } from '../api.js';
import { useApp } from '../context.js';
import { Segmented, Sheet, Spinner, Empty, Group, Row, useAsync, useToast, useConfirm } from '../ui.jsx';
import { IconBadge, Icon } from '../icons.jsx';
import { EventForm } from '../forms.jsx';

const WD = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const monthLabel = (iso) => cap(new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parseISO(iso)));
const startOfWeek = (iso) => addDaysISO(iso, -((parseISO(iso).getUTCDay() + 6) % 7));
const monthStart = (iso) => `${iso.slice(0, 8)}01`;
const addMonths = (iso, n) => { const d = parseISO(monthStart(iso)); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

export default function Agenda() {
  const { version, tz } = useApp();
  const today = todayISO(tz);
  const [view, setView] = useState('mes');
  const [cursor, setCursor] = useState(today);
  const [selected, setSelected] = useState(today);
  const [openId, setOpenId] = useState(() => Number(new URLSearchParams(location.search).get('event')) || null);
  const [creating, setCreating] = useState(false);

  const range = useMemo(() => {
    if (view === 'mes') { const s = startOfWeek(monthStart(cursor)); return { start: s, end: addDaysISO(s, 41) }; }
    if (view === 'semana') { const s = startOfWeek(cursor); return { start: s, end: addDaysISO(s, 6) }; }
    return { start: cursor, end: cursor };
  }, [view, cursor]);
  const { data } = useAsync(() => api.get(`/api/events?start=${range.start}&end=${range.end}`), [version, range.start, range.end]);
  const byDate = useMemo(() => {
    const m = {};
    for (const e of data?.events || []) (m[e.date] ||= []).push(e);
    return m;
  }, [data]);

  const move = (n) => {
    if (view === 'mes') setCursor(addMonths(cursor, n));
    else if (view === 'semana') setCursor(addDaysISO(cursor, 7 * n));
    else { const d = addDaysISO(cursor, n); setCursor(d); setSelected(d); }
  };
  const title = view === 'mes' ? monthLabel(cursor) : view === 'semana' ? `${fmtDate(range.start)} – ${fmtDate(range.end)}` : relDay(cursor, tz) + (relDay(cursor, tz).length < 8 ? `, ${fmtDate(cursor)}` : '');

  return (
    <div className="page">
      <div className="title-row">
        <h1 className="large-title">Agenda</h1>
        <button className="round-btn" onClick={() => setCreating(true)} aria-label="Novo compromisso"><Plus size={22} /></button>
      </div>
      <Segmented value={view} onChange={(v) => { setView(v); if (v === 'dia') setCursor(selected); }} options={[{ value: 'mes', label: 'Mês' }, { value: 'semana', label: 'Semana' }, { value: 'dia', label: 'Dia' }]} />
      <div className="cal-nav">
        <button className="icon-btn" onClick={() => move(-1)} aria-label="Anterior"><ChevronLeft /></button>
        <button className="cal-title" onClick={() => { setCursor(today); setSelected(today); }}>{title}</button>
        <button className="icon-btn" onClick={() => move(1)} aria-label="Próximo"><ChevronRight /></button>
      </div>

      {view === 'mes' && (
        <>
          <div className="month-grid">
            {WD.map((w) => <div key={w} className="wd">{w}</div>)}
            {Array.from({ length: 42 }, (_, i) => {
              const d = addDaysISO(range.start, i);
              const evs = byDate[d] || [];
              const out = d.slice(5, 7) !== cursor.slice(5, 7);
              return (
                <button key={d} className={`day ${out ? 'out' : ''} ${d === today ? 'today' : ''} ${d === selected ? 'sel' : ''}`} onClick={() => setSelected(d)}>
                  <span className="day-num">{Number(d.slice(8))}</span>
                  <span className="day-icons">
                    {evs.slice(0, 3).map((e) => <span key={e.id} className="day-ev" style={{ background: e.category_color }}><Icon name={e.icon || e.category_icon} size={9} color="#fff" /></span>)}
                    {evs.length > 3 && <span className="day-more">+{evs.length - 3}</span>}
                  </span>
                </button>
              );
            })}
          </div>
          <DayList date={selected} events={byDate[selected] || []} onOpen={setOpenId} onCreate={() => setCreating(true)} />
        </>
      )}

      {view === 'semana' && (
        <div className="week-list">
          {Array.from({ length: 7 }, (_, i) => {
            const d = addDaysISO(range.start, i);
            const evs = byDate[d] || [];
            return (
              <div key={d} className={`week-day ${d === today ? 'today' : ''}`}>
                <button className="week-day-head" onClick={() => { setSelected(d); setCursor(d); setView('dia'); }}>
                  <span className="wd">{WD[i]}</span><span className="num">{Number(d.slice(8))}</span>
                </button>
                <div className="week-day-events">
                  {evs.length ? evs.map((e) => <EventChip key={e.id} e={e} onClick={() => setOpenId(e.id)} />) : <span className="muted small">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'dia' && <DayTimeline events={byDate[cursor] || []} onOpen={setOpenId} />}

      <Sheet open={creating} onClose={() => setCreating(false)} title="Novo compromisso">
        {creating && <EventForm defaultDate={selected} onDone={() => setCreating(false)} />}
      </Sheet>
      {openId && <EventDetail id={openId} onClose={() => { setOpenId(null); const u = new URL(location.href); u.searchParams.delete('event'); history.replaceState(null, '', u); }} />}
    </div>
  );
}

function EventChip({ e, onClick }) {
  return (
    <button className={`ev-chip ${e.status}`} style={{ '--c': e.category_color }} onClick={onClick}>
      <IconBadge name={e.icon || e.category_icon} color={e.category_color} image={e.image} size={26} />
      <span className="ev-chip-main"><span className="ev-chip-title">{e.title}</span><span className="ev-chip-time">{e.time || 'Dia inteiro'}</span></span>
    </button>
  );
}

function DayList({ date, events, onOpen, onCreate }) {
  const { tz } = useApp();
  return (
    <Group title={`${relDay(date, tz)}${relDay(date, tz).length < 8 ? ` · ${fmtDate(date, { day: '2-digit', month: 'long' })}` : ''}`}>
      {events.length ? events.map((e) => (
        <Row key={e.id} icon={<IconBadge name={e.icon || e.category_icon} color={e.category_color} image={e.image} size={36} />}
          title={<span className={e.status === 'done' ? 'strike' : ''}>{e.title}</span>}
          subtitle={`${e.time || 'Dia inteiro'} · ${e.category_name || ''}${e.status === 'done' ? ' · concluído' : ''}`} onClick={() => onOpen(e.id)} />
      )) : <Empty title="Nenhum compromisso" text="Toque em + ou segure o microfone para agendar."><button className="btn small ghost" onClick={onCreate}><Plus size={14} /> Adicionar</button></Empty>}
    </Group>
  );
}

function DayTimeline({ events, onOpen }) {
  const allDay = events.filter((e) => !e.time);
  const timed = events.filter((e) => e.time);
  const hours = Array.from({ length: 18 }, (_, i) => i + 6);
  const nowRef = useNowLine();
  return (
    <div className="timeline">
      {allDay.length > 0 && <div className="timeline-allday">{allDay.map((e) => <EventChip key={e.id} e={e} onClick={() => onOpen(e.id)} />)}</div>}
      {timed.filter((e) => Number(e.time.slice(0, 2)) < 6).map((e) => <EventChip key={e.id} e={e} onClick={() => onOpen(e.id)} />)}
      {hours.map((h) => {
        const evs = timed.filter((e) => Number(e.time.slice(0, 2)) === h);
        return (
          <div key={h} className="hour" ref={h === nowRef.hour ? nowRef.ref : undefined}>
            <span className="hour-label">{String(h).padStart(2, '0')}:00</span>
            <div className="hour-events">{evs.map((e) => <EventChip key={e.id} e={e} onClick={() => onOpen(e.id)} />)}</div>
          </div>
        );
      })}
      {!events.length && <Empty title="Dia livre" />}
    </div>
  );
}

function useNowLine() {
  const [hour] = useState(new Date().getHours());
  return { hour, ref: null };
}

function EventDetail({ id, onClose }) {
  const { refresh, tz, version } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const { data, reload } = useAsync(() => api.get(`/api/events/${id}`, { cache: false }), [id, version]);
  useEffect(() => { setEditing(false); }, [id]);
  const e = data?.event;

  async function act(fn, msg) {
    try { await fn(); toast(msg, { tone: 'ok' }); refresh(); reload(); } catch (err) { toast(err.message, { tone: 'error' }); }
  }
  const fire = (iso) => new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const statusLabel = { pending: 'programado', sent: 'enviado', failed: 'falhou', missed: 'perdido', cancelled: 'cancelado', sending: 'enviando' };

  return (
    <Sheet open onClose={onClose} title={editing ? 'Editar compromisso' : 'Compromisso'} tall>
      {!e ? <div className="center pad"><Spinner /></div> : editing ? (
        <EventForm event={e} onDone={() => { setEditing(false); reload(); }} />
      ) : (
        <div className="event-detail">
          <div className="event-hero">
            <IconBadge name={e.icon || e.category_icon} color={e.category_color} image={e.image} size={64} />
            <div>
              <h2 className={e.status === 'done' ? 'strike' : ''}>{e.title}</h2>
              <div className="muted">{e.category_name}{e.status === 'cancelled' ? ' · cancelado' : e.status === 'done' ? ' · concluído' : ''}</div>
            </div>
          </div>
          <Group>
            <Row icon={<Clock size={18} />} title={relDay(e.date, tz) + (relDay(e.date, tz).length < 8 ? `, ${fmtDate(e.date, { day: '2-digit', month: 'long', year: 'numeric' })}` : '')} subtitle={e.time ? `às ${e.time}` : 'Dia inteiro'} />
            {e.location && <Row icon={<MapPin size={18} />} title={e.location} />}
            {e.notes && <Row title={<span className="pre">{e.notes}</span>} />}
          </Group>
          <Group title="Lembretes">
            {data.reminders.length ? data.reminders.map((r) => (
              <Row key={r.id} icon={<Bell size={16} />} title={fire(r.fire_at)} subtitle={r.error || undefined} value={statusLabel[r.status] || r.status} valueTone={r.status === 'sent' ? 'pos' : r.status === 'failed' ? 'neg' : ''} />
            )) : <Row title={<span className="muted">Nenhum lembrete futuro</span>} />}
          </Group>
          <div className="action-grid">
            {e.status === 'scheduled' && <button className="action" onClick={() => setEditing(true)}><Pencil size={20} />Editar / remarcar</button>}
            {e.status === 'scheduled' && <button className="action" onClick={() => act(() => api.post(`/api/events/${e.id}/complete`), 'Marcado como concluído.')}><Check size={20} />Concluir</button>}
            {e.status !== 'scheduled' && <button className="action" onClick={() => act(() => api.post(`/api/events/${e.id}/reopen`), 'Compromisso reativado.')}><RotateCcw size={20} />Reativar</button>}
            {e.status === 'scheduled' && <button className="action warn" onClick={async () => { if (await confirm(`Desmarcar "${e.title}"? Os lembretes serão cancelados.`, { confirmLabel: 'Desmarcar' })) act(() => api.post(`/api/events/${e.id}/cancel`), 'Compromisso desmarcado.'); }}><X size={20} />Desmarcar</button>}
            <button className="action" onClick={() => api.download(`/api/events/${e.id}/ics`).catch((err) => toast(err.message, { tone: 'error' }))}><CalendarPlus size={20} />Calendário do iPhone</button>
            <button className="action danger" onClick={async () => { if (await confirm(`Excluir "${e.title}"?`, { confirmLabel: 'Excluir' })) { await act(() => api.del(`/api/events/${e.id}`), 'Compromisso excluído.'); onClose(); } }}><Trash2 size={20} />Excluir</button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
