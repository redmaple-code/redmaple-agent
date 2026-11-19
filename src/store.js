import { open, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentBaseError, clone, emptyState } from './shared.js';

export class MemoryStore {
  constructor(state = emptyState()) {
    this.state = clone(state);
    this.pending = Promise.resolve();
    this.closed = false;
  }

  snapshot() {
    return clone(this.state);
  }

  update(mutator) {
    const task = this.pending.then(async () => {
      if (this.closed) throw new AgentBaseError('store_closed', 'Session store is closed');
      const next = clone(this.state);
      const result = mutator(next);
      if (result instanceof Promise) throw new TypeError('Store mutators must be synchronous');
      await this.persist(next);
      this.state = next;
      return result;
    });
    this.pending = task.catch(() => {});
    return task;
  }

  async persist() {}

  async close() {
    await this.pending;
    this.closed = true;
  }
}

export function ownerAlive(owner) {
  if (!owner) return false;
  if (owner.host !== hostname()) return true;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

export class FileStore extends MemoryStore {
  static async open(directory, sessionId, { recoverLock = false } = {}) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId)) {
      throw new AgentBaseError('invalid_session_id', 'Use 1–100 letters, digits, underscores or hyphens');
    }
    const folder = resolve(directory);
    await mkdir(folder, { recursive: true });
    const lockPath = join(folder, `${sessionId}.lock`);
    if (recoverLock) await FileStore.recoverLock(lockPath);
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new AgentBaseError('session_locked', 'Session has an owner. Recover a stopped owner with recoverLock');
      }
      throw error;
    }
    const owner = { pid: process.pid, host: hostname(), token: randomUUID() };
    try {
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
      await handle.close();
      let state = emptyState();
      const path = join(folder, `${sessionId}.json`);
      try {
        state = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (state.schemaVersion !== 1 || !Array.isArray(state.messages) || !state.calls || !state.runs || !state.context
        || !Array.isArray(state.queues?.steering) || !Array.isArray(state.queues?.followUp)) {
        throw new AgentBaseError('store_incompatible', 'Session schema is unsupported or incomplete');
      }
      const store = new FileStore(state);
      Object.assign(store, { path, lockPath, owner });
      return store;
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(lockPath);
      throw error;
    }
  }

  static async recoverLock(lockPath) {
    // Serialize recovery so a second recovery cannot remove a newly acquired owner.
    const guardPath = `${lockPath}.recovery`;
    const guard = await open(guardPath, 'wx', 0o600);
    try {
      let owner;
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw new AgentBaseError('lock_unreadable', 'Inspect the unreadable lock before recovery');
      }
      if (ownerAlive(owner)) throw new AgentBaseError('session_locked', 'The session owner may still be alive');
      await unlink(lockPath);
    } finally {
      await guard.close();
      await unlink(guardPath);
    }
  }

  async persist(state) {
    const current = JSON.parse(await readFile(this.lockPath, 'utf8'));
    if (current.token !== this.owner.token) throw new AgentBaseError('owner_changed', 'Session ownership changed');
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path);
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    await super.close();
    const current = JSON.parse(await readFile(this.lockPath, 'utf8'));
    if (current.token === this.owner.token) await unlink(this.lockPath);
  }
}
