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
