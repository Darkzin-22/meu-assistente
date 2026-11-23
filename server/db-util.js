// Partes do banco de dados sem dependências do Node — usadas pelo servidor e pela versão que roda no iPhone.
import { DEFAULT_EXPENSE_CATEGORIES, DEFAULT_EVENT_CATEGORIES } from './categories.js';
import { nowUtcIso } from './time.js';

export const MIGRATIONS = [
  // v1 — esquema inicial
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    settings_json TEXT NOT NULL DEFAULT '{}',
    feed_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense','event')),
    key TEXT,
    name TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'dots',
    color TEXT NOT NULL DEFAULT '#8E8E93',
    budget_cents INTEGER,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, kind, name)
  );
  CREATE TABLE recurrences (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription','fixed')),
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','yearly','days')),
    interval INTEGER NOT NULL DEFAULT 1 CHECK (interval >= 1),
    anchor_date TEXT NOT NULL,          -- primeira cobrança (YYYY-MM-DD); define dia/mês/dia da semana
    active_from TEXT NOT NULL,          -- cobranças só são geradas a partir desta data (evita retroativos)
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
    auto_confirm INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE TABLE recurrence_charges (
    id INTEGER PRIMARY KEY,
    recurrence_id INTEGER NOT NULL REFERENCES recurrences(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','skipped')),
    paid_at TEXT,
    expense_id INTEGER,
    notified_at TEXT,
    UNIQUE (recurrence_id, due_date)    -- impede cobranças duplicadas
  );
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    date TEXT NOT NULL,
    notes TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    charge_id INTEGER UNIQUE REFERENCES recurrence_charges(id) ON DELETE SET NULL,
    installment_group TEXT,
    installment_no INTEGER,
    installment_total INTEGER,
    client_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX idx_expenses_user_date ON expenses(user_id, date);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    date TEXT NOT NULL,                 -- data local (YYYY-MM-DD)
    time TEXT,                          -- hora local (HH:mm); NULL = dia inteiro
    duration_min INTEGER NOT NULL DEFAULT 60,
    start_utc TEXT NOT NULL,
    timezone TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    icon TEXT,
    image TEXT,
    location TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','done','cancelled')),
    source TEXT NOT NULL DEFAULT 'manual',
    client_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX idx_events_user_date ON events(user_id, date);
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    fire_at TEXT NOT NULL,              -- ISO UTC
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled','missed')),
    sent_at TEXT,
    error TEXT,
    UNIQUE (event_id, kind, fire_at)
  );
  CREATE INDEX idx_reminders_due ON reminders(status, fire_at);
  CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_success_at TEXT,
    last_error TEXT
  );
  CREATE TABLE commands (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id TEXT,
    text TEXT NOT NULL,
    engine TEXT,
    response_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    source TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_user ON audit_log(user_id, created_at);
  `,
];


export function seedCategories(db, userId) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO categories (user_id, kind, key, name, icon, color, sort) VALUES (?,?,?,?,?,?,?)`,
  );
  DEFAULT_EXPENSE_CATEGORIES.forEach((c, i) => ins.run(userId, 'expense', c.key, c.name, c.icon, c.color, i));
  DEFAULT_EVENT_CATEGORIES.forEach((c, i) => ins.run(userId, 'event', c.key, c.name, c.icon, c.color, i));
}

export function audit(db, userId, entity, entityId, action, before, after, source = null) {
  db.prepare(
    `INSERT INTO audit_log (user_id, entity, entity_id, action, before_json, after_json, source, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    userId, entity, entityId ?? null, action,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    source, nowUtcIso(),
  );
}

