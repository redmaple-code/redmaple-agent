const root = import.meta.resolve('@earendil-works/pi-coding-agent');
const modules = new Map();

// These internal adapters are isolated here and tested against the locked upstream release.
export function upstreamModule(path) {
  if (!modules.has(path)) modules.set(path, import(new URL(path, root).href));
  return modules.get(path);
}

export async function createNativeExtensions(sdk, agentDir, options = {}) {
  const { join } = await import('node:path');
  const { loadMcpConfig } = await upstreamModule('extensions/mcp/config.js');
  const { McpOAuthCredentialStore } = await upstreamModule('extensions/mcp/oauth.js');
  const { FileAuthStorageBackend } = await upstreamModule('core/auth-storage.js');
  const extensions = [sdk.createCodemodeExtension(options.codemode), sdk.createToolSearchExtension()];
  if (options.noMcp) return extensions;
  return [...extensions,
    sdk.createMcpExtension({
      ...options.mcp,
      loadConfig: options.mcp?.loadConfig || (context => loadMcpConfig({ agentDir, cwd: context.cwd, projectTrusted: context.isProjectTrusted() })),
      credentials: options.mcp?.credentials || new McpOAuthCredentialStore(
        new FileAuthStorageBackend(join(agentDir, 'mcp-auth.json')), join(agentDir, 'mcp-auth-locks')),
      logPath: join(agentDir, 'mcp.log'),
    })];
}
