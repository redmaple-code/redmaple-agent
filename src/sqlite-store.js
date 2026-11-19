import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { MemoryStore } from './store.js';
import { emptyState, AgentBaseError } from './shared.js';

function alive(owner) {
  if (owner.host !== hostname()) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export class SqliteStore extends MemoryStore {
  static async open(file, id, { recoverLock = false } = {}) {
    const { DatabaseSync } = await import('node:sqlite');
    const path = resolve(file);
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
    try {
      database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      database.exec('CREATE TABLE IF NOT EXISTS redmaple_sessions(id TEXT PRIMARY KEY,state_json TEXT NOT NULL,owner_json TEXT NOT NULL)');
      database.exec('BEGIN IMMEDIATE');
      const row = database.prepare('SELECT * FROM redmaple_sessions WHERE id=?').get(id);
      if (row?.owner_json) {
        const prior = JSON.parse(row.owner_json);
        if (alive(prior) || !recoverLock) throw new AgentBaseError('session_locked', 'The SQLite session still has an owner');
      }
      const state = row ? JSON.parse(row.state_json) : emptyState();
      if (state.schemaVersion !== 1 || !Array.isArray(state.messages) || !state.calls || !state.runs || !state.context
        || !Array.isArray(state.queues?.steering) || !Array.isArray(state.queues?.followUp)) {
        throw new AgentBaseError('store_incompatible', 'SQLite session schema is unsupported or incomplete');
      }
      database.prepare('INSERT INTO redmaple_sessions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET owner_json=excluded.owner_json')
        .run(id, JSON.stringify(state), JSON.stringify(owner));
      database.exec('COMMIT');
      return Object.assign(new SqliteStore(state), { database, id, owner });
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      database.close();
      throw error;
    }
  }

  async persist(state) {
    const changed = this.database.prepare('UPDATE redmaple_sessions SET state_json=? WHERE id=? AND owner_json=?')
      .run(JSON.stringify(state), this.id, JSON.stringify(this.owner));
    if (changed.changes !== 1) throw new AgentBaseError('owner_changed', 'SQLite session ownership changed');
  }

  async close() {
    if (this.closed) return;
    await super.close();
    try {
      this.database.prepare("UPDATE redmaple_sessions SET owner_json='' WHERE id=? AND owner_json=?")
        .run(this.id, JSON.stringify(this.owner));
    } finally { this.database.close(); }
  }
}
