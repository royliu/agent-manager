import { spawn } from 'node:child_process';

/** Desktop notification when something needs the owner. Best effort, never throws. */
export function notifyDesktop(title: string, text: string): void {
  if (process.platform !== 'darwin') return;
  try {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const child = spawn('osascript', ['-e', `display notification "${esc(text)}" with title "${esc(title)}"`], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    /* ignore */
  }
}
