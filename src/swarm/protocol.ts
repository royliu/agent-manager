/** Newline-delimited JSON over the swarm's Unix socket. */
export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
export interface Response {
  id: number;
  result?: unknown;
  error?: { message: string; code?: string };
}
export interface Push {
  event: string;
  data?: unknown;
}
export type Wire = Response | Push;

export class RpcError extends Error {
  constructor(message: string, readonly code = 'error') {
    super(message);
  }
}
