/** @module Structured NDJSON logger with dual stdout/file output and per-agent context tagging */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import type { AgentRole, LogEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Log level ordering — lower number = more verbose
// ---------------------------------------------------------------------------

const LOG_LEVEL_ORDER = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVEL_ORDER;

/**
 * Resolve the effective stdout log level from the LOG_LEVEL env var.
 * Defaults to "info" — debug messages go to file only unless LOG_LEVEL=debug.
 */
function resolveLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase().trim();
  if (raw in LOG_LEVEL_ORDER) return raw as LogLevel;
  return "info";
}

let stdoutMinLevel: LogLevel = resolveLogLevel();

/** Programmatically override the stdout log level (e.g. from config). */
export function setLogLevel(level: LogLevel): void {
  stdoutMinLevel = level;
}

/** Get the current stdout log level. */
export function getLogLevel(): LogLevel {
  return stdoutMinLevel;
}

// ---------------------------------------------------------------------------
// LogWriter — singleton that tees NDJSON lines to a file in logs/
// ---------------------------------------------------------------------------

class LogWriter {
  private stream: WriteStream | null = null;
  private filePath: string | null = null;

  /**
   * Enable file logging. Creates `<projectRoot>/logs/run-<ISO>.ndjson`.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  enable(projectRoot: string): string {
    if (this.stream) return this.filePath!;

    const logsDir = resolve(projectRoot, "logs");
    mkdirSync(logsDir, { recursive: true });

    const ts = new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d+Z$/, "");
    this.filePath = resolve(logsDir, `run-${ts}.ndjson`);
    this.stream = createWriteStream(this.filePath, { flags: "a" });

    return this.filePath;
  }

  write(line: string): void {
    if (this.stream) {
      this.stream.write(line + "\n");
    }
  }

  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

const logWriter = new LogWriter();

/**
 * Enable file logging for all Logger instances.
 * Call once at startup from main.ts.
 * Returns the absolute path to the log file.
 */
export function enableFileLogging(projectRoot: string): string {
  return logWriter.enable(projectRoot);
}

/** Close the log file. Call on graceful shutdown. */
export function closeFileLogging(): void {
  logWriter.close();
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  constructor(
    private agentId: string,
    private agentRole: AgentRole,
    private taskId?: string,
  ) {}

  withTask(taskId: string): Logger {
    return new Logger(this.agentId, this.agentRole, taskId);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogEntry["level"], message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      agentId: this.agentId,
      agentRole: this.agentRole,
      taskId: this.taskId,
      message,
      data,
    };
    const line = JSON.stringify(entry);

    // Always write to file (all levels)
    logWriter.write(line);

    // Only write to stdout if level meets the threshold
    if (LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[stdoutMinLevel]) {
      process.stdout.write(line + "\n");
    }
  }
}

export function createLogger(agentId: string, role: AgentRole, taskId?: string): Logger {
  return new Logger(agentId, role, taskId);
}
