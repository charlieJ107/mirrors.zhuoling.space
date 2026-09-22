import type { ObjectStorage } from "@server/env";

export class UnsupportedObjectStorage implements ObjectStorage {
  async get(): Promise<ReadableStream | null> {
    throw new Error("Object storage is not configured for this runtime");
  }

  async put(): Promise<void> {
    throw new Error("Object storage is not configured for this runtime");
  }

  async delete(): Promise<void> {
    throw new Error("Object storage is not configured for this runtime");
  }
}
