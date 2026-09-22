#!/usr/bin/env node
// THROWAWAY spike code (issue #1, M0). Not product code.
//
// Runs the four M0 validation scenarios end-to-end against local
// `wrangler dev` + the mock upstream. Usage:
//
//   node spikes/m0/driver/run-all.mjs
//
// Scenario definitions map to docs/05-milestones.md M0 items 1-4.

import { createHash } from "node:crypto";
import {
  SPIKE_DIR,
  UPSTREAM,
  WORKER,
  createMemorySampler,
  getJson,
  postJson,
  sleep,
  startUpstream,
  startWorker,
  waitFor,
  waitInstance,
  writeResult,
} from "./lib.mjs";

const MIB = 1024 * 1024;
// 200 MiB = 3 full 64 MiB parts + an 8 MiB tail (exercises the odd last part).
const SIZE = 200 * MIB;

const results = {};
let failed = 0;

async function hashWorkerObject(key) {
  const res = await fetch(`${WORKER}/objects/${key}`);
  if (res.status !== 200) return { status: res.status, sha256: null, bytes: 0 };
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { status: 200, sha256: hash.digest("hex"), bytes };
}

async function objectExists(key) {
  const res = await fetch(`${WORKER}/objects/${key}`, { method: "HEAD" });
  return res.status === 200;
}

async function upstreamStats() {
  return (await getJson(UPSTREAM, "/stats")).body;
}

async function resetUpstream({ range = true, bps = 0 } = {}) {
  await postJson(UPSTREAM, "/control/range", { enabled: range });
  await postJson(UPSTREAM, "/control/throttle", { bps });
  await postJson(UPSTREAM, "/control/reset");
  // Make blob "a" active again.
  const stats = await upstreamStats();
  if (stats.active !== "a") await postJson(UPSTREAM, "/control/rotate");
}

async function scenarioHappyRanged(info) {
  await resetUpstream();
  const sampler = createMemorySampler();
  const baselineRss = await sampler.baseline();
  const started = Date.now();
  sampler.start();
  const { body: created } = await postJson(WORKER, "/ingest", {
    url: `${UPSTREAM}/file`,
    key: "test/happy.bin",
  });
  const final = await waitInstance(created.id);
  sampler.stop();
  const wallClockMs = Date.now() - started;
  const verify = await hashWorkerObject("test/happy.bin");
  const stats = await upstreamStats();
  const upstreamRequests = {
    head: stats.requests.filter((r) => r.method === "HEAD").length,
    get206: stats.requests.filter((r) => r.method === "GET" && r.status === 206).length,
    get200: stats.requests.filter((r) => r.method === "GET" && r.status === 200).length,
  };
  const pass =
    final.status === "complete" &&
    final.output?.ok === true &&
    final.output.path === "ranged" &&
    final.output.parts === 4 &&
    final.output.sha256 === info.sha256A &&
    verify.sha256 === info.sha256A &&
    upstreamRequests.get206 === 4 &&
    upstreamRequests.get200 === 0;
  return {
    pass,
    instanceStatus: final.status,
    output: final.output,
    verify,
    wallClockMs,
    upstreamRequests,
    upstreamBytesServed: stats.bytesServed,
    memory: { baselineWorkerdRssBytes: baselineRss, ...sampler.stop() },
  };
}

async function scenarioEtagChange(info) {
  await resetUpstream({ bps: 16 * MIB });
  const { body: created } = await postJson(WORKER, "/ingest", {
    url: `${UPSTREAM}/file`,
    key: "test/etag.bin",
  });
  // Wait until the first 64MiB part has been fully served, then rotate.
  await waitFor(async () => {
    const s = await upstreamStats();
    return s.bytesServed >= 64 * MIB ? true : null;
  }, { timeoutMs: 60_000, label: "first part served" });
  await postJson(UPSTREAM, "/control/rotate");
  const final = await waitInstance(created.id);
  await postJson(UPSTREAM, "/control/throttle", { bps: 0 });
  const stats = await upstreamStats();
  const registry = (await getJson(WORKER, "/mpu/registry")).body.markers;
  const objectPresent = await objectExists("test/etag.bin");
  const ifRange200 = stats.requests.some(
    (r) => r.method === "GET" && r.ifRange && r.status === 200,
  );
  const pass =
    final.status === "errored" &&
    !objectPresent &&
    registry.length === 0 &&
    ifRange200;
  return {
    pass,
    instanceStatus: final.status,
    error: final.error ?? null,
    objectPresent,
    registryMarkersAfter: registry.length,
    ifRangeTriggeredFullBody: ifRange200,
    upstreamRequests: stats.requests,
    upstreamBytesServed: stats.bytesServed,
    note: `${info.etagA} rotated to ${info.etagB} mid-transfer`,
  };
}

async function scenarioNoRange(info) {
  await resetUpstream({ range: false });
  const sampler = createMemorySampler();
  const baselineRss = await sampler.baseline();
  const started = Date.now();
  sampler.start();
  const { body: created } = await postJson(WORKER, "/ingest", {
    url: `${UPSTREAM}/file`,
    key: "test/norange.bin",
  });
  const final = await waitInstance(created.id);
  sampler.stop();
  const wallClockMs = Date.now() - started;
  const verify = await hashWorkerObject("test/norange.bin");
  const stats = await upstreamStats();
  const expectedParts = Math.ceil(SIZE / (32 * MIB));
  const pass =
    final.status === "complete" &&
    final.output?.ok === true &&
    final.output.path === "sequential" &&
    final.output.parts === expectedParts &&
    final.output.sha256 === info.sha256A &&
    verify.sha256 === info.sha256A &&
    // one full-body GET, two HEADs (probe + trailing integrity check)
    stats.requests.filter((r) => r.method === "GET" && r.status === 200).length === 1 &&
    stats.requests.filter((r) => r.method === "HEAD").length === 2;
  return {
    pass,
    instanceStatus: final.status,
    output: final.output,
    verify,
    wallClockMs,
    upstreamRequests: {
      head: stats.requests.filter((r) => r.method === "HEAD").length,
      get200: stats.requests.filter((r) => r.method === "GET" && r.status === 200).length,
      get206: stats.requests.filter((r) => r.method === "GET" && r.status === 206).length,
    },
    memory: { baselineWorkerdRssBytes: baselineRss, ...sampler.stop() },
  };
}

async function scenarioOrphanSweep() {
  await resetUpstream({ bps: 8 * MIB });

  // Orphan 1: a "crashed" ingest created directly (MPU + junk part + marker).
  const orphan = await postJson(WORKER, "/mpu/orphan", { key: "test/manual-orphan.bin" });

  // Orphan 2: a real workflow instance terminated mid-transfer.
  const { body: created } = await postJson(WORKER, "/ingest", {
    url: `${UPSTREAM}/file`,
    key: "test/killed.bin",
  });
  await waitFor(async () => {
    const s = await upstreamStats();
    return s.bytesServed >= 8 * MIB ? true : null;
  }, { timeoutMs: 60_000, label: "transfer underway" });
  await postJson(WORKER, `/instances/${created.id}/terminate`, {});
  await postJson(UPSTREAM, "/control/throttle", { bps: 0 });
  await sleep(2000); // let the terminated instance's in-flight step settle
  const statusAfterTerminate = (await getJson(WORKER, `/instances/${created.id}`)).body.status;

  const before = (await getJson(WORKER, "/mpu/registry")).body.markers;
  const sweep = await postJson(WORKER, "/sweep", { olderThanMs: 0 });
  const after = (await getJson(WORKER, "/mpu/registry")).body.markers;
  const killedObjectPresent = await objectExists("test/killed.bin");
  const abortedIds = (sweep.body.aborted ?? []).map((m) => m.uploadId);
  const pass =
    before.length >= 2 &&
    abortedIds.includes(orphan.body.uploadId) &&
    sweep.body.errors?.length === 0 &&
    after.length === 0 &&
    !killedObjectPresent &&
    statusAfterTerminate === "terminated";
  return {
    pass,
    statusAfterTerminate,
    markersBefore: before.length,
    aborted: sweep.body.aborted,
    sweepErrors: sweep.body.errors,
    markersAfter: after.length,
    killedObjectPresent,
  };
}

const upstream = await startUpstream({ size: SIZE });
console.log("upstream up:", upstream.info.etagA, upstream.info.etagB);
const worker = await startWorker();
console.log("worker up");

try {
  results["1-happy-ranged"] = await scenarioHappyRanged(upstream.info);
  results["2-etag-change-abort"] = await scenarioEtagChange(upstream.info);
  results["3-no-range-sequential"] = await scenarioNoRange(upstream.info);
  results["4-orphan-sweep"] = await scenarioOrphanSweep();
} finally {
  worker.proc.kill();
  upstream.proc.kill();
}

for (const [name, r] of Object.entries(results)) {
  writeResult(name, r);
  if (!r.pass) failed++;
}
writeResult("summary", {
  sizeBytes: SIZE,
  scenarios: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.pass])),
  allPass: failed === 0,
});
process.exit(failed === 0 ? 0 : 1);
