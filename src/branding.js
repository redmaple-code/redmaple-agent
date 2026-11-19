import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const packageDirectory = fileURLToPath(new URL('../', import.meta.url));
export const themePaths = ['redmaple.json', 'redmaple-light.json'].map(name => fileURLToPath(new URL(`../themes/${name}`, import.meta.url)));
export const logoPath = fileURLToPath(new URL('../assets/redmaple.svg', import.meta.url));
const points = JSON.parse(readFileSync(new URL('../assets/maple-points.json', import.meta.url), 'utf8'));

function inside(x, y) {
  let hit = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = points[i];
    const [c, d] = points[j];
    if ((b > y) !== (d > y) && x < (c - a) * (y - b) / (d - b) + a) hit = !hit;
  }
  return hit;
}

export function renderMapleLogo(columns = 16, rows = 8) {
  return Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => {
    const x = (column + 0.5) * 256 / columns;
    const upper = inside(x, (row * 2 + 0.5) * 256 / (rows * 2));
    const lower = inside(x, (row * 2 + 1.5) * 256 / (rows * 2));
    return upper ? (lower ? '█' : '▀') : (lower ? '▄' : ' ');
  }).join(''));
}

export function brandingExtension(pi) {
  pi.on('session_start', async (_, context) => {
    if (context.mode !== 'tui') return;
    context.ui.setHeader((tui, theme) => ({
      invalidate() {},
      render(width) {
        const logo = renderMapleLogo();
        const labels = ['', theme.bold(theme.fg('accent', '红枫 Red Maple')), '',
          theme.fg('text', 'Agent 工作台'), '', theme.fg('muted', '/model  /login  /hotkeys'), '', ''];
        if (width < 48) return [theme.bold(theme.fg('accent', '红枫 Red Maple')), ''];
        return [...logo.map((line, index) => ` ${theme.fg('accent', line)}  ${labels[index]}`), ''];
      },
    }));
  });
}
