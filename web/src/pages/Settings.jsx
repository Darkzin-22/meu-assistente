import { useEffect, useState } from 'react';
import { Bell, Moon, Sun, Smartphone, Sparkles, Mic, Tag, CalendarDays, Download, Upload, History, Shield, LogOut, Trash2, Plus, Copy, RotateCcw, Share, SquarePlus } from 'lucide-react';
import { api, urlB64ToUint8Array, brl, centsToInput, relDay, IS_LOCAL } from '../api.js';
import { useApp } from '../context.js';
import { Group, Row, Toggle, Segmented, Sheet, Field, Spinner, Empty, ColorPicker, useAsync, useToast, useConfirm } from '../ui.jsx';
import { IconBadge, Icon, ICON_KEYS } from '../icons.jsx';

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export default function SettingsPage() {
  const { user, caps, reloadMe, refresh, onLogout } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [sheet, setSheet] = useState(null);
  const s = user.settings;

  async function save(patch, msg = 'Salvo.') {
    try { await api.patch('/api/me', patch); await reloadMe(); refresh(); toast(msg, { tone: 'ok' }); } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  return (
    <div className="page">
      <h1 className="large-title">Ajustes</h1>

      {IS_LOCAL ? <LocalRemindersGroup /> : <NotificationsGroup />}

      <Group title="Aparência">
        <div className="card-pad">
          <Segmented value={s.theme || 'dark'} onChange={(v) => save({ settings: { theme: v } }, 'Tema alterado.')} options={[{ value: 'dark', label: 'Escuro' }, { value: 'light', label: 'Claro' }, { value: 'system', label: 'Automático' }]} />
        </div>
      </Group>

      <Group title="Lembretes dos compromissos" footer={IS_LOCAL ? "Estes são os alarmes enviados ao Calendário do iPhone junto com cada compromisso." : "Cada compromisso recebe estes avisos. Alterações reprogramam os lembretes futuros."}>
        <Row icon={<IconBadge name="bell" color="#FF9F0A" size={30} />} title="Configurar lembretes" subtitle={describeRules(s.reminders_effective)} onClick={() => setSheet('reminders')} />
        {!IS_LOCAL && <Row icon={<IconBadge name="money" color="#30D158" size={30} />} title="Avisar cobranças no dia do vencimento">
          <Toggle checked={s.charge_notifications !== false} onChange={(v) => save({ settings: { charge_notifications: v } })} />
        </Row>}
      </Group>

      {IS_LOCAL ? (
        <Group title="Voz" footer="Os comandos são entendidos aqui mesmo no iPhone, sem internet e sem custo. A voz usa o reconhecimento do próprio iPhone — o ditado do teclado também funciona no campo de texto.">
          <Row icon={<span className="icon-badge" style={{ background: '#0A84FF', width: 30, height: 30 }}><Mic size={16} color="#fff" /></span>} title="Executar comando de voz direto" subtitle="Desligado: mostra a transcrição para revisar antes">
            <Toggle checked={s.voice_auto_send !== false} onChange={(v) => save({ settings: { voice_auto_send: v } })} />
          </Row>
        </Group>
      ) : (
        <Group title="Voz e inteligência" footer={caps?.claude ? `IA disponível: ${caps.model}. O modo local funciona sem internet e sem custo.` : 'IA (Claude) não configurada no servidor — usando o interpretador local, gratuito.'}>
        <Row icon={<IconBadge name="sparkles" color="#5E5CE6" size={30} />} title="Interpretação de comandos" value={caps?.engine === 'claude' ? 'IA (Claude)' : 'Local'} />
        <div className="card-pad">
          <Segmented value={s.ai_mode || 'auto'} onChange={(v) => save({ settings: { ai_mode: v } })} options={[{ value: 'auto', label: 'Automático' }, { value: 'claude', label: 'IA' }, { value: 'local', label: 'Local' }]} />
        </div>
        <Row icon={<IconBadge name="bell" color="#FF375F" size={30} />} title="Transcrição de voz" value={caps?.transcription ? 'Servidor (Whisper)' : 'Do aparelho'} />
        <Row icon={<span className="icon-badge" style={{ background: '#0A84FF', width: 30, height: 30 }}><Mic size={16} color="#fff" /></span>} title="Executar comando de voz direto" subtitle="Desligado: mostra a transcrição para revisar antes">
          <Toggle checked={s.voice_auto_send !== false} onChange={(v) => save({ settings: { voice_auto_send: v } })} />
        </Row>
      </Group>
      )}

      <Group title="Organização">
        <Row icon={<span className="icon-badge" style={{ background: '#FF9F0A', width: 30, height: 30 }}><Tag size={16} color="#fff" /></span>} title="Categorias e orçamentos" onClick={() => setSheet('categories')} />
        <Row icon={<span className="icon-badge" style={{ background: '#8E8E93', width: 30, height: 30 }}><Smartphone size={16} color="#fff" /></span>} title="Fuso horário" value={user.timezone.replace('_', ' ')} onClick={() => setSheet('tz')} />
      </Group>

      {!IS_LOCAL && <Group title="Calendário do iPhone" footer="Assine este endereço no app Calendário (Ajustes › Calendário › Contas › Adicionar conta › Outra › Calendário assinado) para ver seus compromissos lá também.">
        <Row icon={<span className="icon-badge" style={{ background: '#FF453A', width: 30, height: 30 }}><CalendarDays size={16} color="#fff" /></span>} title="Copiar link do calendário" onClick={async () => {
          const url = `webcal://${location.host}/api/feed/${user.feed_token}.ics`;
          try { await navigator.clipboard.writeText(url); toast('Link copiado.', { tone: 'ok' }); } catch { prompt('Copie o link:', url); }
        }} />
      </Group>}

      <Group title="Dados e privacidade" footer={IS_LOCAL ? "Seus dados ficam guardados só neste iPhone, não vão para nenhum servidor. Faça um backup de vez em quando (ex.: uma vez por semana): se o app for apagado da Tela de Início, os dados vão junto." : undefined}>
        {!IS_LOCAL && <a className="row tappable" href="/api/export/expenses.xlsx"><div className="row-icon"><span className="icon-badge" style={{ background: '#30D158', width: 30, height: 30 }}><Download size={16} color="#fff" /></span></div><div className="row-main"><div className="row-title">Exportar despesas (Excel)</div></div></a>}
        <Row icon={<span className="icon-badge" style={{ background: '#66D4CF', width: 30, height: 30 }}><Download size={16} color="#fff" /></span>} title={IS_LOCAL ? 'Exportar despesas (CSV — abre no Excel e no Numbers)' : 'Exportar despesas (CSV)'} onClick={() => api.download('/api/export/expenses.csv').catch((e) => toast(e.message, { tone: 'error' }))} />
        <Row icon={<span className="icon-badge" style={{ background: '#0A84FF', width: 30, height: 30 }}><Shield size={16} color="#fff" /></span>} title="Baixar backup completo" subtitle={IS_LOCAL ? 'Guarde no iCloud Drive; serve também para levar os dados ao computador' : 'Despesas, assinaturas, agenda e categorias'} onClick={() => api.download('/api/backup').catch((e) => toast(e.message, { tone: 'error' }))} />
        <Row icon={<span className="icon-badge" style={{ background: '#5E5CE6', width: 30, height: 30 }}><Upload size={16} color="#fff" /></span>} title="Restaurar backup" onClick={() => setSheet('restore')} />
        <Row icon={<span className="icon-badge" style={{ background: '#8E8E93', width: 30, height: 30 }}><Trash2 size={16} color="#fff" /></span>} title="Compromissos excluídos" onClick={() => setSheet('evtrash')} />
        <Row icon={<span className="icon-badge" style={{ background: '#AC8E68', width: 30, height: 30 }}><History size={16} color="#fff" /></span>} title="Histórico de alterações" onClick={() => setSheet('audit')} />
      </Group>

      {IS_LOCAL ? (
        <Group title="Você">
          <Row title="Seu nome" value={user.name} onClick={() => { const n = prompt('Como você quer ser chamado?', user.name || ''); if (n && n.trim()) save({ name: n.trim() }, 'Nome atualizado.'); }} />
        </Group>
      ) : (
      <Group title="Conta" footer={user.email}>
        <Row title="Alterar senha" onClick={() => setSheet('password')} />
        <Row title={<span className="neg"><LogOut size={15} /> Sair</span>} onClick={async () => { if (await confirm('Sair desta conta neste aparelho?', { confirmLabel: 'Sair' })) { await api.post('/api/auth/logout'); onLogout(); } }} />
      </Group>
      )}
      <p className="muted small center">Meu Assistente · v1.0</p>

      {sheet === 'reminders' && <RemindersSheet onClose={() => setSheet(null)} rules={s.reminders_effective} custom={!!s.reminders} onSave={(r) => save({ settings: { reminders: r } }, 'Lembretes atualizados e reprogramados.')} />}
      {sheet === 'categories' && <CategoriesSheet onClose={() => setSheet(null)} />}
      {sheet === 'tz' && <TzSheet onClose={() => setSheet(null)} value={user.timezone} onSave={(tz) => { save({ timezone: tz }, 'Fuso horário alterado. Lembretes reprogramados.'); setSheet(null); }} />}
      {sheet === 'restore' && <RestoreSheet onClose={() => setSheet(null)} />}
      {sheet === 'evtrash' && <EventTrash onClose={() => setSheet(null)} />}
      {sheet === 'audit' && <AuditSheet onClose={() => setSheet(null)} />}
      {sheet === 'password' && <PasswordSheet onClose={() => setSheet(null)} />}
    </div>
  );
}

function describeRules(rules = []) {
  return rules.filter((r) => r.enabled !== false).map((r) => (r.type === 'days' ? `${r.days}d antes às ${r.time}` : r.minutes >= 60 && r.minutes % 60 === 0 ? `${r.minutes / 60}h antes` : `${r.minutes} min antes`)).join(' · ') || 'Nenhum';
}

// ---------------------------------------------------------------- Lembretes pelo Calendário (versão local)
function LocalRemindersGroup() {
  return (
    <Group title="Como os lembretes funcionam">
      <div className="install-hint">
        <p>Para os avisos tocarem <strong>mesmo com o app fechado</strong>, cada compromisso é enviado ao <strong>Calendário do iPhone</strong> com os alarmes configurados (5 dias, 1 dia, 2 horas e 10 minutos antes).</p>
        <ol>
          <li>Ao criar um compromisso, toque em <strong>Adicionar ao Calendário</strong>.</li>
          <li>Na tela do iPhone, toque em <strong>Adicionar</strong>.</li>
        </ol>
        <p className="muted small">Se remarcar ou desmarcar um compromisso, faça o mesmo no app Calendário. Para instalar o app: Safari › <Share size={14} /> Compartilhar › <SquarePlus size={14} /> Adicionar à Tela de Início.</p>
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------- Notificações
function NotificationsGroup() {
  const toast = useToast();
  const { caps } = useApp();
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [perm, setPerm] = useState(supported ? Notification.permission : 'unsupported');
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = useAsync(() => api.get('/api/push/status', { cache: false }), [subscribed]);

  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setSubscribed(!!s)).catch(() => {});
  }, [supported]);

  async function enable() {
    setBusy(true);
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') { toast('Permissão negada. Ative em Ajustes › Notificações › Assistente.', { tone: 'warn', duration: 6000 }); return; }
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(caps.vapidPublicKey) });
      await api.post('/api/push/subscribe', { subscription: sub.toJSON() });
      setSubscribed(true);
      toast('Notificações ativadas neste aparelho.', { tone: 'ok' });
    } catch (err) {
      toast(`Não foi possível ativar: ${err.message}`, { tone: 'error', duration: 6000 });
    } finally { setBusy(false); }
  }
  async function test() {
    try { const r = await api.post('/api/push/test'); toast(r.sent ? 'Notificação de teste enviada. Ela deve chegar em alguns segundos.' : `Falhou: ${r.errors?.join(', ')}`, { tone: r.sent ? 'ok' : 'error' }); status.reload(); } catch (err) { toast(err.message, { tone: 'error' }); }
  }

  const needsInstall = isIOS && !isStandalone;
  return (
    <Group title="Notificações" footer={needsInstall ? null : 'Os lembretes são enviados pelo servidor e chegam mesmo com o app fechado.'}>
      {needsInstall ? (
        <div className="install-hint">
          <p><strong>No iPhone, as notificações só funcionam com o app instalado na Tela de Início</strong> (iOS 16.4 ou superior).</p>
          <ol>
            <li>Toque em <Share size={15} /> <strong>Compartilhar</strong> no Safari.</li>
            <li>Escolha <SquarePlus size={15} /> <strong>Adicionar à Tela de Início</strong>.</li>
            <li>Abra o app pelo ícone e volte aqui para ativar.</li>
          </ol>
        </div>
      ) : !supported ? (
        <Row icon={<IconBadge name="bell" color="#8E8E93" size={30} />} title="Notificações indisponíveis neste navegador" subtitle="No iPhone, use o Safari (iOS 16.4+) e instale na Tela de Início." />
      ) : (
        <>
          <Row icon={<IconBadge name="bell" color={subscribed && perm === 'granted' ? '#30D158' : '#FF453A'} size={30} />} title={subscribed && perm === 'granted' ? 'Ativadas neste aparelho' : perm === 'denied' ? 'Bloqueadas nos ajustes do aparelho' : 'Desativadas'}>
            {!(subscribed && perm === 'granted') && perm !== 'denied' && <button className="btn small primary" disabled={busy} onClick={enable}>{busy ? <Spinner size={14} /> : 'Ativar'}</button>}
            {subscribed && perm === 'granted' && <button className="btn small ghost" onClick={test}>Testar</button>}
          </Row>
          {status.data && <Row title="Aparelhos inscritos" value={status.data.devices.length} />}
          {status.data?.pending?.length > 0 && <Row title="Próximo lembrete" subtitle={status.data.pending[0].title} value={new Date(status.data.pending[0].fire_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} />}
        </>
      )}
    </Group>
  );
}

// ---------------------------------------------------------------- Lembretes
function RemindersSheet({ rules, custom, onSave, onClose }) {
  const [list, setList] = useState(() => rules.map((r) => ({ ...r })));
  const upd = (i, k, v) => setList((l) => l.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <Sheet open onClose={onClose} title="Lembretes" tall>
      <div className="form">
        {list.map((r, i) => (
          <div key={i} className="rule">
            <div className="rule-top">
              <select value={r.type} onChange={(e) => upd(i, 'type', e.target.value)}>
                <option value="days">Dias antes, em horário fixo</option>
                <option value="minutes">Tempo antes do horário</option>
              </select>
              <Toggle checked={r.enabled !== false} onChange={(v) => upd(i, 'enabled', v)} />
              <button className="icon-btn" onClick={() => setList(list.filter((_, j) => j !== i))} aria-label="Remover"><Trash2 size={18} /></button>
            </div>
            {r.type === 'days' ? (
              <div className="grid2">
                <Field label="Dias antes"><input type="number" min="0" max="60" value={r.days ?? 1} onChange={(e) => upd(i, 'days', Number(e.target.value))} /></Field>
                <Field label="Horário"><input type="time" value={r.time || '10:00'} onChange={(e) => upd(i, 'time', e.target.value)} /></Field>
              </div>
            ) : (
              <Field label="Minutos antes"><input type="number" min="1" max="10080" value={r.minutes ?? 60} onChange={(e) => upd(i, 'minutes', Number(e.target.value))} /></Field>
            )}
          </div>
        ))}
        {list.length < 10 && <button className="btn ghost big" onClick={() => setList([...list, { kind: `r${Date.now() % 100000}`, type: 'minutes', minutes: 30, enabled: true }])}><Plus size={16} /> Adicionar lembrete</button>}
        <button className="btn primary big" onClick={() => { onSave(list); onClose(); }}>Salvar</button>
        {custom && <button className="btn ghost big" onClick={() => { onSave(null); onClose(); }}><RotateCcw size={16} /> Restaurar padrão (5 dias, 1 dia, 2h, 10 min)</button>}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Categorias
function CategoriesSheet({ onClose }) {
  const { categories, reloadMe, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState('expense');
  const [edit, setEdit] = useState(null);
  async function save(c) {
    try {
      if (c.id) await api.patch(`/api/categories/${c.id}`, { name: c.name, icon: c.icon, color: c.color, budget: c.budget });
      else await api.post('/api/categories', { kind, name: c.name, icon: c.icon, color: c.color, budget: c.budget });
      await reloadMe(); refresh(); setEdit(null); toast('Categoria salva.', { tone: 'ok' });
    } catch (err) { toast(err.message, { tone: 'error' }); }
  }
  async function remove(c) {
    if (!(await confirm(`Excluir "${c.name}"? Os registros serão movidos para ${kind === 'expense' ? '"Outros"' : '"Tarefa pessoal"'}.`, { confirmLabel: 'Excluir' }))) return;
    try { await api.del(`/api/categories/${c.id}`); await reloadMe(); refresh(); setEdit(null); } catch (err) { toast(err.message, { tone: 'error' }); }
  }
  return (
    <Sheet open onClose={onClose} title="Categorias" tall>
      {edit ? (
        <div className="form">
          <div className="center"><IconBadge name={edit.icon} color={edit.color} size={64} /></div>
          <Field label="Nome"><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus /></Field>
          <Field label="Cor"><ColorPicker value={edit.color} onChange={(c) => setEdit({ ...edit, color: c })} /></Field>
          <Field label="Ícone"><div className="icon-grid">{ICON_KEYS.map((k) => <button type="button" key={k} className={edit.icon === k ? 'active' : ''} style={edit.icon === k ? { background: edit.color } : undefined} onClick={() => setEdit({ ...edit, icon: k })}><Icon name={k} size={18} /></button>)}</div></Field>
          {kind === 'expense' && <Field label="Orçamento mensal (R$)" hint="Você recebe um alerta ao atingir 80% e ao ultrapassar."><input inputMode="decimal" placeholder="Sem orçamento" value={edit.budget} onChange={(e) => setEdit({ ...edit, budget: e.target.value })} /></Field>}
          <button className="btn primary big" disabled={!edit.name?.trim()} onClick={() => save(edit)}>Salvar</button>
          {edit.id && <button className="btn danger-ghost big" onClick={() => remove(edit)}><Trash2 size={16} /> Excluir categoria</button>}
          <button className="btn ghost big" onClick={() => setEdit(null)}>Voltar</button>
        </div>
      ) : (
        <>
          <Segmented value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Despesas' }, { value: 'event', label: 'Agenda' }]} />
          <div className="group-body mt">
            {categories[kind].map((c) => (
              <Row key={c.id} icon={<IconBadge name={c.icon} color={c.color} size={30} />} title={c.name} value={c.budget_cents ? `${brl(c.budget_cents)}/mês` : undefined} onClick={() => setEdit({ ...c, budget: centsToInput(c.budget_cents) })} />
            ))}
          </div>
          <button className="btn ghost big mt" onClick={() => setEdit({ name: '', icon: 'dots', color: '#0A84FF', budget: '' })}><Plus size={16} /> Nova categoria</button>
        </>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------- Fuso horário
function TzSheet({ value, onSave, onClose }) {
  const all = (Intl.supportedValuesOf?.('timeZone') || ['America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza', 'America/Recife', 'America/Cuiaba', 'America/Rio_Branco', 'America/Noronha', 'Europe/Lisbon', 'UTC']);
  const [q, setQ] = useState('');
  const br = ['America/Sao_Paulo', 'America/Manaus', 'America/Fortaleza', 'America/Recife', 'America/Bahia', 'America/Belem', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Noronha'];
  const list = q ? all.filter((z) => z.toLowerCase().includes(q.toLowerCase())) : br;
  return (
    <Sheet open onClose={onClose} title="Fuso horário" tall>
      <input className="search-input" placeholder="Buscar fuso (ex.: Lisbon)" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="group-body mt">
        {list.slice(0, 80).map((z) => <Row key={z} title={z.replace(/_/g, ' ')} value={z === value ? '✓' : undefined} onClick={() => onSave(z)} chevron={false} />)}
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------- Backup
function RestoreSheet({ onClose }) {
  const toast = useToast();
  const { refresh, reloadMe } = useApp();
  const [data, setData] = useState(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  async function restore() {
    setBusy(true);
    try { await api.post('/api/restore', { confirm: 'RESTAURAR', data }); toast('Backup restaurado.', { tone: 'ok' }); await reloadMe(); refresh(); onClose(); } catch (err) { toast(err.message, { tone: 'error' }); } finally { setBusy(false); }
  }
  return (
    <Sheet open onClose={onClose} title="Restaurar backup">
      <div className="form">
        <p className="muted">Atenção: a restauração <strong>substitui todos os dados atuais</strong> pelos do arquivo. Baixe um backup atual antes, se quiser.</p>
        <input type="file" accept="application/json,.json" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; try { setData(JSON.parse(await f.text())); } catch { toast('Arquivo inválido.', { tone: 'error' }); } }} />
        {data && <p className="small">Arquivo de {data.exported_at?.slice(0, 10)}: {data.expenses?.length || 0} despesas, {data.events?.length || 0} compromissos, {data.recurrences?.length || 0} assinaturas.</p>}
        {data && <Field label='Digite RESTAURAR para confirmar'><input value={typed} onChange={(e) => setTyped(e.target.value)} /></Field>}
        <button className="btn danger big" disabled={!data || typed !== 'RESTAURAR' || busy} onClick={restore}>{busy ? <Spinner size={18} /> : 'Restaurar'}</button>
      </div>
    </Sheet>
  );
}

function EventTrash({ onClose }) {
  const { refresh, tz } = useApp();
  const { data, reload } = useAsync(() => api.get('/api/events/trash', { cache: false }), []);
  return (
    <Sheet open onClose={onClose} title="Compromissos excluídos" tall>
      {!data ? <div className="center pad"><Spinner /></div> : !data.events.length ? <Empty title="Nada por aqui" /> : (
        <div className="group-body">{data.events.map((e) => (
          <Row key={e.id} title={e.title} subtitle={`${relDay(e.date, tz)}${e.time ? ` · ${e.time}` : ''}`}>
            <button className="btn small ghost" onClick={async () => { await api.post(`/api/events/${e.id}/restore`); reload(); refresh(); }}><RotateCcw size={14} /> Recuperar</button>
          </Row>
        ))}</div>
      )}
    </Sheet>
  );
}

const ENTITY = { expense: 'Despesa', event: 'Compromisso', recurrence: 'Assinatura', charge: 'Cobrança', category: 'Categoria', user: 'Conta', backup: 'Backup' };
const ACTION = { create: 'criado(a)', update: 'alterado(a)', delete: 'excluído(a)', restore: 'restaurado(a)', purge: 'apagado(a) definitivamente', cancel: 'cancelado(a)', pause: 'pausado(a)', resume: 'reativado(a)', reschedule: 'remarcado', complete: 'concluído', confirm: 'paga', skip: 'ignorada', register: 'criada', settings: 'ajustes alterados', password_change: 'senha alterada' };
function AuditSheet({ onClose }) {
  const { data } = useAsync(() => api.get('/api/audit?limit=200', { cache: false }), []);
  const label = (e) => {
    const j = JSON.parse(e.after_json || e.before_json || '{}');
    return j.description || j.title || j.name || '';
  };
  return (
    <Sheet open onClose={onClose} title="Histórico de alterações" tall>
      {!data ? <div className="center pad"><Spinner /></div> : (
        <div className="group-body">{data.entries.map((e) => (
          <Row key={e.id} title={`${ENTITY[e.entity] || e.entity} ${ACTION[e.action] || e.action}`} subtitle={`${label(e)}${e.source ? ` · ${e.source === 'voice' ? 'por voz' : e.source === 'text' ? 'por texto' : e.source}` : ''}`} value={new Date(e.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} />
        ))}</div>
      )}
    </Sheet>
  );
}

function PasswordSheet({ onClose }) {
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '' });
  return (
    <Sheet open onClose={onClose} title="Alterar senha">
      <form className="form" onSubmit={async (e) => { e.preventDefault(); try { await api.post('/api/auth/password', f); toast('Senha alterada. Outros aparelhos foram desconectados.', { tone: 'ok' }); onClose(); } catch (err) { toast(err.message, { tone: 'error' }); } }}>
        <Field label="Senha atual"><input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoComplete="current-password" required /></Field>
        <Field label="Nova senha"><input type="password" minLength={8} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" required /></Field>
        <button className="btn primary big">Salvar</button>
      </form>
    </Sheet>
  );
}
