import { spawn } from 'node:child_process';
import type { LaunchSpec } from '../providers/types.js';

/**
 * Run a launch spec with the terminal handed straight to the child, and exit
 * with whatever it exits with — `am run` should be transparent.
 */
export function runForeground(spec: LaunchSpec): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: spec.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) {
        // Re-raise so the parent's exit status reflects the signal.
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

/** Quote a value for safe inclusion in a POSIX shell command. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
