#!/bin/bash
# run-gource.sh — Launch Gource visualization for AgentSwarm
#
# Usage:
#   ./run-gource.sh --demo                     # synthetic demo (no orchestrator)
#   ./run-gource.sh --live                     # live from poke-server SSE
#   ./run-gource.sh --replay logs/file.ndjson  # replay saved NDJSON log
#   ./run-gource.sh "Build a Minecraft..."     # live orchestrator run

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AVATAR_DIR="$DIR/marketing/img/gource-avatars"

# ── Find Gource ──────────────────────────────────────────────────────────────
GOURCE=""
if [[ -f "$DIR/gource-bin/gource.exe" ]]; then
    GOURCE="$DIR/gource-bin/gource.exe"
elif command -v gource &>/dev/null; then
    GOURCE="gource"
fi

if [[ -z "$GOURCE" ]]; then
    echo "Gource not found."
    echo ""
    echo "Quick setup (portable, no install):"
    echo "  curl -L -o gource.zip https://github.com/acaudwell/Gource/releases/download/gource-0.53/gource-0.53.win64.zip"
    echo "  unzip gource.zip -d gource-bin"
    echo ""
    echo "Or install system-wide:"
    echo "  Windows:  winget install gource"
    echo "  macOS:    brew install gource"
    echo "  Linux:    sudo apt install gource"
    exit 1
fi

# ── Gource flags ─────────────────────────────────────────────────────────────
ARGS=(
    --log-format custom
    -1280x720
    --windowed
    --title "AgentSwarm"
    --background-colour 0D0D12
    --font-colour 888888
    --seconds-per-day 10.0
    --auto-skip-seconds 0.1
    --file-idle-time 0
    --max-file-lag 0.05
    --elasticity 0.03
    --bloom-multiplier 0.3
    --bloom-intensity 0.2
    --highlight-users
    --user-scale 1.0
    --file-font-size 10
    --key
    --hide mouse,progress
    --dir-name-depth 4
    --padding 1.0
    --multi-sampling
    --max-user-speed 300
    --user-friction 0.2
)

[[ -d "$AVATAR_DIR" ]] && ARGS+=(--user-image-dir "$AVATAR_DIR")

# ── Mode ─────────────────────────────────────────────────────────────────────
MODE="${1:---help}"

case "$MODE" in
    --demo)
        echo "Generating demo → demo.gource ..."
        python "$DIR/gource-adapter.py" --demo --save "$DIR/demo.gource"
        echo "Launching Gource..."
        "$GOURCE" "${ARGS[@]}" "$DIR/demo.gource"
        ;;

    --live)
        URL="${2:-http://localhost:8787/events}"
        echo "Live from $URL (run pnpm poke:dev first)"
        TMP="$DIR/.gource-live.log"
        > "$TMP"
        curl -sN "$URL" | python "$DIR/gource-adapter.py" --sse >> "$TMP" &
        PID=$!
        sleep 2
        "$GOURCE" "${ARGS[@]}" --realtime "$TMP" || true
        kill "$PID" 2>/dev/null || true
        rm -f "$TMP"
        ;;

    --replay)
        LOG="${2:-}"
        [[ -z "$LOG" || ! -f "$LOG" ]] && { echo "Usage: $0 --replay <file.ndjson>"; exit 1; }
        echo "Replaying $LOG ..."
        python "$DIR/gource-adapter.py" < "$LOG" > "$DIR/.gource-replay.log"
        "$GOURCE" "${ARGS[@]}" "$DIR/.gource-replay.log"
        rm -f "$DIR/.gource-replay.log"
        ;;

    --help|-h)
        echo "Usage: $0 <mode>"
        echo ""
        echo "  --demo                   Synthetic demo (no orchestrator)"
        echo "  --live [SSE_URL]         Live from poke-server SSE"
        echo "  --replay <file.ndjson>   Replay a saved NDJSON log"
        echo "  \"request text\"           Run orchestrator + visualize"
        ;;

    *)
        # Live Orchestrator Mode (Relative to parent dir)
        PROJECT_ROOT="$DIR/.."
        ORCHESTRATOR_DIST="$PROJECT_ROOT/packages/orchestrator/dist/main.js"

        if [[ ! -f "$ORCHESTRATOR_DIST" ]]; then
            echo "Orchestrator not built. Run: pnpm build"
            exit 1
        fi
        echo "Running orchestrator → Gource..."
        node "$ORCHESTRATOR_DIST" "$@" \
            | python "$DIR/gource-adapter.py" > "$DIR/.gource-live.log" &
        PID=$!; sleep 3
        "$GOURCE" "${ARGS[@]}" --realtime "$DIR/.gource-live.log" || true
        kill "$PID" 2>/dev/null || true
        rm -f "$DIR/.gource-live.log"
        ;;
esac
