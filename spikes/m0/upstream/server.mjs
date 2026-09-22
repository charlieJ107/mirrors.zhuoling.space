#!/usr/bin/env node
// THROWAWAY spike code (issue #1, M0). Not product code.
//
// Mock upstream HTTP server with controllable behavior:
//   - serves a deterministic generated blob at GET /file (HEAD supported)
//   - ETag rotation + content switch:  POST /control/rotate
//   - Range support toggle:            POST /control/range   {enabled: bool}
//   - throttle:                        POST /control/throttle {bps: number}
//   - request log / stats:             GET /stats, POST /control/reset
//
// ETag rotates => content changes too (two distinct blobs), so an incorrectly
// assembled object would hash differently. If-Range honored per RFC 9110:
// a stale If-Range validator => 200 full body instead of 206.
//
// Usage: node server.mjs --port 8792 --size 209715200 --dir ./testdata

import http from "node:http";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { port: 8792, size: 200 * 1024 * 1024, dir: "./testdata" };
  for (let i = 2; i < argv.length; i += 2) {
    args[argv[i].replace(/^--/, "")] =
      argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
  }
  args.port = Number(args.port);
  args.size = Number(args.size);
  return args;
}

// Deterministic PRNG (xorshift32) -> reproducible blobs across runs.
function generateBlob(filePath, size, seed) {
  if (fs.existsSync(filePath)) {
    const st = fs.statSync(filePath);
    if (st.size === size) return;
    fs.unlinkSync(filePath);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let x = seed >>> 0;
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  const fd = fs.openSync(filePath, "w");
  let remaining = size;
  while (remaining > 0) {
    const n = Math.min(remaining, chunk.length);
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
      chunk[i] = x & 0xff;
    }
    fs.writeSync(fd, chunk, 0, n);
    remaining -= n;
  }
  fs.closeSync(fd);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  const fd = fs.openSync(filePath, "r");
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n === 0) break;
    hash.update(buf.subarray(0, n));
  }
  fs.closeSync(fd);
  return hash.digest("hex");
}

const args = parseArgs(process.argv);
const blobA = path.join(args.dir, "blob-a.bin");
const blobB = path.join(args.dir, "blob-b.bin");
generateBlob(blobA, args.size, 0x9e3779b9);
generateBlob(blobB, args.size, 0xdeadbeef);

const state = {
  active: "a",
  rangeEnabled: true,
  bps: 0, // 0 = unthrottled
  requests: [],
  bytesServed: 0,
};
const etags = {
  a: `"a-${sha256File(blobA).slice(0, 32)}"`,
  b: `"b-${sha256File(blobB).slice(0, 32)}"`,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (u.pathname === "/stats" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      active: state.active,
      etag: etags[state.active],
      rangeEnabled: state.rangeEnabled,
      bps: state.bps,
      bytesServed: state.bytesServed,
      requests: state.requests,
    }));
    return;
  }

  if (u.pathname === "/control/reset" && req.method === "POST") {
    state.requests = [];
    state.bytesServed = 0;
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
    return;
  }

  if (u.pathname === "/control/rotate" && req.method === "POST") {
    state.active = state.active === "a" ? "b" : "a";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ active: state.active, etag: etags[state.active] }));
    return;
  }

  if (u.pathname === "/control/range" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    state.rangeEnabled = JSON.parse(body).enabled;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ rangeEnabled: state.rangeEnabled }));
    return;
  }

  if (u.pathname === "/control/throttle" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    state.bps = Number(JSON.parse(body).bps);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ bps: state.bps }));
    return;
  }

  if (u.pathname === "/file" && (req.method === "GET" || req.method === "HEAD")) {
    const file = state.active === "a" ? blobA : blobB;
    const etag = etags[state.active];
    const size = args.size;
    const baseHeaders = {
      etag,
      "content-length": String(size),
      "accept-ranges": state.rangeEnabled ? "bytes" : "none",
      "last-modified": new Date("2026-09-01T00:00:00Z").toUTCString(),
    };

    const rangeHeader = req.headers.range;
    const ifRange = req.headers["if-range"];
    const rangeHonored =
      state.rangeEnabled &&
      rangeHeader &&
      !(ifRange && ifRange !== etag); // stale validator -> full body per If-Range

    let status = 200;
    let start = 0;
    let end = size - 1;
    if (rangeHonored) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
      if (m) {
        start = Number(m[1]);
        end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
        status = 206;
      }
    }

    const headers = { ...baseHeaders };
    if (status === 206) {
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
      headers["content-length"] = String(end - start + 1);
    }
    state.requests.push({
      t: Date.now(),
      method: req.method,
      range: rangeHeader ?? null,
      ifRange: ifRange ?? null,
      status,
    });
    res.writeHead(status, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const CHUNK = 1024 * 1024;
    const fd = fs.openSync(file, "r");
    let offset = start;
    const started = Date.now();
    try {
      while (offset <= end) {
        const n = Math.min(CHUNK, end - offset + 1);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, offset);
        if (!res.write(buf)) {
          await new Promise((r) => res.once("drain", r));
        }
        state.bytesServed += n;
        offset += n;
        if (state.bps > 0) {
          const expectedMs = ((offset - start) / state.bps) * 1000;
          const actualMs = Date.now() - started;
          if (expectedMs > actualMs) await sleep(expectedMs - actualMs);
        }
      }
    } finally {
      fs.closeSync(fd);
      res.end();
    }
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(args.port, () => {
  console.log(JSON.stringify({
    listening: args.port,
    size: args.size,
    etagA: etags.a,
    etagB: etags.b,
    sha256A: sha256File(blobA),
    sha256B: sha256File(blobB),
  }));
});
