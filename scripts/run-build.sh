#!/usr/bin/env bash
# Deterministic, no-AI launch script for the PLD data loader pipeline.
#
# Chains: unit tests -> build:data -> validate:data (per variant) -> capture:baseline.
# Everything here is plain Node.js against a fixed input (PLD API scroll, or
# PLD_INPUT_FILE for a frozen fixture) — no LLM calls anywhere in the pipeline.
# Non-determinism is limited to: the snapshot timestamp/ID, extracted_at/captured_at
# wall-clock stamps, node_version, and the live source data itself if PLD_INPUT_FILE
# is unset. Set PLD_SNAPSHOT_ID to pin the snapshot directory name across runs.
#
# All PLD_* env vars are honoured (see scripts/build-data.mjs, validate-data.mjs,
# capture-baseline.mjs). Override as needed before invoking, e.g.:
#   PLD_INPUT_FILE=fixtures/frozen.ndjson ./scripts/run-build.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

log_root="build/logs"
run_id="${PLD_SNAPSHOT_ID:-$(date -u +%Y%m%d%H%M%S)}"
log_dir="${log_root}/${run_id}"
mkdir -p "$log_dir"

step() {
  local name="$1"; shift
  local log_file="${log_dir}/${name}.log"
  echo "==> ${name}"
  if "$@" > >(tee "$log_file") 2> >(tee "${log_file}.err" >&2); then
    echo "==> ${name} OK (log: ${log_file})"
  else
    local status=$?
    echo "==> ${name} FAILED (exit ${status}); see ${log_file} and ${log_file}.err" >&2
    exit "$status"
  fi
}

step "test" npm run test
step "build-data" npm run build:data

variants="${PLD_VARIANTS:-completion-date-all,unit-commencement-losses,root-commencement-losses,unit-root-fallback-losses}"
IFS=',' read -ra variant_list <<< "$variants"
for variant in "${variant_list[@]}"; do
  variant="$(echo "$variant" | xargs)"
  [ -z "$variant" ] && continue
  PLD_VARIANT="$variant" step "validate-data-${variant}" npm run validate:data
done

step "capture-baseline" npm run capture:baseline

echo "==> All steps complete. Logs in ${log_dir}"
