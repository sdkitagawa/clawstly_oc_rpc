// `clawstly-oc-rpc help` and `help <command>`. Both render from the command
// table in commands.js so help never drifts from dispatch or completion.

import { c } from './ui.js';
import { VERSION } from './version.js';
import { GROUPS, ALIAS_HINT, findCommand, visibleCommands } from './commands.js';

export const BRAND = 'Clawstly OpenCode RPC';
export const CLI = 'clawstly-oc-rpc';

const GROUP_STYLE = {
  start:  [c.green,   '▸'],
  stats:  [c.cyan,    '▤'],
  daemon: [c.green,   '●'],
  config: [c.yellow,  '◐'],
  fix:    [c.red,     '✚'],
  other:  [c.blue,    '·'],
};

const width = () => Math.max(60, Math.min(process.stdout.columns || 100, 110));

function wrap(text, w, pad) {
  if (w < 20 || text.length <= w) return text;
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && line.length + 1 + word.length > w) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.join(`\n${' '.repeat(pad)}`);
}

function banner() {
  return `\n  ${c.bold}${c.magenta}◆ ${BRAND}${c.reset}  ${c.dim}Discord Rich Presence for OpenCode${c.reset}  ${c.gray}v${VERSION}${c.reset}\n`;
}

export function renderHelp() {
  const cmds = visibleCommands();
  const MAX = 28;
  const label = (cmd) => {
    const full = cmd.name + (cmd.usage ? ` ${cmd.usage}` : '');
    return full.length > MAX ? cmd.name : full;
  };
  const colW = cmds.reduce((max, cmd) => Math.max(max, label(cmd).length), 0);
  const descW = width() - colW - 8;
  const lines = [banner()];

  lines.push(`  ${c.dim}Usage:${c.reset} ${c.bold}${CLI}${c.reset} ${c.cyan}<command>${c.reset} ${c.dim}[options]${c.reset}\n`);

  for (const [key, title] of GROUPS) {
    const [color, icon] = GROUP_STYLE[key] || [c.cyan, '·'];
    const inGroup = cmds.filter((cmd) => cmd.group === key);
    if (!inGroup.length) continue;
    lines.push(`  ${color}${icon}${c.reset} ${c.bold}${title}${c.reset}`);
    for (const cmd of inGroup) {
      const shown = label(cmd);
      const usage = shown !== cmd.name ? `${c.dim}${cmd.usage}${c.reset}` : '';
      const head = `${c.cyan}${c.bold}${cmd.name}${c.reset}${usage ? ` ${usage}` : ''}`;
      const pad = ' '.repeat(Math.max(1, colW - shown.length + 2));
      lines.push(`    ${head}${pad}${wrap(cmd.summary, descW, colW + 6)}`);
    }
    lines.push('');
  }

  const tips = [
    ['one command in detail', `${CLI} help <command>`],
    ['tab completion', `${CLI} __complete <words>`],
    ['something off?', `${CLI} doctor`],
    ['config file', `${CLI} config get`],
  ];
  const tipW = tips.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of tips) {
    lines.push(`  ${c.gray}${key.padEnd(tipW)}${c.reset}  ${c.cyan}${value}${c.reset}`);
  }
  lines.push('');
  lines.push(`  ${c.gray}--version · --help · exit codes: 0 ok · 1 usage error · 2 system error${c.reset}`);
  lines.push('');
  return lines.join('\n');
}

export function renderCommandHelp(name) {
  const cmd = findCommand(name);
  if (!cmd) return null;
  const lines = [''];
  const viaAlias = cmd.name !== name
    ? `  ${c.dim}(\`${name}\` still works — it's \`${CLI} ${ALIAS_HINT[name] || cmd.name}\` now)${c.reset}`
    : '';
  lines.push(`  ${c.bold}${c.magenta}◆ ${CLI} ${cmd.name}${c.reset}${viaAlias}`);
  lines.push(`    ${cmd.summary}`);
  lines.push('');
  lines.push(`  ${c.dim}Usage${c.reset}`);
  lines.push(`    ${c.bold}${CLI}${c.reset} ${c.cyan}${cmd.name}${c.reset}${cmd.usage ? ` ${cmd.usage}` : ''}${cmd.flags?.length ? ` ${c.dim}[options]${c.reset}` : ''}`);
  lines.push('');

  const table = (title, rows) => {
    if (!rows.length) return;
    const w = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
    lines.push(`  ${c.dim}${title}${c.reset}`);
    for (const [key, description] of rows) lines.push(`    ${c.cyan}${key.padEnd(w)}${c.reset}  ${description}`);
    lines.push('');
  };
  table('Choices', (cmd.subs || []).map(([sub, description]) => [sub, description]));
  table('Options', (cmd.flags || []).map(([flag, description, value]) => {
    const suffix = Array.isArray(value) ? ` <${value.join('|')}>` : value ? ' <value>' : '';
    return [flag + suffix, description];
  }));
  if (cmd.examples?.length) {
    lines.push(`  ${c.dim}Examples${c.reset}`);
    for (const example of cmd.examples) lines.push(`    ${c.gray}$ ${c.reset}${example}`);
    lines.push('');
  }
  if (cmd.aliases?.length) {
    lines.push(`  ${c.gray}also answers to: ${cmd.aliases.join(', ')}${c.reset}`);
    lines.push('');
  }
  return lines.join('\n');
}
