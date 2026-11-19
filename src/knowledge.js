import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { AgentBaseError, fingerprint } from './shared.js';
import { scopedPath } from './permissions.js';
import { PlatformStore } from './platform-store.js';

export function searchTerms(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase();
  const terms = new Set(normalized.match(/[\p{L}\p{N}_-]+/gu) || []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    const characters = Array.from(run);
    for (let index = 0; index < characters.length; index++) {
      terms.add(characters[index]);
      if (index + 1 < characters.length) terms.add(characters[index] + characters[index + 1]);
    }
  }
  return [...terms];
}

function splitText(text, size) {
  const chunks = [];
  let content = '', start = 1, end = 1, line = 1;
  for (const character of text) {
    if (content && content.length + character.length > size) {
      chunks.push({ content, start, end }); content = ''; start = line;
    }
    content += character;
    end = line;
    if (character === '\n') line += 1;
  }
  if (content) chunks.push({ content, start, end });
  return chunks;
}

export class KnowledgeStore {
  constructor(state, { maxSourceBytes = 4 * 1024 * 1024, chunkSize = 2000, aliases = {} } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize < 64) throw new TypeError('chunkSize must be at least 64');
    this.state = state;
    this.maxSourceBytes = maxSourceBytes;
    this.chunkSize = chunkSize;
    this.aliases = aliases;
  }

  list() { return this.state.db.prepare('SELECT * FROM sources WHERE scope_id=? ORDER BY path').all(this.state.key); }

  async importFile(path, { title } = {}) {
    const { db, key, workspace } = this.state;
    const canonical = await scopedPath(workspace, this.state.resolvePath(path));
    if ((await stat(canonical)).size > this.maxSourceBytes) throw new AgentBaseError('source_too_large', '来源超过配置的导入容量');
    const content = await readFile(canonical, 'utf8');
    if (content.includes('\0')) throw new AgentBaseError('unsupported_source', '请通过提取器导入二进制来源');
    const hash = fingerprint(content);
    const known = this.state.knownPaths(canonical);
    const prior = db.prepare(`SELECT * FROM sources WHERE scope_id=? AND path IN (${known.map(() => '?').join(',')})`)
      .get(key, ...known);
    const id = prior?.id || fingerprint({ scope: key, path: canonical });
    const revisionId = fingerprint({ id, hash, extractor: 'text/1', chunkSize: this.chunkSize });
    const parts = splitText(content, this.chunkSize);
    return this.state.transaction(() => {
      db.prepare(`INSERT INTO sources VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        path=excluded.path,title=excluded.title,status=excluded.status,current_revision=excluded.current_revision,version=sources.version+1`)
        .run(id, key, canonical, title || prior?.title || basename(canonical), 'active', revisionId, 1);
      db.prepare('INSERT OR IGNORE INTO source_revisions VALUES(?,?,?,?,?,?)').run(revisionId, id, hash, content, 'text/1', Date.now());
      this.invalidateMemories(id, revisionId);
      this.removeIndex(id);
      for (const [ordinal, part] of parts.entries()) {
        const chunkId = fingerprint({ revisionId, ordinal });
        db.prepare('INSERT OR IGNORE INTO chunks VALUES(?,?,?,?,?,?,?,?)')
          .run(chunkId, key, id, revisionId, ordinal, part.content, part.start, part.end);
        this.indexChunk({ id: chunkId, content: part.content });
      }
      return { id, path: canonical, revisionId, hash, chunks: parts.length,
        reference: { kind: 'knowledge', id, revisionId, hash } };
    });
  }

  removeIndex(sourceId) {
    const { db, key } = this.state;
    db.prepare('DELETE FROM chunks_fts WHERE scope_id=? AND chunk_id IN (SELECT id FROM chunks WHERE source_id=?)').run(key, sourceId);
    db.prepare('DELETE FROM chunk_terms WHERE scope_id=? AND chunk_id IN (SELECT id FROM chunks WHERE source_id=?)').run(key, sourceId);
  }

  indexChunk(chunk) {
    const { db, key } = this.state;
    db.prepare('INSERT INTO chunks_fts(chunk_id,scope_id,content) VALUES(?,?,?)').run(chunk.id, key, chunk.content.normalize('NFKC').toLowerCase());
    const insert = db.prepare('INSERT OR IGNORE INTO chunk_terms VALUES(?,?,?)');
    for (const term of searchTerms(chunk.content)) insert.run(key, term, chunk.id);
  }

  invalidateMemories(sourceId, revisionId) {
    const { db, key } = this.state;
    const rows = db.prepare(`SELECT id,version,payload FROM memories WHERE scope_id=? AND status='approved'
      AND EXISTS(SELECT 1 FROM json_each(json_extract(memories.payload,'$.sources')) AS ref
        WHERE json_extract(ref.value,'$.kind')='knowledge' AND json_extract(ref.value,'$.id')=?
        AND json_extract(ref.value,'$.revisionId')<>?)`).all(key, sourceId, revisionId || '');
    for (const row of rows) PlatformStore.writeRow(db, key, 'memories', row.id,
      { ...JSON.parse(row.payload), status: 'stale' }, row.version + 1);
  }

  async validateSource(reference) {
    const { db, key } = this.state;
    const source = db.prepare(`SELECT s.*,r.hash FROM sources s JOIN source_revisions r ON r.id=s.current_revision
      WHERE s.scope_id=? AND s.id=?`).get(key, reference.id);
    if (!source) throw new AgentBaseError('source_missing', '知识来源已删除');
    if (source.status !== 'active' || source.current_revision !== reference.revisionId || source.hash !== reference.hash) {
      throw new AgentBaseError('source_changed', '知识来源版本已变化');
    }
    const current = await this.state.source(source.path);
    if (current.hash !== source.hash) throw new AgentBaseError('source_changed', '原始资料已变化，请刷新索引');
    const after = db.prepare('SELECT version,status FROM sources WHERE scope_id=? AND id=?').get(key, source.id);
    if (after?.version !== source.version || after.status !== 'active') throw new AgentBaseError('source_changed', '校验期间来源已更新');
    return source;
  }

  async search(query, { limit = 8, offset = 0 } = {}) {
    if (typeof query !== 'string' || query.length > 500) throw new AgentBaseError('invalid_query', '检索词需要不超过500字符的文本');
    const original = searchTerms(query);
    const aliases = original.flatMap(term => this.aliases[term] || []).flatMap(searchTerms);
    const terms = [...new Set([...original, ...aliases])].slice(0, 512);
    if (!terms.length) return { items: [], total: 0, strategy: 'empty' };
    limit = Math.max(1, Math.min(50, Math.trunc(limit) || 8));
    offset = Math.max(0, Math.trunc(offset) || 0);
    const { db, key } = this.state;
    const capacity = Math.max(200, Math.min(10000, offset + limit * 10));
    const matches = db.prepare(`SELECT c.*,s.path,s.title,s.version,r.hash,COUNT(*) AS matches
      FROM chunk_terms t JOIN chunks c ON c.id=t.chunk_id JOIN sources s ON s.id=c.source_id
      JOIN source_revisions r ON r.id=c.revision_id
      WHERE t.scope_id=? AND t.term IN (${terms.map(() => '?').join(',')})
      AND s.scope_id=? AND s.status='active' AND s.current_revision=c.revision_id
      GROUP BY c.id ORDER BY matches DESC,c.id LIMIT ?`).all(key, ...terms, key, capacity);
    const phrase = `"${query.normalize('NFKC').toLowerCase().replaceAll('"', '""')}"`;
    const exact = db.prepare(`SELECT c.*,s.path,s.title,s.version,r.hash,100 AS matches
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN sources s ON s.id=c.source_id
      JOIN source_revisions r ON r.id=c.revision_id WHERE chunks_fts MATCH ? AND chunks_fts.scope_id=?
      AND s.scope_id=? AND s.status='active' AND s.current_revision=c.revision_id ORDER BY c.id LIMIT ?`)
      .all(phrase, key, key, capacity);
    const candidates = new Map(matches.map(row => [row.id, row]));
    for (const row of exact) candidates.set(row.id, row);
    const items = [];
    const checked = new Map();
    const normalized = query.normalize('NFKC').toLowerCase();
    for (const row of candidates.values()) {
      let valid = checked.get(row.source_id);
      if (valid === undefined) {
        try { await this.validateSource({ id: row.source_id, revisionId: row.revision_id, hash: row.hash }); valid = true; }
        catch (error) {
          if (!['source_changed', 'source_missing', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
          valid = false;
        }
        checked.set(row.source_id, valid);
      }
      if (valid) items.push({ id: row.id, sourceId: row.source_id, revisionId: row.revision_id, title: row.title,
        content: row.content, score: row.matches + (row.content.normalize('NFKC').toLowerCase().includes(normalized) ? 100 : 0),
        citation: { path: this.state.resolvePath(row.path), startLine: row.line_start, endLine: row.line_end, hash: row.hash, extractor: 'text/1' } });
    }
    const visible = items.filter(item => {
      const source = db.prepare('SELECT status,current_revision FROM sources WHERE scope_id=? AND id=?').get(key, item.sourceId);
      return source?.status === 'active' && source.current_revision === item.revisionId;
    });
    visible.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const truncated = matches.length === capacity || exact.length === capacity;
    return { items: visible.slice(offset, offset + limit), total: visible.length, offset, limit,
      hasMore: truncated || visible.length > offset + limit, truncated, totalIsExact: !truncated,
      strategy: 'fts5-trigram+unicode-terms' };
  }

  remove(id) {
    const { db, key } = this.state;
    return this.state.transaction(() => {
      this.removeIndex(id);
      this.invalidateMemories(id);
      const changed = db.prepare('DELETE FROM sources WHERE scope_id=? AND id=?').run(key, id).changes;
      return { removed: Boolean(changed) };
    });
  }

  async evaluate(cases, { limit = 8 } = {}) {
    if (!Array.isArray(cases) || !cases.length || cases.some(item => typeof item.query !== 'string'
      || !Array.isArray(item.expectedSourceIds))) throw new AgentBaseError('invalid_evaluation', '检索评估需要查询和人工标注的来源集合');
    const results = [];
    for (const item of cases) {
      const started = performance.now();
      const found = await this.search(item.query, { limit });
      const ids = found.items.map(hit => hit.sourceId);
      const expected = [...new Set(item.expectedSourceIds)];
      const relevant = expected.filter(id => ids.includes(id)).length;
      const rank = ids.findIndex(id => expected.includes(id));
      results.push({ query: item.query, expected, ids, recall: expected.length ? relevant / expected.length : null,
        reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1), falsePositive: !expected.length && ids.length > 0,
        elapsedMs: performance.now() - started, truncated: Boolean(found.truncated) });
    }
    const answerable = results.filter(item => item.expected.length);
    const empty = results.filter(item => !item.expected.length);
    return { cases: results, recallAtK: answerable.length ? answerable.reduce((sum, item) => sum + item.recall, 0) / answerable.length : null,
      mrr: answerable.length ? answerable.reduce((sum, item) => sum + item.reciprocalRank, 0) / answerable.length : null,
      noAnswerFalsePositiveRate: empty.length ? empty.filter(item => item.falsePositive).length / empty.length : null,
      limit, sourceScope: this.state.key };
  }

  rebuild() {
    const { db, key } = this.state;
    return this.state.transaction(() => {
      db.prepare('DELETE FROM chunks_fts WHERE scope_id=?').run(key);
      db.prepare('DELETE FROM chunk_terms WHERE scope_id=?').run(key);
      const chunks = db.prepare(`SELECT c.* FROM chunks c JOIN sources s ON s.id=c.source_id
        WHERE c.scope_id=? AND s.status='active' AND c.revision_id=s.current_revision`).all(key);
      for (const chunk of chunks) this.indexChunk(chunk);
      return { chunks: chunks.length };
    });
  }
}
