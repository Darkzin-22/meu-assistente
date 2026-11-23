import { DateTime } from 'luxon';
import { sendToUser } from './push.js';
import { materializeCharges } from './recurring.js';
import { backupDb } from './db.js';
import { now, nowUtcIso, today } from './time.js';
import { brl } from './money.js';
import { loadUser } from './auth.js';

const MISSED_AFTER_HOURS = 6; // lembretes atrasados há mais que isso (servidor desligado) não são enviados

/** Envia os lembretes vencidos. Seguro para rodar várias vezes (status 'sending' trava a linha). */
export async function sendDueReminders(db) {
  const nowIso = now().toUTC().toISO();
  const staleIso = now().toUTC().minus({ hours: MISSED_AFTER_HOURS }).toISO();
  db.prepare(`UPDATE reminders SET status='missed' WHERE status='pending' AND fire_at < ?`).run(staleIso);
  const due = db.transaction(() => {
    const rows = db.prepare(`SELECT r.*, e.date, e.time, e.icon, e.status AS ev_status, e.deleted_at FROM reminders r JOIN events e ON e.id=r.event_id
      WHERE r.status='pending' AND r.fire_at <= ? ORDER BY r.fire_at LIMIT 100`).all(nowIso);
    const lock = db.prepare(`UPDATE reminders SET status='sending' WHERE id=? AND status='pending'`);
    return rows.filter((r) => lock.run(r.id).changes === 1);
  })();
  const results = [];
  for (const r of due) {
    if (r.ev_status !== 'scheduled' || r.deleted_at) {
      db.prepare(`UPDATE reminders SET status='cancelled' WHERE id=?`).run(r.id);
      continue;
    }
    const res = await sendToUser(db, r.user_id, {
      title: r.title,
      body: r.body,
      tag: `ev-${r.event_id}-${r.kind}`,
      url: `/?tab=agenda&event=${r.event_id}`,
      kind: 'reminder',
    });
    const ok = res.sent > 0;
    db.prepare(`UPDATE reminders SET status=?, sent_at=?, error=? WHERE id=?`).run(ok ? 'sent' : 'failed', nowUtcIso(), ok ? null : res.devices ? res.errors.join('; ').slice(0, 300) : 'Nenhum dispositivo com notificações ativadas', r.id);
    results.push({ id: r.id, ok, ...res });
  }
  return results;
}

/** Tarefas diárias por usuário: gerar cobranças vencidas e avisar cobranças do dia (às 10h locais). */
export async function dailyTasks(db) {
  const users = db.prepare(`SELECT id FROM users`).all();
  for (const { id } of users) {
    const user = loadUser(db, id);
    materializeCharges(db, user);
    const local = now(user.timezone);
    if (local.hour < 10) continue;
    const t = today(user.timezone);
    const charges = db.prepare(`SELECT ch.*, r.name, r.auto_confirm FROM recurrence_charges ch JOIN recurrences r ON r.id=ch.recurrence_id
      WHERE ch.user_id=? AND ch.due_date=? AND ch.notified_at IS NULL AND r.status='active'`).all(user.id, t);
    for (const ch of charges) {
      if (user.settings?.charge_notifications === false) break;
      db.prepare(`UPDATE recurrence_charges SET notified_at=? WHERE id=?`).run(nowUtcIso(), ch.id);
      await sendToUser(db, user.id, {
        title: `${ch.name} vence hoje`,
        body: ch.status === 'paid' ? `${brl(ch.amount_cents)} — pagamento já registrado.` : `${brl(ch.amount_cents)} — toque para confirmar o pagamento.`,
        tag: `charge-${ch.id}`,
        url: '/?tab=assinaturas',
        kind: 'charge',
      });
    }
  }
}

let lastBackupDay = null;
export function startScheduler(db, intervalMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sendDueReminders(db);
      await dailyTasks(db);
      const day = DateTime.now().toISODate();
      if (day !== lastBackupDay) {
        lastBackupDay = day;
        await backupDb(db).catch((e) => console.error('backup falhou', e));
      }
    } catch (err) {
      console.error('scheduler', err);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
