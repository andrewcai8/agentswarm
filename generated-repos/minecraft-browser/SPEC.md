# Minecraft — Browser Edition

## Document Ownership

- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose edits but must not change intent, success criteria ranking, or non-negotiables without explicit user approval.

## Product Statement

A browser-based Minecraft clone built with Three.js and TypeScript. The player loads a single HTML page and is dropped into a procedurally generated 3D voxel world. They can walk around, break blocks, place blocks, open an inventory, craft items, and experience a day/night cycle. No server required — everything runs client-side in the browser.

## Success Criteria (Ranked)

1. A playable 3D voxel world renders in the browser at 30+ FPS with procedurally generated terrain (hills, valleys, flat plains).
2. The player can move (WASD + mouse look), break blocks (left click), and place blocks (right click) with visual and audio feedback.
3. A basic inventory and crafting system allows the player to collect resources and craft tools/blocks.
4. A day/night cycle with ambient lighting changes makes the world feel alive.
5. The project compiles with zero TypeScript errors and runs from `npm start` with no additional setup.

### Hard Limits

- Time budget: Single swarm run (1-2 hours of wall clock)
- Resource budget: Must run in a modern browser (Chrome/Firefox/Safari) with no GPU requirements beyond WebGL 2.0
- External services: No paid APIs, no backend server, no database
- Runtime mode: Fully client-side, works offline after initial load

## Acceptance Tests (Runnable, Objective)

- `npm install && npm run build` completes with exit code 0 and no TypeScript errors
- `npm start` serves the game on localhost; opening it in Chrome shows a 3D voxel world
- WASD keys move the player through the world; mouse controls camera look direction
- Left-clicking a block removes it from the world and adds it to inventory
- Right-clicking places the currently selected block from inventory
- Pressing E opens/closes an inventory panel showing collected blocks
- The sky color transitions from blue (day) to dark blue/black (night) over a 5-minute cycle
- Terrain is different each page reload (seeded random generation)
- FPS counter shows 30+ FPS on a standard laptop with integrated graphics

## Non-Negotiables

- No TODOs, placeholders, or pseudocode in core paths.
- Every module has explicit TypeScript types — no `any`, `@ts-ignore`, or `@ts-expect-error`.
- No silent failures; errors are surfaced in console and UI.
- The game must be playable — not just renderable. Input must work, blocks must be interactive.
- All game state lives in memory — no localStorage, no IndexedDB, no server calls.

## Architecture Constraints

### Topology

- Repo structure: Single package (flat `src/` directory)
- Primary boundaries: Engine (rendering, game loop) / World (terrain, chunks, blocks) / Player (input, camera, physics) / UI (HUD, inventory, crafting)

### Contracts

- Block type registry: `src/blocks/BlockRegistry.ts` — single source of truth for all block types, textures, and properties
- Chunk data format: `src/world/Chunk.ts` — defines the voxel storage format (flat array, 16x16x16)
- Input event contract: `src/input/InputManager.ts` — all keyboard/mouse bindings defined in one place

### File/Folder Expectations

- `src/engine/`: Game loop, renderer setup, Three.js scene management, camera
- `src/world/`: Chunk generation, chunk meshing, terrain noise, block registry, world manager
- `src/player/`: Player controller, physics/collision, inventory state, block interaction (break/place)
- `src/ui/`: HUD overlay (crosshair, hotbar), inventory screen, crafting grid, FPS counter
- `src/utils/`: Noise functions, math helpers, constants
- `src/main.ts`: Entry point — initializes engine, world, player, UI, starts game loop

## Dependency Philosophy

### Allowed

- `three` (3D rendering)
- `simplex-noise` or equivalent (terrain generation)
- `vite` (dev server and bundler)
- `typescript` (compilation)

### Banned

- React, Vue, Angular, or any UI framework (use vanilla DOM for UI overlays)
- Any physics engine (implement simple AABB collision manually)
- Any networking library (no multiplayer)
- Any game engine wrapper (no `three-game`, no `cannon-es`)
- jQuery or lodash

### Scaffold-Only (Must Be Replaced)

- None — all dependencies are final

## Scope Model

### Must Have (7)

- Procedural terrain generation with Simplex noise (varied elevation, not flat)
- Chunk-based world with 16x16x16 chunks, loaded/unloaded by player proximity
- First-person camera with mouse look (pointer lock) and WASD movement
- Block breaking (left click) with block removal animation/particles
- Block placing (right click) on adjacent face of targeted block
- Basic inventory (hotbar + grid) showing collected block counts
- Day/night cycle with sky color and ambient light changes

### Nice to Have (5)

- Simple crafting system (combine wood → planks → sticks → tools)
- Multiple biomes (forest with trees, desert with sand, snow)
- Water blocks with transparency and simple flow animation
- Block highlight outline showing which block the crosshair targets
- Ambient sound effects (footsteps, block break, block place)

### Out of Scope

- Multiplayer / networking
- Mobs / AI entities
- Redstone / circuit logic
- Save/load (persistence across sessions)
- Mobile touch controls
- Advanced lighting (shadows, ambient occlusion beyond basic)
- Infinite world generation (limit to a reasonable render distance)

## Throughput / Scope Ranges

- Initial task fan-out target: 50-80 worker tasks in first planning iteration
- Change size target: Each task touches 1-5 files, produces a focused commit
- Parallelism target: 2-4 active branches per subsystem (engine, world, player, UI)
- Runtime target window: Demo-ready in 1-2 hours

## Reliability Requirements (Long-Run Defense)

- Game loop must not crash on edge cases (placing block outside loaded chunks, breaking air, etc.)
- Chunk loading/unloading must not leak memory (dispose Three.js geometries and materials)
- Input handling must gracefully handle pointer lock failures (show message, allow retry)
- Frame rate should degrade gracefully under load (reduce render distance, not crash)

## Required Living Artifacts

The repo must include and keep these files current:

- `README.md`: exact local setup and run commands from clean machine.
- `SPEC.md`: this file — rewritten to current intent; do not append stale plans.
- `DECISIONS.md`: short architecture decisions with rationale and status.
- `RUNBOOK.md`: operational guide for running, building, and troubleshooting.

## Definition of Done

- All acceptance tests pass.
- Must-have scope is complete and playable.
- Non-negotiables are satisfied.
- `npm run build` produces zero errors.
- Opening localhost shows a playable Minecraft-style game.
