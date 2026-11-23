import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DateTime } from 'luxon';
import { config } from './config.js';
import { seedCategories, audit } from './db-util.js';
import { AppError } from './errors.js';
import { nowUtcIso } from './time.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 180;
export const COOKIE = 'sid';

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw, stored) {
  const [alg, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(keyB64, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function loadUser(db, id) {
  const u = db.prepare(`SELECT id, email, name, timezone, settings_json, feed_token, created_at FROM users WHERE id=?`).get(id);
  if (!u) return null;
  let settings = {};
  try { settings = JSON.parse(u.settings_json || '{}'); } catch { /* vazio */ }
  delete u.settings_json;
  return { ...u, settings };
}

export function userCount(db) {
  return db.prepare(`SELECT COUNT(*) n FROM users`).get().n;
}

export async function register(db, { email, name, password, timezone }) {
  if (userCount(db) > 0 && !config.allowSignup) throw new AppError('Cadastro desativado. Este aplicativo já tem um dono.', 403, 'signup_disabled');
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError('E-mail inválido.');
  if (!password || String(password).length < 8) throw new AppError('A senha deve ter pelo menos 8 caracteres.');
  if (db.prepare(`SELECT 1 FROM users WHERE email=?`).get(email)) throw new AppError('Este e-mail já está cadastrado.');
  const hash = await hashPassword(String(password));
  const tz = timezone && DateTime.now().setZone(timezone).isValid ? timezone : config.defaultTimezone;
  const id = db.prepare(`INSERT INTO users (email, name, password_hash, timezone, feed_token, created_at) VALUES (?,?,?,?,?,?)`)
    .run(email, String(name || email.split('@')[0]).trim().slice(0, 60), hash, tz, crypto.randomBytes(24).toString('base64url'), nowUtcIso()).lastInsertRowid;
  seedCategories(db, id);
  audit(db, id, 'user', id, 'register', null, { email });
  return loadUser(db, id);
}

export async function login(db, { email, password }) {
  const u = db.prepare(`SELECT * FROM users WHERE email=?`).get(String(email || '').trim().toLowerCase());
  // Sempre calcula o hash para não revelar (pelo tempo de resposta) se o e-mail existe.
  const ok = await verifyPassword(String(password || ''), u?.password_hash || 'scrypt$AAAA$AAAA');
  if (!u || !ok) throw new AppError('E-mail ou senha incorretos.', 401, 'invalid_credentials');
  return loadUser(db, u.id);
}

export function createSession(db, userId, userAgent) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = DateTime.utc().plus({ days: SESSION_DAYS }).toISO();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, user_agent, created_at, expires_at) VALUES (?,?,?,?,?)`).run(sha256(token), userId, String(userAgent || '').slice(0, 200), nowUtcIso(), expires);
  return { token, expires };
}

export function sessionUser(db, token) {
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM sessions WHERE token_hash=?`).get(sha256(token));
  if (!s) return null;
  if (s.expires_at < DateTime.utc().toISO()) {
    db.prepare(`DELETE FROM sessions WHERE token_hash=?`).run(s.token_hash);
    return null;
  }
  return loadUser(db, s.user_id);
}

export function destroySession(db, token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token_hash=?`).run(sha256(token));
}

export async function changePassword(db, userId, current, next) {
  const u = db.prepare(`SELECT * FROM users WHERE id=?`).get(userId);
  if (!(await verifyPassword(String(current || ''), u.password_hash))) throw new AppError('Senha atual incorreta.', 401);
  if (!next || String(next).length < 8) throw new AppError('A nova senha deve ter pelo menos 8 caracteres.');
  db.prepare(`UPDATE users SET password_hash=? WHERE id=?`).run(await hashPassword(String(next)), userId);
  db.prepare(`DELETE FROM sessions WHERE user_id=?`).run(userId);
  audit(db, userId, 'user', userId, 'password_change', null, null);
}

export function cookieOptions() {
  return { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_DAYS * 86400 };
}
