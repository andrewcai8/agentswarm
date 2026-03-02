# Minecraft — Browser Edition

## Document Ownership

- Type: User input to swarm.
- Created by: User before run.
- Updated by: User is primary editor; agents may propose edits but must not change intent, success criteria ranking, or non-negotiables without explicit user approval.

## Product Statement

A browser-based Minecraft clone built with React, React Three Fiber, and TypeScript. The player loads a single HTML page and is dropped into a procedurally generated 3D voxel world. They can walk around, break blocks, place blocks, manage inventory, and experience a day/night cycle. The project leverages the React ecosystem (Drei, Cannon) to provide a modern, declarative, and modular codebase.

## Success Criteria (Ranked)

1. A playable 3D voxel world renders in the browser at 30+ FPS with procedurally generated terrain, leveraging React Three Fiber's distinct component architecture.
2. The player can move (WASD + mouse look), break blocks (left click), and place blocks (right click) using physics-based interactions (React Three Cannon).
3. A basic inventory and crafting system, implemented with React UI components, allows resource management.
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
- Left-clicking a block removes it from the world (updates state/mesh)
- Right-clicking places the currently selected block from inventory
- Pressing E opens/closes an inventory panel (React UI overlay)
- The sky color transitions from blue (day) to dark blue/black (night) over a 5-minute cycle
- Terrain is different each page reload (seeded random generation)
- FPS counter shows 30+ FPS on a standard laptop

## Non-Negotiables

- No TODOs, placeholders, or pseudocode in core paths.
- Every module has explicit TypeScript types — no `any`, `@ts-ignore`, or `@ts-expect-error`.
- No silent failures; errors are surfaced in console and UI.
- The game must be playable — not just renderable. Input must work, blocks must be interactive.
- All game state lives in memory (Zustand/Context) — no server calls.

## Architecture Constraints

### Topology

- Repo structure: Standard React project structure (`src/components`, `src/hooks`, `src/store`, `src/images`).
- Primary boundaries:
  - **World State**: Global store (Zustand) for blocks and chunks.
  - **3D Components**: R3F components for Terrain, Player, Sky.
  - **UI Overlay**: Standard HTML/CSS React components for HUD and Inventory.

### Contracts

- Block definition: `src/blocks.ts` or `store/textureStore.ts` defining block types and texture mappings.
- World Generation: Custom hook or worker-friendly logic to generate chunk data from noise.
- Physics: `@react-three/cannon` used for player controller and collision detection.

### File/Folder Expectations

- `src/components/`: React components (e.g., `Player.tsx`, `Ground.tsx`, `Cube.tsx`, `Inventory.tsx`).
- `src/hooks/`: Custom hooks for game logic (e.g., `useKeyboard.ts`, `useStore.ts`).
- `src/images/`: Texture assets (can be loaded via public folder or imports).
- `src/App.tsx`: Main entry point setting up the Canvas and Physics world.
- `src/main.tsx`: DOM entry point.

## Dependency Philosophy

### Allowed

- `react`, `react-dom`
- `@types/react`, `@types/react-dom`
- `three`, `@types/three`
- `@react-three/fiber` (R3F core)
- `@react-three/drei` (Helpers: Sky, PointerLockControls, Stats, etc.)
- `@react-three/cannon` (Physics: useBox, useSphere, Physics provider)
- `zustand` (State management for inventory/world)
- `simplex-noise` (Terrain generation)
- `typescript`
- `vite`

### Banned

- jQuery or lodash
- Heavy UI frameworks (MUI, Bootstrap) - use scoped CSS or styled-components/CSS modules if needed, but plain CSS preferred for simplicity logic.
- Complex state machines (XState) - keep it simple with Zustand.

### Scaffold-Only (Must Be Replaced)

- None — all dependencies are final.

## Reference / Inspiration

The project implementation should take specific technical and aesthetic inspiration from:

- [Minecraft Three.js (vyers)](https://github.com/vyers/minecraft-threejs) - Inspiration for voxel rendering techniques.
- [Custom Minecraft (pribardi)](https://github.com/pribardi/custom_minecraft/tree/main/minecraft-clone) - Inspiration for React/Three project structure.

These 2 repositories are also minecraft clones. But we need to take what it doesn't do well and improve upon it to build an even better minecraft clone.

## Scope Model

### Must Have (7)

- Procedural terrain generation with Simplex noise.
- Chunk-based or optimized instance-mesh rendering for blocks.
- First-person camera with mouse look (PointerLockControls from Drei) and WASD movement.
- Physical interactions (jumping, collision with ground) using Cannon.
- Block breaking/placing interactions updating the global store.
- Basic inventory UI (React DOM overlay) showing selected block.
- Day/night cycle (Sky component from Drei or custom).

### Nice to Have (5)

- Texture selector (1-9 keys).
- Sound effects (use-sound or native Audio).
- Advanced biomes.
- Ambient occlusion (if performant).
- Save/Load to LocalStorage (persistence).

### Out of Scope

- Multiplayer / networking.
- Mobs / AI entities.
- Redstone.
- Infinite world generation (limit to a fixed set of chunks or simple infinite scroller).

## Throughput / Scope Ranges

- Initial task fan-out target: 50-80 worker tasks.
- Change size target: Each task touches 1-5 files.
- Parallelism target: High (UI and 3D scenes are decoupled).
- Runtime target window: Demo-ready in 1-2 hours.

## Reliability Requirements

- Component unmounting must clean up resources.
- Physics calculations should be stable (prevent falling through world).
- React strict mode should not break the game loop.
- UI overlay should be responsive and not capture pointer lock incorrectly.

## Required Living Artifacts

- `README.md`: exact local setup and run commands.
- `SPEC.md`: this file.
- `DECISIONS.md`: architecture decisions.

## Definition of Done

- All acceptance tests pass.
- Must-have scope is complete and playable.
- `npm run build` produces zero errors.
- Opening localhost shows a playable Minecraft-style game built with React.
