// THROWAWAY spike code (issue #1, M0). Not product code.
// Shared helpers for the local end-to-end scenarios.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const SPIKE_DIR = path.resolve(import.meta.dirname, "..");
export const UPSTREAM_PORT = 8792;
export const WORKER_PORT = 8791;
export const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;
export const WORKER = `http://127.0.0.1:${WORKER_PORT}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function spawnProc(command, args, opts = {}) {
  const proc = spawn(command, args, {
    shell: false,
    windowsHide: true,
    ...opts,
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d.toString()));
  proc.stderr.on("data", (d) => (out += d.toString()));
  proc.on("exit", (code) => {
    proc.exitCode = code;
  });
  return { proc, getOutput: () => out };
}

export async function waitFor(fn, { timeoutMs = 60_000, intervalMs = 250, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}

export async function startUpstream({ size }) {
  const { proc, getOutput } = spawnProc(process.execPath, [
    path.join(SPIKE_DIR, "upstream", "server.mjs"),
    "--port", String(UPSTREAM_PORT),
    "--size", String(size),
    "--dir", path.join(SPIKE_DIR, "testdata"),
  ]);
  const info = await waitFor(async () => {
    const line = getOutput().trim().split("\n").find((l) => l.startsWith("{"));
    return line ? JSON.parse(line) : null;
  }, { timeoutMs: 120_000, label: "upstream startup" });
  return { proc, info, getOutput };
}

export async function startWorker() {
  const wranglerJs = path.resolve(
    SPIKE_DIR,
    "..", "..", "node_modules", "wrangler", "bin", "wrangler.js",
  );
  const { proc, getOutput } = spawnProc(
    process.execPath,
    [wranglerJs, "dev", "--config", "wrangler.jsonc", "--port", String(WORKER_PORT)],
    { cwd: SPIKE_DIR },
  );
  await waitFor(async () => {
    const res = await fetch(`${WORKER}/mpu/registry`).catch(() => null);
    return res && res.status === 200 ? true : null;
  }, { timeoutMs: 120_000, label: "wrangler dev ready" });
  return { proc, getOutput };
}

export async function postJson(base, pathName, body) {
  const res = await fetch(base + pathName, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

export async function getJson(base, pathName) {
  const res = await fetch(base + pathName);
  return { status: res.status, body: await res.json() };
}

export async function waitInstance(id, { timeoutMs = 300_000 } = {}) {
  return waitFor(async () => {
    const { body } = await getJson(WORKER, `/instances/${id}`);
    if (["complete", "errored", "terminated", "cancelled", "paused"].includes(body.status)) {
      return body;
    }
    return null;
  }, { timeoutMs, intervalMs: 500, label: `instance ${id} terminal state` });
}

// --- memory sampling of the local workerd process tree (Windows) ---

export function createMemorySampler() {
  let timer = null;
  let peak = 0;
  let samples = 0;
  async function sampleOnce() {
    try {
      const { execFile } = await import("node:child_process");
      const out = await new Promise((resolve) => {
        execFile(
          "powershell",
          ["-NoProfile", "-Command",
            "(Get-Process workerd -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum"],
          { timeout: 5000 },
          (err, stdout) => resolve(err ? "" : stdout),
        );
      });
      const v = Number(out.trim());
      if (v > 0) {
        peak = Math.max(peak, v);
        samples++;
      }
    } catch { /* sampling is best-effort */ }
  }
  return {
    async baseline() {
      await sampleOnce();
      return peak;
    },
    start(intervalMs = 300) {
      timer = setInterval(sampleOnce, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      return { peakWorkerdRssBytes: peak, samples };
    },
  };
}

export function writeResult(name, data) {
  const dir = path.join(SPIKE_DIR, "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log(`\n=== ${name} ===\n${JSON.stringify(data, null, 2)}\n-> ${file}`);
}
