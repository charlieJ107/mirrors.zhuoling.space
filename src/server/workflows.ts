import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

/**
 * Stub workflow entrypoints for the four background job types
 * (docs/02-architecture.md §2.6). Real logic lands in later issues; these
 * exist so the Workflows bindings deploy and local emulation works.
 */

export interface IngestWorkflowParams {
  sourceId: string;
  fileList?: string[];
}

export interface VerifyWorkflowParams {
  sourceId: string;
}

export interface TierWorkflowParams {
  sourceId?: string;
}

export interface GcWorkflowParams {
  sourceId?: string;
}

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestWorkflowParams> {
  override async run(
    event: WorkflowEvent<IngestWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do("stub", async () => ({ received: event.payload }));
  }
}

export class VerifyWorkflow extends WorkflowEntrypoint<Env, VerifyWorkflowParams> {
  override async run(
    event: WorkflowEvent<VerifyWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do("stub", async () => ({ received: event.payload }));
  }
}

export class TierWorkflow extends WorkflowEntrypoint<Env, TierWorkflowParams> {
  override async run(
    event: WorkflowEvent<TierWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do("stub", async () => ({ received: event.payload }));
  }
}

export class GcWorkflow extends WorkflowEntrypoint<Env, GcWorkflowParams> {
  override async run(
    event: WorkflowEvent<GcWorkflowParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await step.do("stub", async () => ({ received: event.payload }));
  }
}
