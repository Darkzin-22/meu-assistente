import { useMemo, useState } from 'react';
import { Plus, Download, Filter, Trash2, RotateCcw, X } from 'lucide-react';
import { api, brl, relDay, todayISO, addDaysISO, fmtDate, toCents, IS_LOCAL } from '../api.js';
import { useApp } from '../context.js';
import { Group, Row, Empty, Spinner, Segmented, Sheet, Field, useAsync, useToast } from '../ui.jsx';
import { IconBadge } from '../icons.jsx';
import { BarChart, Donut, Progress } from '../charts.jsx';
import { ExpenseSheet } from '../forms.jsx';

function rangeFor(period, tz, custom) {
  const t = todayISO(tz);
  const d = new Date(`${t}T12:00:00Z`);
  if (period === 'semana') {
    const wd = (d.getUTCDay() + 6) % 7;
    return { start: addDaysISO(t, -wd), end: addDaysISO(t, 6 - wd) };
  }
  if (period === 'mes') return { start: `${t.slice(0, 8)}01`, end: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10) };
  if (period === 'ano') return { start: `${t.slice(0, 4)}-01-01`, end: `${t.slice(0, 4)}-12-31` };
  if (period === 'custom') return custom;
  return { start: '', end: '' };
}

export default function Finance() {
  const { version, tz, categories } = useApp();
  const [period, setPeriod] = useState('mes');
  const [custom, setCustom] = useState({ start: addDaysISO(todayISO(tz), -30), end: todayISO(tz) });
  const [filters, setFilters] = useState({ q: '', category_id: '', min: '', max: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [edit, setEdit] = useState(() => (new URLSearchParams(location.search).get('new') ? {} : null));
  const [trash, setTrash] = useState(false);
  const range = rangeFor(period, tz, custom);
  const qs = new URLSearchParams(Object.entries({ ...range, ...filters, min: filters.min ? String(toCents(filters.min) / 100) : '', max: filters.max ? String(toCents(filters.max) / 100) : '' }).filter(([, v]) => v !== '' && v != null)).toString();

  const stats = useAsync(() => api.get('/api/finance/stats'), [version]);
  const list = useAsync(() => api.get(`/api/expenses?${qs}&limit=1000`), [version, qs]);

  const donut = useMemo(() => {
    const m = new Map();
    for (const e of list.data?.expenses || []) {
      const k = e.category_name || 'Sem categoria';
      const v = m.get(k) || { label: k, value: 0, color: e.category_color || '#8E8E93' };
      v.value += e.amount_cents;
      m.set(k, v);
    }
    return [...m.values()].sort((a, b) => b.value - a.value);
  }, [list.data]);

  const grouped = useMemo(() => {
    const g = [];
    for (const e of list.data?.expenses || []) {
      const last = g[g.length - 1];
      if (last?.date === e.date) { last.items.push(e); last.total += e.amount_cents; } else g.push({ date: e.date, items: [e], total: e.amount_cents });
    }
    return g;
  }, [list.data]);

  const s = stats.data;
  const activeFilters = Object.values(filters).filter(Boolean).length;
  const top = useMemo(() => [...(list.data?.expenses || [])].sort((a, b) => b.amount_cents - a.amount_cents).slice(0, 5), [list.data]);

  return (
    <div className="page">
      <div className="title-row">
        <h1 className="large-title">Finanças</h1>
        <button className="round-btn" onClick={() => setEdit({})} aria-label="Nova despesa"><Plus size={22} /></button>
      </div>

      {s && (
        <div className="stat-grid">
          <div className="stat"><span>Hoje</span><strong>{brl(s.totals.today_cents)}</strong></div>
          <div className="stat"><span>Semana</span><strong>{brl(s.totals.week_cents)}</strong></div>
          <div className="stat"><span>Mês</span><strong>{brl(s.totals.month_cents)}</strong></div>
          <div className="stat"><span>Ano</span><strong>{brl(s.totals.year_cents)}</strong></div>
        </div>
      )}

      {s && (
        <Group title="Previsão do mês">
          <Row title="Gasto até agora" value={brl(s.totals.month_cents)} />
          <Row title="Assinaturas e fixos a vencer" subtitle={`${s.forecast.items.filter((i) => i.status !== 'paid').length} cobrança(s)`} value={brl(s.forecast.recurring_pending_cents)} />
          {s.forecast.logged_future_cents > 0 && <Row title="Parcelas e lançamentos futuros" value={brl(s.forecast.logged_future_cents)} />}
          <Row title={<strong>Total previsto no fechamento</strong>} value={<strong>{brl(s.forecast.month_close_cents)}</strong>} />
        </Group>
      )}

      {s && (
        <Group title="Comparação entre meses">
          <div className="card-pad"><BarChart data={s.months} /></div>
        </Group>
      )}

      <div className="sticky-filters">
        <Segmented value={period} onChange={setPeriod} options={[{ value: 'semana', label: 'Semana' }, { value: 'mes', label: 'Mês' }, { value: 'ano', label: 'Ano' }, { value: 'tudo', label: 'Tudo' }, { value: 'custom', label: 'Período' }]} />
        <button className={`icon-btn filter-btn ${activeFilters ? 'on' : ''}`} onClick={() => setShowFilters(true)} aria-label="Filtros"><Filter size={20} />{activeFilters > 0 && <span className="badge">{activeFilters}</span>}</button>
      </div>
      {period === 'custom' && (
        <div className="grid2 pad-x">
          <Field label="De"><input type="date" value={custom.start} onChange={(e) => setCustom({ ...custom, start: e.target.value })} /></Field>
          <Field label="Até"><input type="date" value={custom.end} onChange={(e) => setCustom({ ...custom, end: e.target.value })} /></Field>
        </div>
      )}

      <Group title={`Por categoria${range.start ? ` · ${fmtDate(range.start)} – ${fmtDate(range.end)}` : ''}`}>
        <div className="card-pad">{donut.length ? <Donut data={donut} /> : <Empty title="Sem gastos no período" />}</div>
      </Group>

      {s?.budgets?.length > 0 && period === 'mes' && (
        <Group title="Orçamento mensal">
          {s.budgets.map((b) => (
            <div key={b.category_id} className="budget-row">
              <div className="budget-top"><span>{b.name}</span><span className={b.pct >= 1 ? 'neg' : ''}>{brl(b.spent_cents)} / {brl(b.budget_cents)}</span></div>
              <Progress value={b.pct} />
            </div>
          ))}
        </Group>
      )}

      {top.length > 0 && (
        <Group title="Maiores despesas">
          {top.map((e) => <Row key={e.id} icon={<IconBadge name={e.category_icon} color={e.category_color} size={32} />} title={e.description} subtitle={relDay(e.date, tz)} value={brl(e.amount_cents)} onClick={() => setEdit(e)} />)}
        </Group>
      )}

      <Group title={`Histórico${list.data ? ` · ${brl(list.data.total_cents)}` : ''}`} action={
        <div className="group-actions">
          {!IS_LOCAL && <a className="link-btn" href={`/api/export/expenses.xlsx?${qs}`}><Download size={14} /> Excel</a>}
          <button className="link-btn" onClick={() => api.download(`/api/export/expenses.csv?${qs}`)}>{IS_LOCAL && <Download size={14} />} CSV</button>
          <button className="link-btn" onClick={() => setTrash(true)}><Trash2 size={14} /> Lixeira</button>
        </div>
      }>
        {list.loading && !list.data && <div className="center pad"><Spinner /></div>}
        {list.data && !list.data.expenses.length && <Empty title="Nenhuma despesa encontrada" text="Ajuste os filtros ou registre uma despesa pelo microfone." />}
        {grouped.map((g) => (
          <div key={g.date}>
            <div className="day-header"><span>{relDay(g.date, tz)}</span><span>{brl(g.total)}</span></div>
            {g.items.map((e) => (
              <Row key={e.id} icon={<IconBadge name={e.category_icon} color={e.category_color} size={34} />} title={e.description}
                subtitle={`${e.category_name || 'Sem categoria'}${e.installment_total ? ` · parcela ${e.installment_no}/${e.installment_total}` : ''}${e.source === 'voice' ? ' · 🎙️' : e.source === 'recurring' ? ' · recorrente' : ''}${e.date > todayISO(tz) ? ' · futura' : ''}`}
                value={brl(e.amount_cents)} onClick={() => setEdit(e)} chevron={false} />
            ))}
          </div>
        ))}
      </Group>

      {edit && <ExpenseSheet open onClose={() => setEdit(null)} expense={edit.id ? edit : null} />}

      <Sheet open={showFilters} onClose={() => setShowFilters(false)} title="Filtros">
        <div className="form">
          <Field label="Buscar"><input value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} placeholder="Descrição ou observação" /></Field>
          <Field label="Categoria">
            <select value={filters.category_id} onChange={(e) => setFilters({ ...filters, category_id: e.target.value })}>
              <option value="">Todas</option>
              {categories.expense.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <div className="grid2">
            <Field label="Valor mínimo (R$)"><input inputMode="decimal" value={filters.min} onChange={(e) => setFilters({ ...filters, min: e.target.value })} /></Field>
            <Field label="Valor máximo (R$)"><input inputMode="decimal" value={filters.max} onChange={(e) => setFilters({ ...filters, max: e.target.value })} /></Field>
          </div>
          <button className="btn primary big" onClick={() => setShowFilters(false)}>Aplicar</button>
          {activeFilters > 0 && <button className="btn ghost big" onClick={() => setFilters({ q: '', category_id: '', min: '', max: '' })}><X size={16} /> Limpar filtros</button>}
        </div>
      </Sheet>

      {trash && <TrashSheet onClose={() => setTrash(false)} />}
    </div>
  );
}

function TrashSheet({ onClose }) {
  const { refresh, tz } = useApp();
  const toast = useToast();
  const { data, reload } = useAsync(() => api.get('/api/expenses/trash', { cache: false }), []);
  async function restore(e) {
    await api.post(`/api/expenses/${e.id}/restore`);
    toast('Despesa recuperada.', { tone: 'ok' });
    reload();
    refresh();
  }
  return (
    <Sheet open onClose={onClose} title="Despesas excluídas" tall>
      {!data ? <div className="center pad"><Spinner /></div> : !data.expenses.length ? <Empty title="Lixeira vazia" /> : (
        <div className="group-body">
          {data.expenses.map((e) => (
            <Row key={e.id} icon={<IconBadge name={e.category_icon} color={e.category_color} size={32} />} title={e.description} subtitle={`${relDay(e.date, tz)} · ${brl(e.amount_cents)}`}>
              <button className="btn small ghost" onClick={() => restore(e)}><RotateCcw size={14} /> Recuperar</button>
            </Row>
          ))}
        </div>
      )}
    </Sheet>
  );
}
