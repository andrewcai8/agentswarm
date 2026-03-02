# Architecture Decisions

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent whenever architecture-affecting choices are made; user can override or mark replaced.

## Format
Use short entries:
- Date: `YYYY-MM-DD`
- Decision: short statement of what was chosen
- Why: short rationale
- Alternatives considered: brief list
- Status: active or replaced

## Decisions
### Render Stack: Three.js + Custom Voxel Mesher
- Date: `2026-02-14`
- Decision: Use Three.js for low-level rendering while owning chunk meshing and world simulation logic in project code.
- Why: Three.js accelerates browser rendering setup while preserving control over voxel-specific performance and data structures.
- Alternatives considered: BabylonJS, PlayCanvas, raw WebGL2.
- Status: `active`

### Persistence: Local-First Browser Storage
- Date: `2026-02-14`
- Decision: Persist world edits in browser storage with explicit schema versioning.
- Why: Matches offline-first requirement and minimizes infrastructure dependencies for first playable slice.
- Alternatives considered: backend-only persistence, IndexedDB wrapper service worker.
- Status: `active`

### Testing Strategy: Unit + E2E Baseline
- Date: `2026-02-14`
- Decision: Gate progress with deterministic unit tests for world logic and one browser E2E flow for place/reload persistence.
- Why: Protects core gameplay loop with fast feedback while validating real browser behavior.
- Alternatives considered: E2E only, unit only.
- Status: `active`
