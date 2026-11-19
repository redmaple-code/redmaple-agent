import { realpath, access } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { AgentBaseError, textResult } from './shared.js';

export async function scopedPath(workspace, path) {
  const root = await realpath(workspace);
  const requested = resolve(root, path || '.');
  let ancestor = requested;
  let canonical;
  while (!canonical) {
    try { canonical = await realpath(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  const target = resolve(canonical, relative(ancestor, requested));
  const location = relative(root, target);
  if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
    throw new AgentBaseError('outside_workspace', '路径超出已授权工作区', { knownOutcome: true });
  }
  return target;
}

export async function authorizeTool(policy, workspace, definition, args, context, { readRoots = [] } = {}) {
  const name = definition.name;
  if (policy?.profile === 'trusted') return;
  const readonly = ['read', 'grep', 'find', 'ls', 'tool_search'].includes(name) || definition.annotations?.readOnlyHint
    || ['redmaple_knowledge', 'redmaple_evolution'].includes(name) && ['search', 'list'].includes(args.action);
  if (policy?.profile === 'read-only' && !readonly) {
    throw new AgentBaseError('permission_denied', '当前权限配置只允许读取', { knownOutcome: true });
  }
  if (['read', 'grep', 'find', 'ls', 'write', 'edit'].includes(name)) {
    try { await scopedPath(workspace, args.path || '.'); }
    catch (error) {
      if (error.code !== 'outside_workspace' || name !== 'read') throw error;
      const target = resolve(workspace, args.path || '.');
      let registeredResource = false;
      for (const root of readRoots) {
        try { await scopedPath(root, target); registeredResource = true; break; }
        catch (resourceError) {
          if (!['outside_workspace', 'ENOENT'].includes(resourceError.code)) throw resourceError;
        }
      }
      if (!registeredResource) throw error;
    }
    if (policy?.profile !== 'ask') return;
  }
  if (readonly || ['codemode', 'redmaple_memory', 'redmaple_plan', 'redmaple_delegate', 'redmaple_propose', 'redmaple_decision', 'redmaple_evolution'].includes(name)) return;
  if ((policy?.allowTools || []).includes(name)) return;
  if (policy?.profile === 'sandbox' && ['bash', 'powershell', 'sandbox_exec'].includes(name)) return;
  const description = `${name}\n${JSON.stringify(args).slice(0, 3000)}`;
  const approved = context?.hasUI && await context.ui.confirm('红枫权限确认', description);
  if (!approved) throw new AgentBaseError('permission_required', `操作需要明确授权：${name}`, { knownOutcome: true });
}

export function sandboxTimeout(seconds, remainingMs = Infinity) {
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2147483647)) {
    throw new AgentBaseError('invalid_timeout', '超时必须为正数秒且不超过计时器上限', { knownOutcome: true });
  }
  if (remainingMs <= 0) throw new AgentBaseError('time_exhausted', '运行时间预算已耗尽', { knownOutcome: true });
  return Math.min(seconds === undefined ? 60000 : seconds * 1000, remainingMs);
}

export async function executeSandbox({ workspace, command, image, shell = 'sh', signal, timeout = 60000, onUpdate }) {
  if (!image) throw new AgentBaseError('sandbox_image_required', '请配置已经安装的 Docker 沙箱镜像', { knownOutcome: true });
  await access(workspace);
  const docker = args => promisify(execFile)('docker', args, { windowsHide: true, timeout: 30000 });
  await docker(['image', 'inspect', image]).catch(() => {
    throw new AgentBaseError('sandbox_unavailable', 'Docker 或指定镜像不可用', { knownOutcome: true });
  });
  const cancelled = () => ({ ...textResult('', { exitCode: null, cancelled: true, isolation: 'docker' }), isError: true });
  if (signal?.aborted) return cancelled();
  const name = `redmaple-${randomUUID()}`;
  const invocation = shell === 'powershell' ? ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['sh', '-lc', command];
  try {
    // The container exists before cancellation can remove it. This fences aborts during startup.
    await docker(['create', '--rm', '--name', name, '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
      '--mount', `type=bind,src=${resolve(workspace)},dst=/workspace`, '--workdir', '/workspace', image,
      ...invocation]);
    if (signal?.aborted) return cancelled();
    return await new Promise((done, reject) => {
      const child = spawn('docker', ['start', '--attach', name], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const collect = chunk => {
        const text = chunk.toString();
        output = (output + text).slice(-32000);
        onUpdate?.(textResult(text.slice(-16000), { partial: true }));
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const stop = () => { void docker(['rm', '-f', name]).catch(() => child.kill()); };
      signal?.addEventListener('abort', stop, { once: true });
      if (signal?.aborted) stop();
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', code => {
        cleanup();
        const result = textResult(output, { exitCode: code, timedOut, cancelled: Boolean(signal?.aborted), isolation: 'docker', timeoutMs: timeout });
        result.isError = code !== 0 || timedOut || Boolean(signal?.aborted);
        done(result);
      });
    });
  } finally { await docker(['rm', '-f', name]).catch(() => {}); }
}
