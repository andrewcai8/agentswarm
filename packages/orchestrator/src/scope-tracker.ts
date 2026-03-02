import { createLogger } from "@longshot/core";

const logger = createLogger("scope-tracker", "root-planner");

export interface ScopeOverlap {
  taskId: string;
  overlappingFiles: string[];
}

export class ScopeTracker {
  private activeScopes: Map<string, Set<string>> = new Map();

  register(taskId: string, scope: string[]): void {
    this.activeScopes.set(taskId, new Set(scope));
  }

  release(taskId: string): void {
    this.activeScopes.delete(taskId);
  }

  getOverlaps(taskId: string, scope: string[]): ScopeOverlap[] {
    const overlaps: ScopeOverlap[] = [];
    const incoming = new Set(scope);

    for (const [existingId, existingScope] of this.activeScopes) {
      if (existingId === taskId) continue;
      const shared: string[] = [];
      for (const file of incoming) {
        if (existingScope.has(file)) {
          shared.push(file);
        }
      }
      if (shared.length > 0) {
        overlaps.push({ taskId: existingId, overlappingFiles: shared });
      }
    }

    return overlaps;
  }

  getLockedFiles(): string[] {
    const allFiles = new Set<string>();
    for (const scope of this.activeScopes.values()) {
      for (const file of scope) {
        allFiles.add(file);
      }
    }
    return [...allFiles].sort();
  }
}
