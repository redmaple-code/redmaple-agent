import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute, sep } from 'node:path';
import { AgentBaseError, fingerprint, textResult } from './shared.js';

function metadata(text, file) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new AgentBaseError('skill_metadata', `Skill frontmatter is missing in ${file}`);
  const fields = {};
  let current;
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|description):\s*(.*)$/);
    if (field) {
      current = field[1];
      fields[current] = field[2].replace(/^['"]|['"]$/g, '').replace(/^[>|][-+]?$/, '');
    } else if (/^\s+\S/.test(line) && current === 'description') {
      fields.description += ` ${line.trim()}`;
    } else current = undefined;
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(fields.name || '') || !fields.description?.trim()) {
    throw new AgentBaseError('skill_metadata', `Skill needs a valid name and description in ${file}`);
  }
  return { name: fields.name, description: fields.description.trim() };
}

async function readText(path, maxCharacters) {
  if ((await stat(path)).size > maxCharacters * 4) throw new AgentBaseError('resource_too_large', path);
  const text = await readFile(path, 'utf8');
  if (text.length > maxCharacters || text.includes('\0')) throw new AgentBaseError('resource_too_large', path);
  return text;
}

export async function loadWorkspaceInstructions(workspace, cwd = workspace, maxCharacters = 64000) {
  const root = await realpath(resolve(workspace));
  let current = await realpath(resolve(cwd));
  const rel = relative(root, current);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AgentBaseError('outside_workspace', 'Instruction directory is outside workspace');
  const directories = [];
  while (true) {
    directories.unshift(current);
    if (current === root) break;
    current = dirname(current);
  }
  const sources = [];
  for (const directory of directories) {
    const path = join(directory, 'AGENTS.md');
    try {
      const content = await readText(path, maxCharacters);
      sources.push({ path, content, hash: fingerprint(content) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return sources;
}

export async function createResourcesPlugin({ workspace, cwd = workspace,
  skillDirectories = [join(workspace, '.agents', 'skills')], maxCharacters = 64000 }) {
  const skills = new Map();
  for (const directory of skillDirectories) {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const candidates = children.filter(child => child.isDirectory()).map(child => join(directory, child.name, 'SKILL.md'));
    if (children.some(child => child.name === 'SKILL.md' && child.isFile())) candidates.unshift(join(directory, 'SKILL.md'));
    for (const path of candidates.sort()) {
      let text;
      try { text = await readText(path, maxCharacters); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const data = metadata(text, path);
      if (skills.has(data.name)) throw new AgentBaseError('duplicate_skill', data.name);
      skills.set(data.name, { ...data, directory: await realpath(dirname(path)), hash: fingerprint(text) });
    }
  }
  const instructions = await loadWorkspaceInstructions(workspace, cwd, maxCharacters);
  const catalog = [...skills.values()].map(({ name, description }) => ({ name, description }));
  const prompt = [
    ...instructions.map(source => `Workspace instructions from ${source.path}\n${source.content}`),
    skills.size ? `Available skills. Load the relevant skill before using it.\n${JSON.stringify(catalog)}` : '',
  ].filter(Boolean).join('\n\n');
  return { id: 'workspace-resources', version: fingerprint({ skills: [...skills.values()], instructions }),
    systemPrompt: prompt, resources: { instructions: instructions.map(({ path, hash }) => ({ path, hash })), skills: catalog },
    tools: skills.size ? [{ name: 'load_skill', label: 'Load skill resource', replay: 'safe', version: '1',
      description: 'Read a named skill SKILL.md or a UTF-8 supporting file relative to its directory.',
      parameters: { type: 'object', properties: { name: { type: 'string' }, file: { type: 'string', maxLength: 2000 } },
        required: ['name'], additionalProperties: false },
      execute: async (_, { name, file = 'SKILL.md' }) => {
        const skill = skills.get(name);
        if (!skill) throw new AgentBaseError('unknown_skill', name);
        const path = await realpath(resolve(skill.directory, file));
        const rel = relative(skill.directory, path);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AgentBaseError('outside_skill', 'Resource is outside skill directory');
        const text = await readText(path, maxCharacters);
        if (file === 'SKILL.md' && fingerprint(text) !== skill.hash) {
          throw new AgentBaseError('resource_changed', 'Skill changed. Reload the session resources');
        }
        return textResult(text, { name, path, hash: fingerprint(text) });
      } }] : [] };
}
