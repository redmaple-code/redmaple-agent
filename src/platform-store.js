import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { AgentBaseError, fingerprint } from './shared.js';

const collections = ['memories', 'workflows', 'proposals', 'children', 'verifications', 'decisions',
  'candidates', 'assets', 'evaluations', 'activations'];
const schema = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at INTEGER NOT NULL);
CREATE TABLE workspaces(id TEXT PRIMARY KEY,path_key TEXT UNIQUE NOT NULL,revision INTEGER NOT NULL DEFAULT 0);
CREATE TABLE workspace_paths(path_key TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES workspaces(id),root_path TEXT NOT NULL);
CREATE TABLE state_events(seq INTEGER PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES workspaces(id),
  entity TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,action TEXT NOT NULL,created_at INTEGER NOT NULL);
${collections.map(name => `CREATE TABLE ${name}(scope_id TEXT NOT NULL REFERENCES workspaces(id),id TEXT NOT NULL,
  version INTEGER NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(scope_id,id));
CREATE INDEX ${name}_status ON ${name}(scope_id,status);`).join('\n')}
CREATE TABLE workflow_steps(scope_id TEXT NOT NULL,workflow_id TEXT NOT NULL,id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,
  PRIMARY KEY(scope_id,workflow_id,id),FOREIGN KEY(scope_id,workflow_id) REFERENCES workflows(scope_id,id) ON DELETE CASCADE);
CREATE TABLE sources(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES workspaces(id),path TEXT NOT NULL,title TEXT NOT NULL,
  status TEXT NOT NULL,current_revision TEXT NOT NULL,version INTEGER NOT NULL,UNIQUE(scope_id,path));
CREATE TABLE source_revisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,content TEXT NOT NULL,extractor TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE chunks(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL REFERENCES workspaces(id),source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,
  content TEXT NOT NULL,line_start INTEGER NOT NULL,line_end INTEGER NOT NULL);
CREATE INDEX chunks_source ON chunks(scope_id,source_id,revision_id);
CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_id UNINDEXED,scope_id UNINDEXED,content,tokenize='trigram');
CREATE TABLE chunk_terms(scope_id TEXT NOT NULL,term TEXT NOT NULL,chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  PRIMARY KEY(scope_id,term,chunk_id));
`;
const checksum = fingerprint(schema);

function within(root, path) {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

export class PlatformStore {
  static async open(file, workspace, { workspaceId, previousWorkspace, recoverLock = false } = {}) {
    workspace = await realpath(workspace);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    let backup;
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new AgentBaseError('store_incompatible', '平台数据库版本较新，请使用对应版本程序');
      if (version === 0) {
        const legacy = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redmaple_platform'").get();
        if (legacy) {
          backup = `${resolve(file)}.before-entities-${randomUUID()}.sqlite`;
          db.prepare('VACUUM INTO ?').run(backup);
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          // Another connection may have completed the migration while this one waited.
          if (db.prepare('PRAGMA user_version').get().user_version === 0) {
            db.exec(schema);
            if (legacy) for (const row of db.prepare('SELECT * FROM redmaple_platform').all()) {
              const key = randomUUID();
              db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(key, row.workspace, row.revision);
              db.prepare('INSERT INTO workspace_paths VALUES(?,?,?)').run(row.workspace, key, '');
              const data = JSON.parse(row.data);
              for (const name of collections) for (const [id, item] of Object.entries(data[name] || {})) {
                if (name === 'workflows') {
                  item.ruleVersion ||= 'legacy';
                  for (const step of item.steps || []) step.verificationStatus ||= 'legacy_unverified';
                }
                PlatformStore.writeRow(db, key, name, id, structuredClone(item), 1);
              }
              const restored = PlatformStore.readState(db, key);
              for (const name of ['memories', 'proposals', 'children']) {
                const normalized = Object.fromEntries(Object.entries(restored[name]).map(([id, item]) => {
                  const { _revision, ...value } = item; return [id, value];
                }));
                if (fingerprint(normalized) !== fingerprint(data[name] || {})) throw new Error(`Migration mismatch: ${name}`);
              }
            }
            if (legacy) db.exec(`ALTER TABLE redmaple_platform RENAME TO redmaple_platform_archive;
              CREATE VIEW redmaple_platform AS SELECT workspace,revision,data FROM redmaple_platform_archive;`);
            db.prepare('INSERT INTO schema_migrations VALUES(1,?,?)').run(checksum, Date.now());
            db.exec('PRAGMA user_version=1');
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      if (db.prepare('SELECT checksum FROM schema_migrations WHERE version=1').get()?.checksum !== checksum) {
        throw new AgentBaseError('store_incompatible', '平台迁移校验和不匹配');
      }
      const pathKey = fingerprint(process.platform === 'win32' ? workspace.toLowerCase() : workspace);
      db.exec('BEGIN IMMEDIATE');
      let key;
      try {
        const mapped = db.prepare('SELECT scope_id FROM workspace_paths WHERE path_key=?').get(pathKey);
        if (workspaceId) {
          if (!db.prepare('SELECT id FROM workspaces WHERE id=?').get(workspaceId)) throw new AgentBaseError('scope_missing', '指定的工作区身份不存在');
          if (mapped && mapped.scope_id !== workspaceId) throw new AgentBaseError('scope_conflict', '此路径已属于另一工作区');
          key = workspaceId;
        } else {
          key = mapped?.scope_id || randomUUID();
          if (!mapped) db.prepare('INSERT INTO workspaces(id,path_key) VALUES(?,?)').run(key, pathKey);
        }
        if (previousWorkspace) {
          const oldRoot = resolve(previousWorkspace);
          const oldKey = fingerprint(process.platform === 'win32' ? oldRoot.toLowerCase() : oldRoot);
          const old = db.prepare('SELECT scope_id FROM workspace_paths WHERE path_key=?').get(oldKey);
          if (old?.scope_id !== key) throw new AgentBaseError('scope_conflict', '旧路径与工作区身份不匹配');
          db.prepare('UPDATE workspace_paths SET root_path=? WHERE path_key=?').run(oldRoot, oldKey);
        }
        db.prepare('INSERT INTO workspace_paths VALUES(?,?,?) ON CONFLICT(path_key) DO UPDATE SET root_path=excluded.root_path')
          .run(pathKey, key, workspace);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return Object.assign(new this(), { db, key, workspace, backup, recoverLock, closed: false });
    } catch (error) { db.close(); throw error; }
  }

  static readState(db, key) {
    const state = { revision: db.prepare('SELECT revision FROM workspaces WHERE id=?').get(key).revision };
    for (const name of collections) {
      state[name] = Object.fromEntries(db.prepare(`SELECT id,version,payload FROM ${name} WHERE scope_id=?`).all(key)
        .map(row => [row.id, { ...JSON.parse(row.payload), _revision: row.version }]));
    }
    for (const plan of Object.values(state.workflows)) {
      plan.steps = db.prepare('SELECT payload FROM workflow_steps WHERE scope_id=? AND workflow_id=? ORDER BY ordinal')
        .all(key, plan.id).map(row => JSON.parse(row.payload));
    }
    return state;
  }

  static writeRow(db, key, name, id, item, version) {
    const { _revision, ...payload } = item;
    if (name === 'workflows') delete payload.steps;
    db.prepare(`INSERT INTO ${name} VALUES(?,?,?,?,?) ON CONFLICT(scope_id,id) DO UPDATE SET
      version=excluded.version,status=excluded.status,payload=excluded.payload`)
      .run(key, id, version, item.status || '', JSON.stringify(payload));
    if (name === 'workflows') {
      db.prepare('DELETE FROM workflow_steps WHERE scope_id=? AND workflow_id=?').run(key, id);
      for (const [ordinal, step] of (item.steps || []).entries()) {
        db.prepare('INSERT INTO workflow_steps VALUES(?,?,?,?,?)').run(key, id, step.id, ordinal, JSON.stringify(step));
      }
    }
    db.prepare('INSERT INTO state_events(scope_id,entity,entity_id,version,action,created_at) VALUES(?,?,?,?,?,?)')
      .run(key, name, id, version, 'upsert', Date.now());
    item._revision = version;
  }

  snapshot() { return PlatformStore.readState(this.db, this.key); }

  resolvePath(path) {
    if (typeof path !== 'string' || !path) throw new AgentBaseError('invalid_source', '来源路径需要非空文本', { knownOutcome: true });
    if (!isAbsolute(path) || within(this.workspace, path)) return path;
    const roots = this.db.prepare("SELECT root_path FROM workspace_paths WHERE scope_id=? AND root_path<>'' ORDER BY length(root_path) DESC").all(this.key);
    const alias = roots.find(row => within(row.root_path, path));
    return alias ? resolve(this.workspace, relative(alias.root_path, path)) : path;
  }

  knownPaths(path) {
    const part = relative(this.workspace, path);
    return this.db.prepare("SELECT root_path FROM workspace_paths WHERE scope_id=? AND root_path<>''").all(this.key)
      .map(row => resolve(row.root_path, part));
  }

  backupTo(file) {
    this.db.prepare('VACUUM INTO ?').run(resolve(file));
    return { path: resolve(file), schemaVersion: 1 };
  }

  health() {
    return { schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      quickCheck: this.db.prepare('PRAGMA quick_check').all(), foreignKeyErrors: this.db.prepare('PRAGMA foreign_key_check').all(),
      synchronous: this.db.prepare('PRAGMA synchronous').get().synchronous, scopeId: this.key };
  }

  get(name, id) {
    if (!collections.includes(name)) throw new TypeError('Unknown collection');
    if (!id) return undefined;
    const row = this.db.prepare(`SELECT payload,version FROM ${name} WHERE scope_id=? AND id=?`).get(this.key, id);
    if (!row) return undefined;
    const item = { ...JSON.parse(row.payload), _revision: row.version };
    if (name === 'workflows') item.steps = this.db.prepare('SELECT payload FROM workflow_steps WHERE scope_id=? AND workflow_id=? ORDER BY ordinal')
      .all(this.key, id).map(row => JSON.parse(row.payload));
    return item;
  }

  list(name, { status, limit = 100, offset = 0 } = {}) {
    if (!collections.includes(name)) throw new TypeError('Unknown collection');
    limit = Math.max(1, Math.min(1000, Math.trunc(limit) || 100));
    offset = Math.max(0, Math.trunc(offset) || 0);
    const rows = status === undefined
      ? this.db.prepare(`SELECT id FROM ${name} WHERE scope_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(this.key, limit, offset)
      : this.db.prepare(`SELECT id FROM ${name} WHERE scope_id=? AND status=? ORDER BY rowid DESC LIMIT ? OFFSET ?`).all(this.key, status, limit, offset);
    return rows.map(row => this.get(name, row.id));
  }

  transaction(change) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = change();
      if (result instanceof Promise) throw new TypeError('Platform transactions must be synchronous');
      this.db.prepare('UPDATE workspaces SET revision=revision+1 WHERE id=?').run(this.key);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  update(change, expectedRevision) {
    return this.transaction(() => {
      const { revision, ...before } = this.snapshot();
      if (expectedRevision !== undefined && revision !== expectedRevision) throw new AgentBaseError('version_conflict', '状态已更新，请重新读取');
      const state = structuredClone(before);
      const result = change(state);
      if (result instanceof Promise) throw new TypeError('Platform transactions must be synchronous');
      for (const name of collections) {
        for (const id of Object.keys(before[name])) if (!state[name][id]) {
          this.db.prepare(`DELETE FROM ${name} WHERE scope_id=? AND id=?`).run(this.key, id);
        }
        for (const [id, item] of Object.entries(state[name])) {
          if (!before[name][id] || fingerprint(item) !== fingerprint(before[name][id])) {
            PlatformStore.writeRow(this.db, this.key, name, id, item, (before[name][id]?._revision || 0) + 1);
          }
        }
      }
      return result;
    });
  }

  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
