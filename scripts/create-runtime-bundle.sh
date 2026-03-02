#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-}"

if [[ -z "${VERSION}" ]]; then
  VERSION="$(python - <<'PY'
import tomllib
from pathlib import Path

data = tomllib.loads(Path('pyproject.toml').read_text(encoding='utf-8'))
print(data['project']['version'])
PY
)"
fi

OUT_FILE="${2:-${ROOT_DIR}/dist/runtime/longshot-runtime-v${VERSION}.tar.gz}"
OUT_DIR="$(dirname "${OUT_FILE}")"

REQUIRED=(
  "${ROOT_DIR}/packages/core/dist/index.js"
  "${ROOT_DIR}/packages/orchestrator/dist/main.js"
  "${ROOT_DIR}/prompts/root-planner.md"
  "${ROOT_DIR}/scripts/reset-target.sh"
)

for path in "${REQUIRED[@]}"; do
  if [[ ! -f "${path}" ]]; then
    echo "Missing required runtime asset: ${path}" >&2
    echo "Run 'pnpm build' before creating a runtime bundle." >&2
    exit 1
  fi
done

mkdir -p "${OUT_DIR}"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT

RUNTIME_DIR="${STAGE_DIR}/runtime"
mkdir -p "${RUNTIME_DIR}/packages/core" "${RUNTIME_DIR}/packages/orchestrator"

cp -R "${ROOT_DIR}/prompts" "${RUNTIME_DIR}/prompts"
mkdir -p "${RUNTIME_DIR}/scripts"
cp "${ROOT_DIR}/scripts/reset-target.sh" "${RUNTIME_DIR}/scripts/reset-target.sh"

cp "${ROOT_DIR}/packages/core/package.json" "${RUNTIME_DIR}/packages/core/package.json"
cp -R "${ROOT_DIR}/packages/core/dist" "${RUNTIME_DIR}/packages/core/dist"
cp -R "${ROOT_DIR}/packages/orchestrator/dist" "${RUNTIME_DIR}/packages/orchestrator/dist"

cat > "${RUNTIME_DIR}/package.json" <<'EOF'
{
  "name": "longshot-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@longshot/core": "file:./packages/core",
    "@mariozechner/pi-coding-agent": "^0.52.0",
    "dotenv": "^17.3.1"
  }
}
EOF

tar -czf "${OUT_FILE}" -C "${STAGE_DIR}" runtime
echo "Created runtime bundle: ${OUT_FILE}"
