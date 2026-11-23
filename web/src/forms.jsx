import { useState } from 'react';
import { Trash2, ImagePlus, X } from 'lucide-react';
import { api, uid, toCents, centsToInput, todayISO, IS_LOCAL } from './api.js';
import { Sheet, Field, Spinner, useToast, useConfirm, Toggle } from './ui.jsx';
import { Icon, ICON_KEYS } from './icons.jsx';
import { useApp } from './context.js';

// ---------------------------------------------------------------- Despesa
export function ExpenseSheet({ open, onClose, expense }) {
  const { categories, refresh, tz } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const isNew = !expense?.id;
  const [f, setF] = useState(() => ({
    description: expense?.description || '',
    amount: centsToInput(expense?.amount_cents) || '',
    date: expense?.date || todayISO(tz),
    category_id: expense?.category_id || categories.expense.find((c) => c.key === 'outros')?.id || '',
    notes: expense?.notes || '',
    installments: 1,
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  async function save(e) {
    e.preventDefault();
    if (!toCents(f.amount)) return toast('Informe um valor válido.', { tone: 'warn' });
    setBusy(true);
    try {
      const body = { ...f, amount: f.amount, category_id: Number(f.category_id) };
      if (isNew) {
        const r = await api.queued('/api/expenses', { ...body, installments: Number(f.installments) || 1, client_id: uid() }, f.description);
        toast(r.queued ? 'Sem internet: despesa salva e será sincronizada.' : 'Despesa registrada.', { tone: 'ok' });
        r.warnings?.forEach((w) => toast(w, { tone: 'warn', duration: 6000 }));
      } else {
        const r = await api.patch(`/api/expenses/${expense.id}`, body);
        toast('Despesa atualizada.', { tone: 'ok' });
        r.warnings?.forEach((w) => toast(w, { tone: 'warn', duration: 6000 }));
      }
      refresh();
      onClose();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm(`Apagar "${expense.description}"? Ela irá para a lixeira e poderá ser recuperada.`, { confirmLabel: 'Apagar' }))) return;
    await api.del(`/api/expenses/${expense.id}`);
    toast('Despesa apagada.', { action: { label: 'Desfazer', onClick: async () => { await api.post(`/api/expenses/${expense.id}/restore`); refresh(); } } });
    refresh();
    onClose();
  }
  return (
    <Sheet open={open} onClose={onClose} title={isNew ? 'Nova despesa' : 'Editar despesa'}>
      <form className="form" onSubmit={save}>
        <div className="amount-input">
          <span>R$</span>
          <input inputMode="decimal" placeholder="0,00" value={f.amount} onChange={(e) => set('amount', e.target.value)} autoFocus={isNew} required />
        </div>
        <Field label="Descrição"><input value={f.description} onChange={(e) => set('description', e.target.value)} required placeholder="Ex.: Almoço" /></Field>
        <div className="grid2">
          <Field label="Data"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required /></Field>
          {isNew && <Field label="Parcelas"><select value={f.installments} onChange={(e) => set('installments', e.target.value)}>{Array.from({ length: 24 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 0 ? 'À vista' : `${i + 1}x`}</option>)}</select></Field>}
        </div>
        <Field label="Categoria">
          <div className="cat-chips">
            {categories.expense.map((c) => (
              <button type="button" key={c.id} className={`cat-chip ${Number(f.category_id) === c.id ? 'active' : ''}`} style={{ '--c': c.color }} onClick={() => set('category_id', c.id)}>
                <Icon name={c.icon} size={15} /> {c.name}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Observações"><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {expense?.installment_total && <p className="muted small">Parcela {expense.installment_no} de {expense.installment_total}.</p>}
        <button className="btn primary big" disabled={busy}>{busy ? <Spinner size={18} /> : 'Salvar'}</button>
        {!isNew && <button type="button" className="btn danger-ghost big" onClick={remove}><Trash2 size={18} /> Apagar despesa</button>}
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Compromisso
async function resizeImage(file, max = 256) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

export function EventForm({ event, defaultDate, onDone }) {
  const { categories, refresh, tz } = useApp();
  const toast = useToast();
  const isNew = !event?.id;
  const [f, setF] = useState(() => ({
    title: event?.title || '',
    date: event?.date || defaultDate || todayISO(tz),
    time: event?.time || '',
    all_day: event ? !event.time : false,
    category_id: event?.category_id || categories.event.find((c) => c.key === 'tarefa')?.id || '',
    icon: event?.icon || '',
    image: event?.image || null,
    location: event?.location || '',
    notes: event?.notes || '',
    duration_min: event?.duration_min || 60,
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));

  async function save(e) {
    e.preventDefault();
    if (!f.all_day && !f.time) return toast('Informe o horário (ou marque "Dia inteiro").', { tone: 'warn' });
    setBusy(true);
    try {
      const body = { ...f, time: f.all_day ? null : f.time, category_id: Number(f.category_id), icon: f.icon || null, duration_min: Number(f.duration_min) };
      delete body.all_day;
      if (isNew) {
        const r = await api.queued('/api/events', { ...body, client_id: uid() }, f.title);
        if (r.queued) toast('Sem internet: compromisso salvo e será sincronizado.', { tone: 'warn' });
        else {
          const n = r.reminders.filter((x) => x.status === 'pending').length;
          toast(IS_LOCAL ? 'Agendado. Toque em "Calendário" para ativar os alarmes no iPhone.' : `Agendado. ${n} lembrete(s) programado(s).`, { tone: 'ok', duration: 8000, action: body.time ? { label: 'Calendário', onClick: () => api.download(`/api/events/${r.event.id}/ics`) } : undefined });
          r.warnings?.forEach((w) => toast(w, { tone: 'warn' }));
        }
      } else {
        await api.patch(`/api/events/${event.id}`, body);
        toast('Compromisso atualizado. Lembretes reprogramados.', { tone: 'ok' });
      }
      refresh();
      onDone?.();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  const cat = categories.event.find((c) => c.id === Number(f.category_id));
  return (
    <form className="form" onSubmit={save}>
      <Field label="Compromisso"><input value={f.title} onChange={(e) => set('title', e.target.value)} required placeholder="Ex.: Consulta no dentista" autoFocus={isNew} /></Field>
      <div className="grid2">
        <Field label="Data"><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} required /></Field>
        <Field label="Horário"><input type="time" value={f.time} disabled={f.all_day} onChange={(e) => set('time', e.target.value)} /></Field>
      </div>
      <div className="row-inline"><span>Dia inteiro</span><Toggle checked={f.all_day} onChange={(v) => set('all_day', v)} /></div>
      <Field label="Categoria">
        <div className="cat-chips">
          {categories.event.map((c) => (
            <button type="button" key={c.id} className={`cat-chip ${Number(f.category_id) === c.id ? 'active' : ''}`} style={{ '--c': c.color }} onClick={() => set('category_id', c.id)}>
              <Icon name={c.icon} size={15} /> {c.name}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Ícone">
        <div className="icon-grid">
          <button type="button" className={!f.icon ? 'active' : ''} onClick={() => set('icon', '')} title="Automático">Auto</button>
          {ICON_KEYS.map((k) => (
            <button type="button" key={k} className={f.icon === k ? 'active' : ''} onClick={() => set('icon', k)} aria-label={k} style={f.icon === k ? { background: cat?.color } : undefined}><Icon name={k} size={18} /></button>
          ))}
        </div>
      </Field>
      <Field label="Imagem personalizada">
        <div className="image-pick">
          {f.image ? (
            <>
              <img src={f.image} alt="" />
              <button type="button" className="btn small ghost" onClick={() => set('image', null)}><X size={14} /> Remover</button>
            </>
          ) : (
            <label className="btn small ghost">
              <ImagePlus size={16} /> Escolher foto
              <input type="file" accept="image/*" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (file) set('image', await resizeImage(file)); }} />
            </label>
          )}
        </div>
      </Field>
      <Field label="Local"><input value={f.location} onChange={(e) => set('location', e.target.value)} placeholder="Opcional" /></Field>
      <Field label="Observações"><textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
      <button className="btn primary big" disabled={busy}>{busy ? <Spinner size={18} /> : isNew ? 'Agendar' : 'Salvar alterações'}</button>
    </form>
  );
}

// ---------------------------------------------------------------- Assinatura / despesa fixa
export function RecurrenceForm({ rec, onDone }) {
  const { categories, refresh, tz } = useApp();
  const toast = useToast();
  const isNew = !rec?.id;
  const [f, setF] = useState(() => ({
    name: rec?.name || '',
    amount: centsToInput(rec?.amount_cents) || '',
    frequency: rec?.frequency || 'monthly',
    interval: rec?.interval || 1,
    anchor_date: rec?.next_due || rec?.anchor_date || todayISO(tz),
    kind: rec?.kind || 'subscription',
    category_id: rec?.category_id || categories.expense.find((c) => c.key === 'assinaturas')?.id || '',
    auto_confirm: !!rec?.auto_confirm,
    notes: rec?.notes || '',
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = { ...f, category_id: Number(f.category_id), interval: Number(f.interval) };
      if (!isNew && rec.next_due === f.anchor_date) delete body.anchor_date; // data não mudou
      if (isNew) await api.post('/api/recurrences', body);
      else await api.patch(`/api/recurrences/${rec.id}`, body);
      toast(isNew ? 'Cadastrado. As próximas cobranças serão previstas automaticamente.' : 'Atualizado.', { tone: 'ok' });
      refresh();
      onDone?.();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form" onSubmit={save}>
      <Field label="Nome"><input value={f.name} onChange={(e) => set('name', e.target.value)} required placeholder="Ex.: Netflix, Academia" autoFocus={isNew} /></Field>
      <div className="amount-input small">
        <span>R$</span>
        <input inputMode="decimal" placeholder="0,00" value={f.amount} onChange={(e) => set('amount', e.target.value)} required />
      </div>
      <div className="grid2">
        <Field label="Frequência">
          <select value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>
            <option value="monthly">Mensal</option><option value="yearly">Anual</option><option value="weekly">Semanal</option><option value="days">A cada X dias</option>
          </select>
        </Field>
        <Field label={f.frequency === 'days' ? 'A cada (dias)' : 'Intervalo'}><input type="number" min="1" max="365" value={f.interval} onChange={(e) => set('interval', e.target.value)} /></Field>
      </div>
      <Field label={isNew ? 'Primeira cobrança' : 'Próxima cobrança'} hint="Define o dia das cobranças seguintes."><input type="date" value={f.anchor_date} onChange={(e) => set('anchor_date', e.target.value)} required /></Field>
      <Field label="Tipo">
        <select value={f.kind} onChange={(e) => set('kind', e.target.value)}><option value="subscription">Assinatura</option><option value="fixed">Despesa fixa (academia, aluguel…)</option></select>
      </Field>
      <Field label="Categoria">
        <select value={f.category_id} onChange={(e) => set('category_id', e.target.value)}>{categories.expense.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </Field>
      <div className="row-inline"><span>Confirmar pagamento automaticamente<br /><small className="muted">Ao vencer, já entra como despesa paga.</small></span><Toggle checked={f.auto_confirm} onChange={(v) => set('auto_confirm', v)} /></div>
      <button className="btn primary big" disabled={busy}>{busy ? <Spinner size={18} /> : 'Salvar'}</button>
    </form>
  );
}
