import { appendFileSync } from 'node:fs';

let reported = false;

export function runtimeTrace(stage, ids = {}) {
  const path = process.env.REDMAPLE_TRACE_FILE;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), uptimeMs: Math.round(process.uptime() * 1000),
      stage, rssBytes: process.memoryUsage().rss, cpu: process.cpuUsage(),
      sessionId: ids.sessionId, runId: ids.runId, callKey: ids.callKey })}\n`, { mode: 0o600 });
  } catch {
    if (!reported) process.stderr.write('redmaple_trace_unavailable\n');
    reported = true;
  }
}
