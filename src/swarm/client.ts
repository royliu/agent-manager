import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketDir, swarmPaths } from './paths.js';
import { RpcError, type Push, type Request, type Wire } from './protocol.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Path of the `am` entry point, so children run the same build we are. */
export function amEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/swarm/client.js → dist/cli.js
  return path.join(here, '..', 'cli.js');
}

export class TmClient {
  private sock?: net.Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(p: Push) => void>();
  private buffer = '';

  constructor(readonly swarm: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(swarmPaths(this.swarm).sock);
      s.setEncoding('utf8');
      s.once('connect', () => {
        this.sock = s;
        resolve();
      });
      s.on('error', (e) => {
        if (!this.sock) reject(e);
        else this.failAll(e);
      });
      s.on('close', () => {
        // Drop the dead socket so the next call fails fast instead of writing into the void.
        this.sock = undefined;
        this.failAll(new Error('task manager connection closed'));
      });
      s.on('data', (chunk: string) => this.onData(chunk));
    });
  }

  private failAll(e: Error): void {
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Wire;
      try {
        msg = JSON.parse(line) as Wire;
      } catch {
        continue;
      }
      if ('event' in msg) {
        for (const l of this.listeners) l(msg);
      } else {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code));
        else p.resolve(msg.result);
      }
    }
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.sock || this.sock.destroyed) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    const req: Request = { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
      this.sock!.write(JSON.stringify(req) + '\n');
    });
  }

  onPush(fn: (p: Push) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.sock?.end();
    this.sock?.destroy();
    this.sock = undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pid in the pid file, only if that process really is this swarm's task manager. */
export function servicePid(swarm: string): number | undefined {
  const p = swarmPaths(swarm);
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(p.pid, 'utf8'), 10);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(pid) || !pidAlive(pid)) return undefined;
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    // Task managers started before 0.7.0 run as `tm-serve --swarm <name>`.
    if (!/tm-serve|_serve/.test(cmd) || !new RegExp(`--(swarm|gm) ${swarm}(\\s|$)`).test(cmd)) return undefined; // pid was reused
  } catch {
    return undefined;
  }
  return pid;
}

export function serviceRunning(swarm: string): boolean {
  return servicePid(swarm) !== undefined;
}

async function reachable(swarm: string): Promise<boolean> {
  if (!fs.existsSync(swarmPaths(swarm).sock)) return false;
  const c = new TmClient(swarm);
  try {
    await c.connect();
    await c.call('ping');
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

/** Start the task manager for a swarm in the background. Idempotent. */
export async function ensureService(swarm: string): Promise<void> {
  const p = swarmPaths(swarm);
  const pid = servicePid(swarm);
  if (pid !== undefined) {
    if (await reachable(swarm)) return;
    // Ours, alive, but not answering at the address we expect: replace it.
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* gone */
    }
    await sleep(300);
  }
  for (const f of [p.pid, p.sock]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* nothing stale */
    }
  }
  fs.mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(socketDir(), { recursive: true, mode: 0o700 });
  const log = fs.openSync(p.log, 'a');
  const child = spawn(process.execPath, [amEntry(), '_serve', '--gm', swarm], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i += 1) {
    if (await reachable(swarm)) return;
    await sleep(100);
  }
  throw new Error(`task manager for "${swarm}" did not start; see ${p.log}`);
}

/** Connect, starting the service if needed. */
export async function openClient(swarm: string): Promise<TmClient> {
  await ensureService(swarm);
  const c = new TmClient(swarm);
  await c.connect();
  return c;
}

export async function withClient<T>(swarm: string, fn: (c: TmClient) => Promise<T>): Promise<T> {
  const c = await openClient(swarm);
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}
