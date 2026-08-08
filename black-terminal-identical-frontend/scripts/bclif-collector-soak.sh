#!/usr/bin/env bash
set -euo pipefail

duration_input="${1:-${BCLIF_SOAK_DURATION_SECONDS:-3600}}"
sample_interval_seconds="${BCLIF_SOAK_SAMPLE_INTERVAL_SECONDS:-60}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_dir="${BCLIF_DEPLOYMENT_DIR:-$(cd "$script_dir/.." && pwd -P)}"
environment_file="${BCLIF_ENV_FILE:-/etc/black-terminal/liquidation-intelligence.env}"
compose_file="$repository_dir/docker-compose.liquidation-intelligence.yml"
container_name="bclif-collector"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$environment_file"
}

case "$duration_input" in
  1h) requested_duration_seconds=3600 ;;
  6h) requested_duration_seconds=21600 ;;
  24h) requested_duration_seconds=86400 ;;
  *) requested_duration_seconds="$duration_input" ;;
esac
[[ "$requested_duration_seconds" =~ ^[0-9]+$ ]] \
  || fail "duration must be an integer number of seconds or one of 1h, 6h, 24h"
(( requested_duration_seconds >= 10 && requested_duration_seconds <= 172800 )) \
  || fail "duration must be from 10 through 172800 seconds"
[[ "$sample_interval_seconds" =~ ^[0-9]+$ ]] \
  || fail "BCLIF_SOAK_SAMPLE_INTERVAL_SECONDS must be an integer"
(( sample_interval_seconds >= 2 && sample_interval_seconds <= 300 )) \
  || fail "sample interval must be from 2 through 300 seconds"

for command_name in curl docker node awk date mkdir mktemp; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required soak command missing: $command_name"
done

"$repository_dir/scripts/bclif-collector-preflight.sh" "$repository_dir" "$environment_file" host

export BCLIF_ENV_FILE="$environment_file"
export BCLIF_IMAGE_REFERENCE="$(read_env_value BCLIF_IMAGE_REFERENCE)"
export BCLIF_IMAGE_DIGEST="$(read_env_value BCLIF_IMAGE_DIGEST)"
export BCLIF_DEPLOYMENT_COMMIT="$(read_env_value BCLIF_DEPLOYMENT_COMMIT)"
export BCLIF_HOST_HEALTH_PORT="$(read_env_value BCLIF_HOST_HEALTH_PORT)"
export BCLIF_MEMORY_LIMIT="$(read_env_value BCLIF_MEMORY_LIMIT)"
export BCLIF_CPU_LIMIT="$(read_env_value BCLIF_CPU_LIMIT)"
BCLIF_HOST_HEALTH_PORT="${BCLIF_HOST_HEALTH_PORT:-8091}"
BCLIF_MEMORY_LIMIT="${BCLIF_MEMORY_LIMIT:-2g}"
BCLIF_CPU_LIMIT="${BCLIF_CPU_LIMIT:-2.0}"
export BCLIF_HOST_HEALTH_PORT BCLIF_MEMORY_LIMIT BCLIF_CPU_LIMIT

docker compose --env-file "$environment_file" --file "$compose_file" config --quiet
running="$(docker inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null || true)"
[[ "$running" == "true" ]] || fail "collector container is not running"

health_url="http://127.0.0.1:${BCLIF_HOST_HEALTH_PORT}"
temporary_dir="$(mktemp -d -t bclif-soak.XXXXXX)"
trap 'rm -rf "$temporary_dir"' EXIT
initial_metrics="$temporary_dir/metrics-initial.prom"
final_metrics="$temporary_dir/metrics-final.prom"
curl --fail --silent --show-error "$health_url/health/ready" >/dev/null \
  || fail "collector is not ready at soak start"
curl --fail --silent --show-error "$health_url/metrics" >"$initial_metrics" \
  || fail "collector metrics are unavailable at soak start"

metric_value() {
  local file="$1"
  local metric="$2"
  awk -v metric="$metric" '$1 == metric { value += $2 } END { printf "%.0f", value + 0 }' "$file"
}

memory_bytes() {
  local raw="$1"
  node -e '
    const match = /^\s*([0-9.]+)\s*([KMGT]?i?B)/i.exec(process.argv[1] || "");
    if (!match) process.exit(2);
    const units = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024**2, GIB: 1024**3, TIB: 1024**4 };
    process.stdout.write(String(Math.round(Number(match[1]) * units[match[2].toUpperCase()])));
  ' "$raw"
}

spool_bytes() {
  docker exec "$container_name" du -sb /var/lib/bclif-spool 2>/dev/null | awk 'NR == 1 { print $1 }'
}

artifact_dir="$repository_dir/tests/.artifacts/bclif"
mkdir -p "$artifact_dir"
started_epoch_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
started_iso="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
sample_log="$artifact_dir/collector-soak-${started_epoch_ms}.jsonl"
report_path="$artifact_dir/collector-soak-${started_epoch_ms}.json"
deadline_epoch_ms=$(( started_epoch_ms + requested_duration_seconds * 1000 ))
health_failures=0
sample_count=0
interrupted=0
initial_restart_count="$(docker inspect "$container_name" --format '{{.RestartCount}}')"
initial_spool_bytes="$(spool_bytes || printf '0')"
initial_memory_raw="$(docker stats --no-stream --format '{{.MemUsage}}' "$container_name")"
initial_memory_bytes="$(memory_bytes "$initial_memory_raw" || printf '0')"
last_memory_raw="$initial_memory_raw"
last_memory_bytes="$initial_memory_bytes"

trap 'interrupted=1' INT TERM
printf 'SOAK START requested-seconds=%s started-at=%s samples=%s report=%s\n' \
  "$requested_duration_seconds" "$started_iso" "$sample_interval_seconds" "$report_path"

while (( $(node -e 'process.stdout.write(String(Date.now()))') < deadline_epoch_ms )); do
  sampled_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  live_ok=true
  ready_ok=true
  metrics_ok=true
  curl --fail --silent --show-error "$health_url/health/live" >"$temporary_dir/live.json" || live_ok=false
  curl --fail --silent --show-error "$health_url/health/ready" >"$temporary_dir/ready.json" || ready_ok=false
  curl --fail --silent --show-error "$health_url/metrics" >"$temporary_dir/metrics-current.prom" || metrics_ok=false
  if [[ "$live_ok" != true || "$ready_ok" != true || "$metrics_ok" != true ]]; then
    health_failures=$(( health_failures + 1 ))
  fi
  last_memory_raw="$(docker stats --no-stream --format '{{.MemUsage}}' "$container_name" 2>/dev/null || printf 'unavailable')"
  last_memory_bytes="$(memory_bytes "$last_memory_raw" 2>/dev/null || printf '0')"
  current_spool_bytes="$(spool_bytes || printf '0')"
  current_restart_count="$(docker inspect "$container_name" --format '{{.RestartCount}}' 2>/dev/null || printf '0')"
  node -e '
    const fs = require("node:fs");
    const [path, sampledAtMs, live, ready, metrics, memoryRaw, memoryBytes, spoolBytes, restarts] = process.argv.slice(1);
    fs.appendFileSync(path, `${JSON.stringify({
      sampledAtMs: Number(sampledAtMs), live: live === "true", ready: ready === "true",
      metrics: metrics === "true", memoryRaw, memoryBytes: Number(memoryBytes),
      spoolBytes: Number(spoolBytes), restartCount: Number(restarts)
    })}\n`, { mode: 0o600 });
  ' "$sample_log" "$sampled_ms" "$live_ok" "$ready_ok" "$metrics_ok" \
    "$last_memory_raw" "$last_memory_bytes" "$current_spool_bytes" "$current_restart_count"
  sample_count=$(( sample_count + 1 ))
  (( interrupted == 0 )) || break
  now_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
  remaining_seconds=$(( (deadline_epoch_ms - now_ms + 999) / 1000 ))
  (( remaining_seconds > 0 )) || break
  sleep_seconds="$sample_interval_seconds"
  (( sleep_seconds <= remaining_seconds )) || sleep_seconds="$remaining_seconds"
  sleep "$sleep_seconds" || true
done

ended_epoch_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
ended_iso="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
exact_duration_ms=$(( ended_epoch_ms - started_epoch_ms ))
curl --fail --silent --show-error "$health_url/metrics" >"$final_metrics" || health_failures=$(( health_failures + 1 ))
final_ready=true
curl --fail --silent --show-error "$health_url/health/ready" >/dev/null || final_ready=false
[[ "$final_ready" == true ]] || health_failures=$(( health_failures + 1 ))
final_restart_count="$(docker inspect "$container_name" --format '{{.RestartCount}}' 2>/dev/null || printf '0')"
final_spool_bytes="$(spool_bytes || printf '0')"

initial_trades="$(metric_value "$initial_metrics" bclif_trade_events_total)"
final_trades="$(metric_value "$final_metrics" bclif_trade_events_total)"
initial_liquidations="$(metric_value "$initial_metrics" bclif_liquidation_events_total)"
final_liquidations="$(metric_value "$final_metrics" bclif_liquidation_events_total)"
initial_duplicates="$(metric_value "$initial_metrics" bclif_deduplicated_events_total)"
final_duplicates="$(metric_value "$final_metrics" bclif_deduplicated_events_total)"
initial_gaps="$(metric_value "$initial_metrics" bclif_source_gaps_total)"
final_gaps="$(metric_value "$final_metrics" bclif_source_gaps_total)"
initial_reconnects="$(metric_value "$initial_metrics" bclif_source_reconnects_total)"
final_reconnects="$(metric_value "$final_metrics" bclif_source_reconnects_total)"
initial_storage_failures="$(metric_value "$initial_metrics" bclif_storage_failures_total)"
final_storage_failures="$(metric_value "$final_metrics" bclif_storage_failures_total)"
initial_checkpoint_failures="$(metric_value "$initial_metrics" bclif_checkpoint_failures_total)"
final_checkpoint_failures="$(metric_value "$final_metrics" bclif_checkpoint_failures_total)"

trade_delta=$(( final_trades - initial_trades ))
liquidation_delta=$(( final_liquidations - initial_liquidations ))
duplicate_delta=$(( final_duplicates - initial_duplicates ))
gap_delta=$(( final_gaps - initial_gaps ))
reconnect_delta=$(( final_reconnects - initial_reconnects ))
storage_failure_delta=$(( final_storage_failures - initial_storage_failures ))
checkpoint_failure_delta=$(( final_checkpoint_failures - initial_checkpoint_failures ))
restart_delta=$(( final_restart_count - initial_restart_count ))
memory_growth_bytes=$(( last_memory_bytes - initial_memory_bytes ))
spool_growth_bytes=$(( final_spool_bytes - initial_spool_bytes ))

decision=PASS
failure_reasons=()
(( interrupted == 0 )) || { decision=FAIL; failure_reasons+=("INTERRUPTED"); }
(( exact_duration_ms >= requested_duration_seconds * 1000 )) || { decision=FAIL; failure_reasons+=("DURATION_INCOMPLETE"); }
(( health_failures == 0 )) || { decision=FAIL; failure_reasons+=("HEALTH_OR_READINESS_FAILURE"); }
(( trade_delta > 0 )) || { decision=FAIL; failure_reasons+=("NO_TRADE_ACCUMULATION"); }
(( gap_delta == 0 )) || { decision=FAIL; failure_reasons+=("SOURCE_GAP_DETECTED"); }
(( storage_failure_delta == 0 )) || { decision=FAIL; failure_reasons+=("STORAGE_FAILURE"); }
(( checkpoint_failure_delta == 0 )) || { decision=FAIL; failure_reasons+=("CHECKPOINT_FAILURE"); }
(( restart_delta == 0 )) || { decision=FAIL; failure_reasons+=("UNEXPECTED_RESTART"); }
failure_csv="$(IFS=,; printf '%s' "${failure_reasons[*]:-}")"

node -e '
  const fs = require("node:fs");
  const values = process.argv.slice(1);
  const [path, decision, reasons, startedAt, endedAt, requestedSeconds, exactMs, samples,
    healthFailures, trades, liquidations, duplicates, gaps, reconnects, storageFailures,
    checkpointFailures, restarts, initialMemory, finalMemory, memoryGrowth, initialSpool,
    finalSpool, spoolGrowth, sampleLog] = values;
  fs.writeFileSync(path, `${JSON.stringify({
    decision, failureReasons: reasons ? reasons.split(",") : [], startedAt, endedAt,
    requestedDurationSeconds: Number(requestedSeconds), exactDurationMs: Number(exactMs),
    sampleCount: Number(samples), healthFailures: Number(healthFailures),
    deltas: { trades: Number(trades), liquidations: Number(liquidations), duplicates: Number(duplicates),
      sourceGaps: Number(gaps), reconnects: Number(reconnects), storageFailures: Number(storageFailures),
      checkpointFailures: Number(checkpointFailures), containerRestarts: Number(restarts) },
    memory: { initialBytes: Number(initialMemory), finalBytes: Number(finalMemory), growthBytes: Number(memoryGrowth) },
    spool: { initialBytes: Number(initialSpool), finalBytes: Number(finalSpool), growthBytes: Number(spoolGrowth) },
    sampleLog, migrationAction: "NOT_RUN"
  }, null, 2)}\n`, { mode: 0o600 });
' "$report_path" "$decision" "$failure_csv" "$started_iso" "$ended_iso" \
  "$requested_duration_seconds" "$exact_duration_ms" "$sample_count" "$health_failures" \
  "$trade_delta" "$liquidation_delta" "$duplicate_delta" "$gap_delta" "$reconnect_delta" \
  "$storage_failure_delta" "$checkpoint_failure_delta" "$restart_delta" \
  "$initial_memory_bytes" "$last_memory_bytes" "$memory_growth_bytes" \
  "$initial_spool_bytes" "$final_spool_bytes" "$spool_growth_bytes" "$sample_log"

printf 'SOAK %s requested-seconds=%s exact-duration-ms=%s samples=%s trades=%s liquidations=%s gaps=%s reconnects=%s memory-growth-bytes=%s spool-growth-bytes=%s migration-action=NOT_RUN report=%s\n' \
  "$decision" "$requested_duration_seconds" "$exact_duration_ms" "$sample_count" "$trade_delta" \
  "$liquidation_delta" "$gap_delta" "$reconnect_delta" "$memory_growth_bytes" "$spool_growth_bytes" "$report_path"
[[ "$decision" == PASS ]] || exit 1
