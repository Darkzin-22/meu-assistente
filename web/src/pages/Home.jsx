import { CalendarDays, Repeat, Clock, TrendingUp, Mic } from 'lucide-react';
import { api, brl, relDay } from '../api.js';
import { useApp } from '../context.js';
import { Group, Row, Empty, Spinner, useAsync, useToast } from '../ui.jsx';
import { IconBadge } from '../icons.jsx';
import { Progress } from '../charts.jsx';

export default function Home() {
  const { version, user, tz, setTab, refresh } = useApp();
  const toast = useToast();
  const { data, loading, error } = useAsync(() => api.get('/api/dashboard'), [version]);
  if (!data && loading) return <div className="splash inline"><Spinner /></div>;
  if (!data) return <Empty title="Não foi possível carregar" text={error?.message} />;
  const s = data.stats;
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: 'numeric', hour12: false }).format(new Date()));
  const greet = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', timeZone: tz }).format(new Date());
  const over = s.budgets.filter((b) => b.pct >= 0.8);

  async function confirmCharge(ch) {
    try {
      await api.post(`/api/charges/${ch.id}/confirm`);
      toast(`Pagamento de ${ch.name} confirmado.`, { tone: 'ok' });
      refresh();
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  return (
    <div className="page">
      <h1 className="large-title">{greet}{user?.name ? `, ${user.name.split(' ')[0]}` : ''}</h1>
      {data._offline && <div className="banner warn">Sem conexão — exibindo os últimos dados salvos.</div>}

      <div className="hero-card" onClick={() => setTab('financas')}>
        <div className="hero-label">Gasto em {monthName}</div>
        <div className="hero-value">{brl(s.totals.month_cents)}</div>
        <div className="hero-sub"><TrendingUp size={14} /> Previsão de fechamento: <strong>{brl(s.forecast.month_close_cents)}</strong></div>
        <div className="hero-chips">
          <div><span>Hoje</span><strong>{brl(s.totals.today_cents)}</strong></div>
          <div><span>Semana</span><strong>{brl(s.totals.week_cents)}</strong></div>
          <div><span>Ano</span><strong>{brl(s.totals.year_cents)}</strong></div>
        </div>
      </div>

      {data.pending_charges.length > 0 && (
        <Group title="Aguardando confirmação">
          {data.pending_charges.slice(0, 5).map((ch) => (
            <Row key={ch.id} icon={<IconBadge name="repeat" color="#BF5AF2" size={32} />} title={ch.name} subtitle={`Venceu ${relDay(ch.due_date, tz).toLowerCase()} · ${brl(ch.amount_cents)}`}>
              <button className="btn small primary" onClick={() => confirmCharge(ch)}>Paguei</button>
            </Row>
          ))}
        </Group>
      )}

      {over.length > 0 && (
        <Group title="Orçamento">
          {over.map((b) => (
            <div key={b.category_id} className="budget-row">
              <div className="budget-top"><span>{b.name}</span><span className={b.pct >= 1 ? 'neg' : 'warn-text'}>{brl(b.spent_cents)} de {brl(b.budget_cents)}</span></div>
              <Progress value={b.pct} />
            </div>
          ))}
        </Group>
      )}

      <Group title="Próximos compromissos" action={<button className="link-btn" onClick={() => setTab('agenda')}>Ver agenda</button>}>
        {data.upcoming_events.length ? data.upcoming_events.map((e) => (
          <Row key={e.id} icon={<IconBadge name={e.icon || e.category_icon} color={e.category_color} image={e.image} size={34} />} title={e.title}
            subtitle={<><Clock size={12} /> {relDay(e.date, tz)}{e.time ? ` · ${e.time}` : ' · dia inteiro'}</>} onClick={() => { history.replaceState(null, '', `?tab=agenda&event=${e.id}`); setTab('agenda'); }} />
        )) : <Empty icon={<CalendarDays size={28} />} title="Agenda livre" text='Segure o microfone e diga: "Marque dentista sexta às 15h".' />}
      </Group>

      <Group title="Assinaturas e fixos" action={<button className="link-btn" onClick={() => setTab('assinaturas')}>Ver todos</button>}>
        <div className="mini-stats">
          <div><span>Por mês</span><strong>{brl(data.recurring.all_monthly_cents)}</strong></div>
          <div><span>Por ano</span><strong>{brl(data.recurring.all_yearly_cents)}</strong></div>
          <div><span>Ativos</span><strong>{data.recurring.count_active}</strong></div>
        </div>
        {data.upcoming_charges.map((o) => (
          <Row key={`${o.recurrence_id}-${o.due_date}`} icon={<IconBadge name={o.category_icon || 'repeat'} color={o.category_color} size={32} />} title={o.name}
            subtitle={`${o.status === 'pending' ? 'Pendente' : 'Previsto'} · ${relDay(o.due_date, tz)}`} value={brl(o.amount_cents)} />
        ))}
        {!data.upcoming_charges.length && <Empty icon={<Repeat size={26} />} title="Nada vencendo nos próximos 14 dias" />}
      </Group>

      <Group title="Últimas despesas" action={<button className="link-btn" onClick={() => setTab('financas')}>Histórico</button>}>
        {data.recent_expenses.length ? data.recent_expenses.map((e) => (
          <Row key={e.id} icon={<IconBadge name={e.category_icon} color={e.category_color} size={32} />} title={e.description} subtitle={`${relDay(e.date, tz)} · ${e.category_name || ''}`} value={brl(e.amount_cents)} />
        )) : <Empty icon={<Mic size={28} />} title="Nenhuma despesa ainda" text='Segure o microfone e diga: "Hoje comprei um açaí de 8 reais".' />}
      </Group>
    </div>
  );
}
