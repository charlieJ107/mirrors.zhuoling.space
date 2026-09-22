/**
 * Vitest stub for the workerd-only `cloudflare:workers` module (aliased in
 * vitest.config.ts). TypeScript proper resolves the real types from
 * @cloudflare/workers-types; this only exists so tests importing the worker
 * entry can run under Node.
 */

export interface WorkflowEvent<T = unknown> {
  payload: T;
}

export type WorkflowStep = unknown;

export class WorkflowEntrypoint<Env = unknown, Payload = unknown> {
  env!: Env;

  async run(event: WorkflowEvent<Payload>, step: WorkflowStep): Promise<void> {
    void event;
    void step;
  }
}
