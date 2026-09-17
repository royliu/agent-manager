import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { bold, cyan, dim } from './format.js';

let rl: readline.Interface | undefined;

function iface(): readline.Interface {
  rl ??= readline.createInterface({ input: stdin, output: stdout });
  return rl;
}

export function closePrompts(): void {
  rl?.close();
  rl = undefined;
}

export function isInteractive(): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

export async function ask(question: string, fallback?: string): Promise<string> {
  const suffix = fallback ? dim(` (${fallback})`) : '';
  const answer = (await iface().question(`${cyan('?')} ${question}${suffix} `)).trim();
  return answer.length > 0 ? answer : (fallback ?? '');
}

/**
 * Ask for a secret without echoing it, so an API key never lands in the scrollback. Reads the raw
 * terminal itself rather than muting readline, whose echo hook is not public.
 */
export async function askSecret(question: string): Promise<string> {
  closePrompts();
  stdout.write(`${cyan('?')} ${question} `);
  return new Promise((resolve) => {
    let value = '';
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
    };
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (text.startsWith('\u001b')) return; // arrow keys and other escape sequences
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C: raw mode swallows the signal, so leave the way the terminal would have.
          finish();
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch === '\u0015') value = ''; // Ctrl-U
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = (await iface().question(`${cyan('?')} ${question} ${dim(`(${hint})`)} `))
    .trim()
    .toLowerCase();
  if (answer === '') return defaultYes;
  return answer.startsWith('y');
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: string;
}

export async function select<T>(question: string, choices: Choice<T>[]): Promise<T> {
  console.log(`${cyan('?')} ${question}`);
  choices.forEach((c, i) => {
    const n = dim(`${String(i + 1)})`);
    const label = c.disabled ? dim(c.label) : bold(c.label);
    const hint = c.disabled ? dim(` — ${c.disabled}`) : c.hint ? dim(` — ${c.hint}`) : '';
    console.log(`  ${n} ${label}${hint}`);
  });

  for (;;) {
    const answer = (await iface().question(`${dim('  choose')} `)).trim();
    const index = Number.parseInt(answer, 10) - 1;
    const chosen = choices[index];
    if (chosen && !chosen.disabled) return chosen.value;
    console.log(dim('  Please pick one of the numbered, available options.'));
  }
}
