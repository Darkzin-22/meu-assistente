import { useState } from 'react';
import { Plus, Pause, Play, X, Trash2, Pencil, Check, SkipForward } from 'lucide-react';
import { api, brl, relDay, fmtDate } from '../api.js';
import { useApp } from '../context.js';
import { Group, Row, Empty, Spinner, Sheet, Segmented, useAsync, useToast, useConfirm } from '../ui.jsx';
import { IconBadge } from '../icons.jsx';
import { RecurrenceForm } from '../forms.jsx';

export default function Subscriptions() {
  const { version, tz, refresh } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('active');
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const { data } = useAsync(() => api.get('/api/recurrences'), [version]);
  if (!data) return <div className="splash inline"><Spinner /></div>;
  const t = data.totals;
  const list = data.recurrences.filter((r) => (filter === 'active' ? r.status === 'active' : filter === 'paused' ? r.status === 'paused' : r.status === 'cancelled'));
  const pending = data.recurrences.flatMap((r) => r.pending_charges.map((c) => ({ ...c, name: r.name, icon: r.category_icon, color: r.category_color })));

  async function confirmCharge(c) {
    try { await api.post(`/api/charges/${c.id}/confirm`); toast(`Pagamento de ${c.name} confirmado.`, { tone: 'ok' }); refresh(); } catch (err) { toast(err.message, { tone: 'error' }); }
  }
  async function skip(c) {
    try { await api.post(`/api/charges/${c.id}/skip`); toast('Cobrança ignorada.'); refresh(); } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  return (
    <div className="page">
      <div className="title-row">
        <h1 className="large-title">Assinaturas</h1>
        <button className="round-btn" onClick={() => setCreating(true)} aria-label="Nova assinatura"><Plus size={22} /></button>
      </div>

      <div className="stat-grid">
        <div className="stat accent"><span>Assinaturas / mês</span><strong>{brl(t.subscriptions_monthly_cents)}</strong><small>{brl(t.subscriptions_yearly_cents)} / ano</small></div>
        <div className="stat"><span>Gastos fixos / mês</span><strong>{brl(t.fixed_monthly_cents)}</strong><small>{brl(t.fixed_yearly_cents)} / ano</small></div>
        <div className="stat"><span>Academia e esportes</span><strong>{brl(t.fitness_monthly_cents)}</strong><small>{brl(t.fitness_yearly_cents)} / ano</small></div>
        <div className="stat"><span>Total recorrente</span><strong>{brl(t.all_monthly_cents)}</strong><small>{brl(t.all_yearly_cents)} / ano</small></div>
      </div>

      {pending.length > 0 && (
        <Group title="Vencidas — aguardando confirmação" footer="Cobranças vencidas ficam como previstas até você confirmar o pagamento.">
          {pending.map((c) => (
            <Row key={c.id} icon={<IconBadge name={c.icon} color={c.color} size={32} />} title={c.name} subtitle={`${relDay(c.due_date, tz)} · ${brl(c.amount_cents)}`}>
              <div className="btn-pair">
                <button className="icon-btn" title="Ignorar esta cobrança" onClick={() => skip(c)}><SkipForward size={18} /></button>
                <button className="btn small primary" onClick={() => confirmCharge(c)}><Check size={14} /> Paguei</button>
              </div>
            </Row>
          ))}
        </Group>
      )}

      <Segmented value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Ativas' }, { value: 'paused', label: 'Pausadas' }, { value: 'cancelled', label: 'Canceladas' }]} />
      <Group>
        {list.length ? list.map((r) => (
          <Row key={r.id} icon={<IconBadge name={r.category_icon} color={r.category_color} size={36} />} title={r.name}
            subtitle={`${r.frequency_label}${r.next_due && r.status === 'active' ? ` · próxima ${fmtDate(r.next_due)}` : ''}${r.kind === 'fixed' ? ' · fixo' : ''}${r.auto_confirm ? ' · auto' : ''}`}
            value={brl(r.amount_cents)} onClick={() => setOpen(r.id)} />
        )) : <Empty title={filter === 'active' ? 'Nenhuma assinatura ativa' : 'Nada aqui'} text={filter === 'active' ? 'Diga: "Cadastre minha assinatura da Netflix por 39 reais, todo dia 15".' : undefined} />}
      </Group>

      <Sheet open={creating} onClose={() => setCreating(false)} title="Nova assinatura ou despesa fixa">
        {creating && <RecurrenceForm onDone={() => setCreating(false)} />}
      </Sheet>
      {open && <RecDetail rec={data.recurrences.find((r) => r.id === open)} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RecDetail({ rec, onClose }) {
  const { refresh, tz } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const { data } = useAsync(() => api.get(`/api/recurrences/${rec.id}/charges`, { cache: false }), [rec.id, rec.updated_at]);
  if (!rec) return null;
  async function status(s, msg) {
    try { await api.post(`/api/recurrences/${rec.id}/status`, { status: s }); toast(msg, { tone: 'ok' }); refresh(); } catch (err) { toast(err.message, { tone: 'error' }); }
  }
  const st = { pending: 'Pendente', paid: 'Pago', skipped: 'Ignorada' };
  return (
    <Sheet open onClose={onClose} title={editing ? 'Editar' : rec.name} tall>
      {editing ? <RecurrenceForm rec={rec} onDone={() => setEditing(false)} /> : (
        <div>
          <div className="event-hero">
            <IconBadge name={rec.category_icon} color={rec.category_color} size={60} />
            <div>
              <h2>{brl(rec.amount_cents)}</h2>
              <div className="muted">{rec.frequency_label} · {rec.category_name} · {rec.status === 'active' ? 'Ativa' : rec.status === 'paused' ? 'Pausada' : 'Cancelada'}</div>
            </div>
          </div>
          <Group>
            {rec.status === 'active' && <Row title="Próxima cobrança" value={rec.next_due ? fmtDate(rec.next_due, { day: '2-digit', month: 'long', year: 'numeric' }) : '—'} />}
            <Row title="Equivale por mês" value={brl(rec.monthly_cents)} />
            <Row title="Equivale por ano" value={brl(rec.yearly_cents)} />
            <Row title="Confirmação" value={rec.auto_confirm ? 'Automática' : 'Manual'} />
          </Group>
          <div className="action-grid">
            <button className="action" onClick={() => setEditing(true)}><Pencil size={20} />Editar valor/data</button>
            {rec.status === 'active' && <button className="action" onClick={async () => { await api.post(`/api/recurrences/${rec.id}/pay`); toast('Pagamento registrado.', { tone: 'ok' }); refresh(); }}><Check size={20} />Registrar pagamento</button>}
            {rec.status === 'active' && <button className="action" onClick={() => status('paused', 'Pausada.')}><Pause size={20} />Pausar</button>}
            {rec.status !== 'active' && <button className="action" onClick={() => status('active', 'Reativada.')}><Play size={20} />Reativar</button>}
            {rec.status !== 'cancelled' && <button className="action warn" onClick={async () => { if (await confirm(`Cancelar ${rec.name}? Ela deixa de ser contabilizada (o histórico é mantido).`, { confirmLabel: 'Cancelar assinatura' })) status('cancelled', 'Cancelada.'); }}><X size={20} />Cancelar</button>}
            <button className="action danger" onClick={async () => { if (await confirm(`Excluir ${rec.name} definitivamente? As despesas já pagas continuam no histórico.`, { confirmLabel: 'Excluir' })) { await api.del(`/api/recurrences/${rec.id}`); refresh(); onClose(); } }}><Trash2 size={20} />Excluir</button>
          </div>
          <Group title="Histórico de cobranças">
            {!data ? <div className="center pad"><Spinner /></div> : data.charges.length ? data.charges.map((c) => (
              <Row key={c.id} title={fmtDate(c.due_date, { day: '2-digit', month: 'short', year: 'numeric' })} subtitle={st[c.status]} value={brl(c.amount_cents)} valueTone={c.status === 'paid' ? 'pos' : ''} />
            )) : <Row title={<span className="muted">Nenhuma cobrança vencida ainda.</span>} />}
          </Group>
        </div>
      )}
    </Sheet>
  );
}
