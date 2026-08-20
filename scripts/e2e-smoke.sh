#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
profile_dir="$dsh_home/profiles/test-todo-stack"
dsh_bin="${DSH_E2E_BIN:-$dsh_home/runtime/node_modules/.bin/dsh}"

if [[ ! -x "$dsh_bin" ]]; then
  echo "DSH runtime is missing: $dsh_bin" >&2
  echo "Set DSH_E2E_BIN to an installed dsh executable." >&2
  exit 2
fi

if [[ ! -f "$profile_dir/package.json" ]]; then
  echo "todo-stack e2e profile is missing: $profile_dir" >&2
  echo "Create the dedicated test-todo-stack profile before running this workflow." >&2
  exit 2
fi

linked_plugin="$(readlink -f "$profile_dir/node_modules/dsh-plugin-todo-stack" 2>/dev/null || true)"
if [[ "$linked_plugin" != "$project_dir" ]]; then
  echo "test-todo-stack profile is not linked to this checkout" >&2
  echo "expected: $project_dir" >&2
  echo "actual:   ${linked_plugin:-missing}" >&2
  exit 2
fi

log_file="$(mktemp -t todo-stack-e2e.XXXXXX.log)"
cleanup() {
  rm -f "$log_file"
}
trap cleanup EXIT

set +e
DSH_TOOLS_MODE=native \
TODO_STACK_E2E_ARTIFACT_DIR="$project_dir/.tmp" \
timeout 1200s "$dsh_bin" \
  --profile test-todo-stack \
  --patch "$project_dir/e2e/cordis.patch.yml" \
  "todo-stack e2e smoke" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

if [[ $status -ne 0 ]]; then
  echo "todo-stack e2e command failed with exit $status" >&2
  exit "$status"
fi

if ! grep -q '^E2E_RESULT=PASS$' "$log_file"; then
  echo "todo-stack e2e exited without the PASS marker" >&2
  exit 1
fi
