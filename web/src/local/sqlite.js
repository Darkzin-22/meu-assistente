// SQLite rodando no navegador (sql.js/WebAssembly), com a mesma interface do better-sqlite3 usado no servidor.
// O banco inteiro é salvo no IndexedDB do aparelho após cada alteração.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { MIGRATIONS } from '../../../server/db-util.js';

const IDB_NAME = 'meu-assistente';
const IDB_STORE = 'db';
const IDB_KEY = 'principal';

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet() {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
    tx.onsuccess = () => resolve(tx.result || null);
    tx.onerror = () => reject(tx.error);
  });
}
async function idbPut(bytes) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const clean = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
const flat = (params) => (params.length === 1 && Array.isArray(params[0]) ? params[0] : params);

/** Adaptador: expõe prepare().run/get/all, transaction, exec e pragma como o better-sqlite3. */
class Db {
  constructor(raw) {
    this.raw = raw;
    this.depth = 0;
    this.dirty = false;
  }
  prepare(sql) {
    const raw = this.raw;
    const self = this;
    return {
      run(...p) {
        raw.run(sql, clean(flat(p)));
        const changes = raw.getRowsModified();
        const id = raw.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
        if (changes) self.dirty = true;
        return { changes, lastInsertRowid: id };
      },
      get(...p) {
        const st = raw.prepare(sql);
        try {
          st.bind(clean(flat(p)));
          return st.step() ? st.getAsObject() : undefined;
        } finally { st.free(); }
      },
      all(...p) {
        const st = raw.prepare(sql);
        const rows = [];
        try {
          st.bind(clean(flat(p)));
          while (st.step()) rows.push(st.getAsObject());
        } finally { st.free(); }
        return rows;
      },
    };
  }
  exec(sql) {
    this.raw.exec(sql);
    this.dirty = true;
  }
  pragma(s, opts = {}) {
    const res = this.raw.exec(`PRAGMA ${s}`);
    if (opts.simple) return res[0]?.values[0]?.[0];
    return res;
  }
  transaction(fn) {
    return (...args) => {
      const sp = `sp${this.depth}`;
      this.raw.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      this.depth++;
      try {
        const r = fn(...args);
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        this.dirty = true;
        return r;
      } catch (err) {
        this.depth--;
        this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
        throw err;
      }
    };
  }
  /** Grava no aparelho (se houve mudança). */
  async save(force = false) {
    if (!this.dirty && !force) return;
    this.dirty = false;
    await idbPut(this.raw.export());
  }
}

let ready = null;
export function openLocalDb() {
  if (ready) return ready;
  ready = (async () => {
    const SQL = await initSqlJs({ locateFile: () => wasmUrl });
    const saved = await idbGet();
    const raw = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
    const db = new Db(raw);
    raw.exec('PRAGMA foreign_keys = ON');
    const version = db.pragma('user_version', { simple: true }) || 0;
    for (let v = version; v < MIGRATIONS.length; v++) {
      db.transaction(() => {
        raw.exec(MIGRATIONS[v]);
        raw.exec(`PRAGMA user_version = ${v + 1}`);
      })();
    }
    // Pede ao navegador para não apagar os dados por falta de espaço.
    navigator.storage?.persist?.().catch(() => {});
    // Salva ao sair do app (garantia extra além do salvamento após cada alteração).
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') db.save(); });
    await db.save(!saved);
    return db;
  })();
  return ready;
}
