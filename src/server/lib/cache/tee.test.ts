import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { teeUpload } from "@server/lib/cache/tee";
import { FakeR2Bucket, bytes, streamOf, streamToBytes } from "@server/lib/cache/testing";

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function readClient(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return streamToBytes(stream);
}

describe("teeUpload", () => {
  it("streams to client and R2 single-PUT in parallel with a correct sha256", async () => {
    const bucket = new FakeR2Bucket();
    const data = bytes("hello mirror");
    const tee = teeUpload(streamOf(data), {
      bucket,
      key: "tmp/test-1",
      contentLength: data.byteLength,
    });

    const received = await readClient(tee.clientStream);
    const outcome = await tee.done;

    expect(received).toEqual(data);
    expect(outcome).toEqual({ sha256: sha256(data), size: data.byteLength });
    expect(bucket.objects.get("tmp/test-1")).toEqual(data);
    expect(bucket.multipartParts.has("tmp/test-1")).toBe(false);
  });

  it("uses multipart for unknown sizes and assembles parts correctly", async () => {
    const bucket = new FakeR2Bucket();
    const chunks = [bytes("hello "), bytes("mirror"), bytes(" world!")];
    const data = bytes("hello mirror world!");
    const tee = teeUpload(streamOf(...chunks), {
      bucket,
      key: "tmp/test-2",
      contentLength: null,
      partSizeBytes: 5,
    });

    const received = await readClient(tee.clientStream);
    const outcome = await tee.done;

    expect(received).toEqual(data);
    expect(outcome).toEqual({ sha256: sha256(data), size: data.byteLength });
    expect(bucket.objects.get("tmp/test-2")).toEqual(data);
    // 20 bytes / 5-byte parts = 4 parts
    expect(bucket.multipartParts.get("tmp/test-2")).toBe(4);
  });

  it("uses multipart when the size is above the threshold", async () => {
    const bucket = new FakeR2Bucket();
    const data = bytes("0123456789");
    const tee = teeUpload(streamOf(data), {
      bucket,
      key: "tmp/test-3",
      contentLength: data.byteLength,
      partSizeBytes: 4,
      multipartThresholdBytes: 5,
    });

    await readClient(tee.clientStream);
    const outcome = await tee.done;

    expect(outcome?.sha256).toBe(sha256(data));
    expect(bucket.multipartParts.get("tmp/test-3")).toBe(3);
    expect(bucket.objects.get("tmp/test-3")).toEqual(data);
  });

  it("resolves done=null and aborts the upload when the client disconnects", async () => {
    const bucket = new FakeR2Bucket();
    // A source that blocks until cancelled.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("first chunk"));
      },
    });

    const tee = teeUpload(source, { bucket, key: "tmp/test-4", contentLength: null, partSizeBytes: 5 });
    const reader = tee.clientStream.getReader();
    const first = await reader.read();
    expect(first.value).toEqual(bytes("first chunk"));
    await reader.cancel("client gone");

    const outcome = await tee.done;
    expect(outcome).toBeNull();
    expect(bucket.abortedUploads).toContain("tmp/test-4");
    expect(bucket.objects.has("tmp/test-4")).toBe(false);
  });

  it("keeps serving the client when the R2 upload fails", async () => {
    const bucket = new FakeR2Bucket();
    bucket.failPuts = true;
    const data = bytes("still served");
    const tee = teeUpload(streamOf(data), {
      bucket,
      key: "tmp/test-5",
      contentLength: data.byteLength,
    });

    const received = await readClient(tee.clientStream);
    const outcome = await tee.done;

    expect(received).toEqual(data);
    expect(outcome).toBeNull();
    expect(bucket.objects.has("tmp/test-5")).toBe(false);
  });
});
