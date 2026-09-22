/**
 * THROWAWAY spike code (issue #1, M0). Not product code.
 *
 * Bindings for the spike worker (see spikes/m0/wrangler.jsonc).
 * Declared locally so the spike never touches the product Env types.
 */
export interface SpikeEnv {
  BUCKET: R2Bucket;
  INGEST: Workflow;
}
