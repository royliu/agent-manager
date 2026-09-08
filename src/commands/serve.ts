import { TaskManagerService } from '../swarm/service.js';

/** Internal: the task manager process. Started by `am gm start` / `am board`, never by hand. */
export function serveCommand(swarm: string): void {
  const svc = new TaskManagerService(swarm);
  svc.listen();
}
