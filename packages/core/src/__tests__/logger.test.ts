import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  closeFileLogging,
  createLogger,
  enableFileLogging,
  getLogLevel,
  setLogLevel,
} from "../logger.js";

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function readNdjsonEventually(filePath: string, minLines: number): Promise<unknown[]> {
  const deadline = Date.now() + 500;
  let lastErr: unknown;

  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length >= minLines) {
        return lines.map((l) => JSON.parse(l) as unknown);
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 10));
  }

  if (lastErr instanceof Error) {
    throw lastErr;
  }
  throw new Error(`Timed out waiting for NDJSON lines in ${filePath}`);
}

async function withCapturedStdout(fn: (writes: string[]) => void | Promise<void>): Promise<void> {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;

  function captureWrite(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  function captureWrite(
    str: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean;
  function captureWrite(
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    let callback: ((err?: Error | null) => void) | undefined;
    let enc: BufferEncoding = "utf8";
    if (typeof encodingOrCb === "function") {
      callback = encodingOrCb;
    } else {
      enc = encodingOrCb ?? "utf8";
      callback = cb;
    }

    if (typeof chunk === "string") {
      writes.push(chunk);
    } else {
      writes.push(Buffer.from(chunk).toString(enc));
    }

    if (callback) callback();
    return true;
  }

  process.stdout.write = captureWrite;
  try {
    await fn(writes);
  } finally {
    process.stdout.write = originalWrite;
  }
}

afterEach(() => {
  closeFileLogging();
  setLogLevel("info");
});

describe("logger", () => {
  it("writes valid NDJSON line shape to stdout", async () => {
    setLogLevel("debug");

    await withCapturedStdout(async (writes) => {
      const logger = createLogger("agent-1", "worker").withTask("task-123");
      logger.debug("hello", { answer: 42 });

      assert.strictEqual(writes.length, 1);
      const line = writes[0];
      assert.ok(line);

      const parsed = JSON.parse(line) as unknown;
      assert.ok(parsed && typeof parsed === "object");

      const obj = parsed as Record<string, unknown>;
      assert.strictEqual(typeof obj.timestamp, "number");
      assert.strictEqual(obj.level, "debug");
      assert.strictEqual(obj.agentId, "agent-1");
      assert.strictEqual(obj.agentRole, "worker");
      assert.strictEqual(obj.taskId, "task-123");
      assert.strictEqual(obj.message, "hello");

      const data = obj.data;
      assert.ok(data && typeof data === "object");
      assert.strictEqual((data as Record<string, unknown>).answer, 42);
    });
  });

  it("filters stdout output based on log level", async () => {
    setLogLevel("warn");

    await withCapturedStdout(async (writes) => {
      const logger = createLogger("agent-2", "worker");
      logger.info("skip");
      logger.error("emit");

      assert.strictEqual(writes.length, 1);
      const obj = JSON.parse(writes[0] ?? "") as { level?: unknown; message?: unknown };
      assert.strictEqual(obj.level, "error");
      assert.strictEqual(obj.message, "emit");
    });
  });

  it("always writes all levels to file, while still filtering stdout", async () => {
    setLogLevel("error");
    const root = await createTempDir("core-logger-test-");
    const filePath = enableFileLogging(root);
    assert.ok(filePath.includes(path.join(root, "logs")));

    await withCapturedStdout(async (writes) => {
      const logger = createLogger("agent-3", "worker");
      logger.debug("debug-only-file");
      logger.error("error-file-and-stdout");

      assert.strictEqual(writes.length, 1);
      const stdoutObj = JSON.parse(writes[0] ?? "") as { level?: unknown };
      assert.strictEqual(stdoutObj.level, "error");
    });

    closeFileLogging();
    const entries = await readNdjsonEventually(filePath, 2);
    assert.strictEqual(entries.length, 2);

    const first = entries[0];
    const second = entries[1];
    assert.ok(first && typeof first === "object");
    assert.ok(second && typeof second === "object");
    assert.strictEqual((first as { level?: unknown }).level, "debug");
    assert.strictEqual((second as { level?: unknown }).level, "error");

    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it("getLogLevel reflects programmatic override", () => {
    setLogLevel("warn");
    assert.strictEqual(getLogLevel(), "warn");
  });
});
