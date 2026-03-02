# minecraft-browser

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent during implementation; user may edit anytime.

## Quick Start (Clean Machine)
1. Install Node.js 22 LTS.
2. From project root, run `npm ci`.
3. Start dev server with `npm run dev`.
4. Open the local URL printed by Vite and click into the canvas to lock pointer controls.

## Verify
- `npm run typecheck`
- `npm run test`
- `npm run build`
- `npm run test:e2e`

## Demo Flow
1. Run `npm run dev` and open the game in a desktop browser.
2. Move with `WASD`, look with mouse, break block with left click, place block with right click.
3. Refresh the page and confirm your block edits persist in the same coordinates.
