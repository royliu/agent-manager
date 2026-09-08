import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export async function which(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('which', [bin]);
    const p = stdout.trim();
    return p.length > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Version strings are inconsistent across tools ("2.1.226 (Claude Code)",
 * "codex-cli 0.146.0"), so pull out the version number itself when we can find
 * one and fall back to the raw first line otherwise.
 */
export async function tryVersion(bin: string, args = ['--version']): Promise<string | undefined> {
  try {
    const { stdout } = await pexec(bin, args, { timeout: 5000 });
    const line = stdout.trim().split('\n')[0] ?? '';
    return /\d+\.\d+(\.\d+)?/.exec(line)?.[0] ?? (line || undefined);
  } catch {
    return undefined;
  }
}

export function readJsonFile<T = unknown>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Decode a JWT payload without verifying — we only read non-secret claims. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Recursively collect files matching a predicate, newest-first, bounded. */
export function collectFiles(
  root: string,
  match: (name: string) => boolean,
  opts: { maxFiles?: number; newerThan?: number } = {},
): string[] {
  const { maxFiles = 4000, newerThan } = opts;
  const out: { file: string; mtime: number }[] = [];
  const stack = [root];

  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && match(e.name)) {
        try {
          const st = fs.statSync(full);
          if (newerThan !== undefined && st.mtimeMs < newerThan) continue;
          out.push({ file: full, mtime: st.mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).map((o) => o.file);
}

/** Read a file's last N lines without loading the whole thing. */
export function readTail(file: string, maxBytes = 512 * 1024): string {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
