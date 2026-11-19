import { readFile, writeFile, mkdir, realpath, stat, rename, unlink, link } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { AgentBaseError, checkSignal, textResult } from './shared.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const objectSchema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const pathField = { type: 'string', minLength: 1, maxLength: 2000 };

function utf8Text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AgentBaseError('invalid_encoding', 'File must contain valid UTF-8 text', { knownOutcome: true }); }
}

async function workspacePath(root, input) {
  const target = resolve(root, input);
  let existing = target;
  let canonical;
  while (true) {
    try { canonical = await realpath(existing); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  for (const path of [target, canonical]) {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
      throw new AgentBaseError('outside_workspace', 'File path is outside the configured workspace', { knownOutcome: true });
    }
  }
  return resolve(canonical, relative(existing, target));
}

async function currentFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(path, content, expectedHash, signal, expectedBytes) {
  const before = await currentFile(path);
  if (expectedHash !== undefined && (before ? hash(before) : '') !== expectedHash) {
    throw new AgentBaseError('file_conflict', 'File changed. Read it and use its current hash', { knownOutcome: true });
  }
  if (expectedBytes && !before?.equals(expectedBytes)) throw new AgentBaseError('file_conflict', 'File changed during edit', { knownOutcome: true });
  checkSignal(signal);
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.agent-write-${randomUUID()}.tmp`);
  try {
    const mode = before ? (await stat(path)).mode & 0o777 : 0o666;
    await writeFile(temporary, content, { flag: 'wx', mode });
    const current = await currentFile(path);
    if (before ? !current?.equals(before) : current !== null) {
      throw new AgentBaseError('file_conflict', 'File changed during write', { knownOutcome: true });
    }
    checkSignal(signal);
    if (before) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return textResult('File saved', { path, sha256: hash(Buffer.from(content)), characters: content.length });
}

function terminate(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
  }
}

async function execute(program, args, cwd, timeoutMs, cap, signal, update) {
  checkSignal(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(program, args, { cwd, shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let truncated = false;
    let timedOut = false;
    const append = bytes => {
      const text = bytes.toString('utf8');
      output += text;
      if (output.length > cap) {
        truncated = true;
        output = output.slice(0, Math.floor(cap / 2)) + output.slice(-Math.ceil(cap / 2));
      }
      update?.(textResult(text.slice(0, cap), { partial: true }));
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const abort = () => terminate(child);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    child.on('error', error => { cleanup(); error.knownOutcome = true; reject(error); });
    child.on('close', (exitCode, exitSignal) => {
      cleanup();
      if (signal?.aborted) return reject(new AgentBaseError('cancelled', 'Command cancelled'));
      const status = [timedOut ? 'Command timed out' : `Command exited with code ${exitCode}${exitSignal ? ` (${exitSignal})` : ''}`,
        truncated ? 'Output truncated: middle content omitted' : ''].filter(Boolean).join('\n');
      const result = textResult(`${output || '(no output)'}\n\n[${status}]`, { exitCode, exitSignal, truncated, timedOut });
      result.isError = timedOut || exitCode !== 0;
      resolveResult(result);
    });
  });
}

export async function createWorkspaceTools({ workspace, outputCap = 16000, timeoutMs = 60000 }) {
  const root = await realpath(resolve(workspace));
  const maximumFileBytes = 2 * 1024 * 1024;
  const tools = [
    { name: 'read', label: 'Read file', version: '1', replay: 'safe',
      description: 'Read UTF-8 text in the workspace. Reports partial reads and continuation offsets.',
      parameters: objectSchema({ path: pathField, offset: { type: 'integer', minimum: 0 },
        lines: { type: 'integer', minimum: 1, maximum: 1000 } }, ['path']),
      execute: async (_, { path, offset = 0, lines = 200 }, signal) => {
        const target = await workspacePath(root, path);
        if ((await stat(target)).size > maximumFileBytes) throw new AgentBaseError('file_too_large', 'Read a smaller source file');
        const bytes = await readFile(target);
        checkSignal(signal);
        if (bytes.length > maximumFileBytes) throw new AgentBaseError('file_too_large', 'Read a smaller source file');
        if (bytes.includes(0)) throw new AgentBaseError('binary_file', 'Use an attachment tool for binary files');
        const all = utf8Text(bytes).split('\n');
        const text = all.slice(offset, offset + lines).join('\n');
        const visible = text.slice(0, outputCap);
        const truncated = text.length > outputCap || offset + lines < all.length;
        const next = text.length > outputCap ? offset + visible.split('\n').length - 1 : offset + lines;
        const notice = truncated ? `\n\n[Partial file content: ${all.length} total lines. Continue with offset=${next}. ${text.length > outputCap ? 'The last displayed line may be incomplete; use exec for a narrower extraction if a single line exceeds the output limit.' : ''}]` : '';
        return textResult(visible + notice, { path, sha256: hash(bytes), totalLines: all.length,
          offset, truncated });
      } },
    { name: 'write', label: 'Write file', version: '1', executionMode: 'sequential',
      description: 'Create or replace UTF-8 text. No file hash is required.',
      parameters: objectSchema({ path: pathField, content: { type: 'string', maxLength: maximumFileBytes },
        expected_hash: { type: 'string', maxLength: 64, description: 'Optional legacy revision check. Normally omit.' } }, ['path', 'content']),
      execute: async (_, args, signal) => atomicWrite(await workspacePath(root, args.path), args.content, args.expected_hash, signal) },
    { name: 'edit', label: 'Edit file', version: '1', executionMode: 'sequential',
      description: 'Replace one exact text occurrence. The original text must match uniquely. No file hash is required.',
      parameters: objectSchema({ path: pathField, old_text: { type: 'string', minLength: 1, maxLength: maximumFileBytes },
        new_text: { type: 'string', maxLength: maximumFileBytes }, expected_hash: { type: 'string', minLength: 64, maxLength: 64, description: 'Optional legacy revision check. Normally omit.' } },
      ['path', 'old_text', 'new_text']),
      execute: async (_, args, signal) => {
        const target = await workspacePath(root, args.path);
        if ((await stat(target)).size > maximumFileBytes) {
          throw new AgentBaseError('file_too_large', 'Edit a smaller source file', { knownOutcome: true });
        }
        const bytes = await readFile(target);
        const content = utf8Text(bytes);
        if (content.split(args.old_text).length !== 2) {
          throw new AgentBaseError('ambiguous_edit', 'old_text must match exactly once', { knownOutcome: true });
        }
        return atomicWrite(target, content.replace(args.old_text, () => args.new_text), args.expected_hash, signal, bytes);
      } },
    { name: 'exec', label: 'Execute program', version: '1', executionMode: 'sequential',
      description: 'Execute a program and argument array in the workspace. Use a shell program explicitly when needed. Supports timeout and streamed output.',
      parameters: objectSchema({ program: { type: 'string', minLength: 1, maxLength: 2000 },
        args: { type: 'array', items: { type: 'string' }, maxItems: 200 }, cwd: pathField,
        timeout_ms: { type: 'integer', minimum: 1, maximum: timeoutMs } }, ['program']),
      execute: async (_, { program, args = [], cwd = '.', timeout_ms = timeoutMs }, signal, update) =>
        execute(program, args, await workspacePath(root, cwd), timeout_ms, outputCap, signal, update) },
  ];
  // Preserve stored session identities while accepting the previous optional hash contract.
  const descriptions = {
    read: 'Read UTF-8 text in the workspace and return its SHA-256 for conditional edits.',
    write: 'Create or replace UTF-8 text. expected_hash must match read.sha256, or be empty for a new file.',
    edit: 'Replace one exact text occurrence, checking the current file SHA-256.',
  };
  for (const tool of tools) {
    if (!descriptions[tool.name]) continue;
    const parameters = structuredClone(tool.parameters);
    if (parameters.properties.expected_hash) {
      delete parameters.properties.expected_hash.description;
      parameters.required.push('expected_hash');
    }
    tool.sessionIdentity = { description: descriptions[tool.name], parameters };
  }
  return tools;
}
