#!/bin/bash
# run-gource.sh
# Usage: ./run-gource.sh [--demo] [--replay FILE]

# 1. Check if Gource is installed
if ! command -v gource &> /dev/null; then
    echo "Gource could not be found. Please install it:"
    echo "brew install gource"
    exit 1
fi

# 2. Determine Source
# If --demo, use dashboard.py in demo mode.
# If arguments provided, run the real Orchestrator.
# If --replay, use dashboard.py replay mode.

CMD=""
if [[ "$1" == "--demo" ]]; then
    CMD="uv run dashboard.py --json-only --demo"
elif [[ "$1" == "--replay" ]]; then
    CMD="uv run dashboard.py --json-only $@"
elif [[ -n "$1" ]]; then
    # Live Mode
    # Check if built
    if [ ! -f "packages/orchestrator/dist/main.js" ]; then
        echo "Orchestrator not built. Running pnpm build..."
        pnpm --filter @agentswarm/orchestrator build
    fi
    CMD="node packages/orchestrator/dist/main.js '$@'"
else
    echo "Usage:"
    echo "  ./run-gource.sh --demo               # Run simulated demo"
    echo "  ./run-gource.sh \"Your Request...\"    # Run LIVE swarm on a request"
    echo "  ./run-gource.sh --replay logs.ndjson # Replay a log file"
    exit 1
fi

echo "Source Command: $CMD"

# 3. Run Pipeline
# Source -> gource-adapter.py -> gource

eval "$CMD" | \
python3 gource-adapter.py | \
gource \
    --realtime \
    --log-format custom \
    -1280x720 \
    --title "Agent Swarm - Living System" \
    --seconds-per-day 0.1 \
    --auto-skip-seconds 0.1 \
    --file-idle-time 0 \
    --hide filenames,dirnames,mouse,progress \
    --key \
    --multi-sampling \
    --background-colour 000000 \
    --elasticity 0.1 \
    --bloom-multiplier 1.5 \
    --bloom-intensity 0.5 \
    -
