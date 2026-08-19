#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile_dir="${DSH_HOME:-/home/vilicvane/.dsh}/profiles/test-todo-stack"

if [[ ! -f "$profile_dir/package.json" ]]; then
  echo "todo-stack e2e profile is missing: $profile_dir" >&2
  exit 2
fi

linked_plugin="$(readlink -f "$profile_dir/node_modules/dsh-plugin-todo-stack" 2>/dev/null || true)"
if [[ "$linked_plugin" != "$project_dir" ]]; then
  echo "test-todo-stack profile is not linked to this checkout" >&2
  echo "expected: $project_dir" >&2
  echo "actual:   ${linked_plugin:-missing}" >&2
  exit 2
fi

log_file="$(mktemp -t todo-stack-prompt-eval.XXXXXX.log)"
cleanup() {
  rm -f "$log_file"
}
trap cleanup EXIT

set +e
DSH_TOOLS_MODE=native \
TODO_STACK_PROMPT_EVAL_ARTIFACT_DIR="$project_dir/.tmp" \
timeout "${TODO_STACK_PROMPT_EVAL_TIMEOUT_SECONDS:-1200}s" npx --yes @deepseek-ai/dsh@0.1.0-rc.7 \
  --profile test-todo-stack \
  --patch "$project_dir/e2e/prompt-eval.patch.yml" \
  "todo-stack production prompt evaluation" 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

if [[ $status -ne 0 ]]; then
  echo "todo-stack prompt evaluation failed with exit $status" >&2
  exit "$status"
fi

if ! grep -q '^PROMPT_EVAL_RESULT=PASS$' "$log_file"; then
  echo "todo-stack prompt evaluation exited without the PASS marker" >&2
  exit 1
fi
