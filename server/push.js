import fs from 'node:fs';
import path from 'node:path';
import * as webpush from 'web-push';
import { config } from './config.js';
import { nowUtcIso } from './time.js';

// Chaves VAPID: geradas uma única vez e guardadas no diretório de dados (ou vindas do ambiente).
let keys = null;
export function vapidKeys() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const file = path.join(config.dataDir, 'vapid.json');
    if (fs.existsSync(file)) keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      keys = webpush.generateVAPIDKeys();
      fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
  }
  webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
  return keys;
}

// Permite substituir o envio em testes.
let sender = (sub, payload, opts) => webpush.sendNotification(sub, payload, opts);
export function setPushSender(fn) { sender = fn; }

export function saveSubscription(db, userId, sub, userAgent) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Inscrição de push inválida.');
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, user_agent=excluded.user_agent, last_error=NULL`)
    .run(userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null, nowUtcIso());
}

export function removeSubscription(db, userId, endpoint) {
  db.prepare(`DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?`).run(userId, endpoint);
}

/**
 * Envia uma notificação a todos os dispositivos do usuário.
 * Retorna { sent, failed, devices }.
 */
export async function sendToUser(db, userId, payload, { ttl = 6 * 3600, urgency = 'high' } = {}) {
  vapidKeys();
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id=?`).all(userId);
  let sent = 0, failed = 0;
  const errors = [];
  for (const s of subs) {
    try {
      await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: ttl, urgency, topic: payload.tag ? String(payload.tag).slice(0, 32).replace(/[^A-Za-z0-9_-]/g, '') : undefined });
      db.prepare(`UPDATE push_subscriptions SET last_success_at=?, last_error=NULL WHERE id=?`).run(nowUtcIso(), s.id);
      sent++;
    } catch (err) {
      failed++;
      const code = err?.statusCode;
      errors.push(`${code || ''} ${err?.body || err?.message || err}`.trim());
      // 404/410 = inscrição expirada (app removido / permissão revogada): descarta.
      if (code === 404 || code === 410) db.prepare(`DELETE FROM push_subscriptions WHERE id=?`).run(s.id);
      else db.prepare(`UPDATE push_subscriptions SET last_error=? WHERE id=?`).run(String(err?.message || err).slice(0, 300), s.id);
    }
  }
  return { sent, failed, devices: subs.length, errors };
}
