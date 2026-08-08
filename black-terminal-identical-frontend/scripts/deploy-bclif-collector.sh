#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
requested_commit="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
default_deployment_dir="$(cd "$script_dir/.." && pwd -P)"
deployment_dir="${BCLIF_DEPLOYMENT_DIR:-$default_deployment_dir}"
environment_file="${BCLIF_ENV_FILE:-/etc/black-terminal/liquidation-intelligence.env}"
compose_file="$deployment_dir/docker-compose.liquidation-intelligence.yml"
service_name="bclif-collector"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  deploy-bclif-collector.sh build <full-git-commit>
  deploy-bclif-collector.sh deploy <full-git-commit>
  deploy-bclif-collector.sh rollback <full-git-commit>
  deploy-bclif-collector.sh status
  deploy-bclif-collector.sh drain
  deploy-bclif-collector.sh restart
  deploy-bclif-collector.sh certify

Environment:
  BCLIF_DEPLOYMENT_DIR       immutable Git checkout (default: script checkout)
  BCLIF_ENV_FILE             root-owned mode-600 runtime environment file
  BCLIF_IMAGE_REPOSITORY     registry/name without a tag (default: black-terminal-bclif)
  BCLIF_BUILD_PLATFORMS      one or more of linux/amd64,linux/arm64
  BCLIF_MULTIARCH_PUSH=1     required for a comma-separated multi-architecture build

This script never applies Supabase migrations.
USAGE
  exit 2
}

read_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$environment_file"
}

require_full_commit() {
  [[ "$requested_commit" =~ ^[a-fA-F0-9]{40}$ ]] || fail "a full 40-character Git commit is required for $action"
  local actual_commit
  actual_commit="$(git -C "$deployment_dir" rev-parse HEAD)"
  [[ "$actual_commit" == "$requested_commit" ]] \
    || fail "checkout commit $actual_commit does not match requested commit $requested_commit"
}

assert_platforms() {
  local raw="$1"
  local entry
  IFS=',' read -r -a platform_entries <<<"$raw"
  (( ${#platform_entries[@]} >= 1 && ${#platform_entries[@]} <= 2 )) || fail "one or two build platforms are allowed"
  for entry in "${platform_entries[@]}"; do
    [[ "$entry" == "linux/amd64" || "$entry" == "linux/arm64" ]] || fail "unsupported build platform: $entry"
  done
}

configure_compose_environment() {
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
}

compose() {
  docker compose --env-file "$environment_file" --file "$compose_file" "$@"
}

verify_immutable_artifact() {
  local expected_reference expected_digest expected_commit actual_digest image_revision repo_digests pulled_id
  expected_reference="$BCLIF_IMAGE_REFERENCE"
  expected_digest="$BCLIF_IMAGE_DIGEST"
  expected_commit="$BCLIF_DEPLOYMENT_COMMIT"
  [[ "$expected_commit" =~ ^[a-fA-F0-9]{40}$ ]] || fail "environment deployment commit is not a full Git commit"
  [[ "$expected_digest" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || fail "environment image digest is invalid"
  [[ "$expected_reference" == *":$expected_commit" ]] || fail "image reference must use the full immutable commit as its tag"
  if ! docker image inspect "$expected_reference" >/dev/null 2>&1; then
    printf 'PULL immutable-image=%s digest=%s\n' "$expected_reference" "$expected_digest"
    docker pull "${expected_reference}@${expected_digest}" \
      || fail "immutable image is neither local nor retrievable by its exact digest"
    pulled_id="$(docker image inspect "${expected_reference}@${expected_digest}" --format '{{.Id}}')"
    docker image tag "$pulled_id" "$expected_reference"
  fi
  actual_digest="$(docker image inspect "$expected_reference" --format '{{.Id}}')"
  repo_digests="$(docker image inspect "$expected_reference" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
  if [[ "$actual_digest" != "$expected_digest" ]] && ! grep -Fq "@$expected_digest" <<<"$repo_digests"; then
    printf 'REFRESH immutable-image=%s digest=%s\n' "$expected_reference" "$expected_digest"
    docker pull "${expected_reference}@${expected_digest}" \
      || fail "local artifact differs and the exact configured digest could not be retrieved"
    pulled_id="$(docker image inspect "${expected_reference}@${expected_digest}" --format '{{.Id}}')"
    docker image tag "$pulled_id" "$expected_reference"
    actual_digest="$(docker image inspect "$expected_reference" --format '{{.Id}}')"
    repo_digests="$(docker image inspect "$expected_reference" --format '{{range .RepoDigests}}{{println .}}{{end}}')"
    if [[ "$actual_digest" != "$expected_digest" ]] && ! grep -Fq "@$expected_digest" <<<"$repo_digests"; then
      fail "local image/config digest and repository manifest do not match environment digest $expected_digest"
    fi
  fi
  image_revision="$(docker image inspect "$expected_reference" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "$image_revision" == "$expected_commit" ]] \
    || fail "image revision $image_revision does not match environment commit $expected_commit"
}

verify_running_artifact() {
  local container_id actual_reference expected_image_id actual_image_id actual_revision running
  container_id="$(compose ps --quiet "$service_name")"
  [[ -n "$container_id" ]] || fail "collector container is not running"
  running="$(docker inspect "$container_id" --format '{{.State.Running}}')"
  [[ "$running" == "true" ]] || fail "collector container is not in the running state"
  actual_reference="$(docker inspect "$container_id" --format '{{.Config.Image}}')"
  [[ "$actual_reference" == "$BCLIF_IMAGE_REFERENCE" ]] \
    || fail "running container image reference $actual_reference does not match $BCLIF_IMAGE_REFERENCE"
  expected_image_id="$(docker image inspect "$BCLIF_IMAGE_REFERENCE" --format '{{.Id}}')"
  actual_image_id="$(docker inspect "$container_id" --format '{{.Image}}')"
  [[ "$actual_image_id" == "$expected_image_id" ]] \
    || fail "running container image ID $actual_image_id does not match verified image ID $expected_image_id"
  actual_revision="$(docker inspect "$container_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  [[ "$actual_revision" == "$BCLIF_DEPLOYMENT_COMMIT" ]] \
    || fail "running container revision $actual_revision does not match $BCLIF_DEPLOYMENT_COMMIT"
}

wait_for_ready() {
  local timeout_seconds deadline health_url
  timeout_seconds="${BCLIF_READY_TIMEOUT_SECONDS:-300}"
  [[ "$timeout_seconds" =~ ^[0-9]+$ && "$timeout_seconds" -ge 10 && "$timeout_seconds" -le 1800 ]] \
    || fail "BCLIF_READY_TIMEOUT_SECONDS must be an integer from 10 through 1800"
  deadline=$(( $(date +%s) + timeout_seconds ))
  health_url="http://127.0.0.1:${BCLIF_HOST_HEALTH_PORT}"
  until curl --fail --silent --show-error "$health_url/health/ready"; do
    (( $(date +%s) < deadline )) || fail "collector did not become ready within ${timeout_seconds}s"
    sleep 2
  done
  printf '\n'
  curl --fail --silent --show-error "$health_url/health/live"
  printf '\n'
  curl --fail --silent --show-error "$health_url/metrics" | grep -E '^(bclif_collector_started|bclif_collector_uptime_seconds|bclif_node_heartbeat_age_seconds) '
}

[[ -n "$action" ]] || usage
case "$action" in
  build)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" build-only
    require_full_commit
    case "$(uname -m)" in
      x86_64) default_platform="linux/amd64" ;;
      aarch64) default_platform="linux/arm64" ;;
      *) fail "unsupported build host architecture" ;;
    esac
    build_platforms="${BCLIF_BUILD_PLATFORMS:-$default_platform}"
    assert_platforms "$build_platforms"
    image_repository="${BCLIF_IMAGE_REPOSITORY:-black-terminal-bclif}"
    [[ "$image_repository" =~ ^[A-Za-z0-9._/:~-]+$ ]] || fail "BCLIF_IMAGE_REPOSITORY contains unsupported characters"
    image_reference="${image_repository}:${requested_commit}"
    if [[ "$build_platforms" == *,* ]]; then
      [[ "${BCLIF_MULTIARCH_PUSH:-0}" == "1" ]] \
        || fail "multi-architecture output requires BCLIF_MULTIARCH_PUSH=1 and a writable registry repository"
      docker buildx build --pull --platform "$build_platforms" --push \
        --file "$deployment_dir/Dockerfile.liquidation-intelligence" \
        --build-arg "BCLIF_DEPLOYMENT_COMMIT=$requested_commit" \
        --tag "$image_reference" "$deployment_dir"
      image_digest="$(docker buildx imagetools inspect "$image_reference" | awk '$1 == "Digest:" { print $2; exit }')"
      [[ "$image_digest" =~ ^sha256:[a-fA-F0-9]{64}$ ]] || fail "unable to resolve the pushed multi-architecture manifest digest"
      printf 'BUILD COMPLETE platforms=%s image=%s manifest-digest=%s migration-action=NOT_RUN\n' \
        "$build_platforms" "$image_reference" "$image_digest"
    else
      docker buildx build --pull --platform "$build_platforms" --load \
        --file "$deployment_dir/Dockerfile.liquidation-intelligence" \
        --build-arg "BCLIF_DEPLOYMENT_COMMIT=$requested_commit" \
        --tag "$image_reference" "$deployment_dir"
      image_digest="$(docker image inspect "$image_reference" --format '{{.Id}}')"
      printf 'BUILD COMPLETE platform=%s image=%s digest=%s migration-action=NOT_RUN\n' \
        "$build_platforms" "$image_reference" "$image_digest"
    fi
    printf 'Set BCLIF_DEPLOYMENT_COMMIT=%s, BCLIF_IMAGE_REFERENCE=%s and BCLIF_IMAGE_DIGEST=%s in %s.\n' \
      "$requested_commit" "$image_reference" "$image_digest" "$environment_file"
    ;;
  deploy|rollback)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" host
    require_full_commit
    configure_compose_environment
    [[ "$BCLIF_DEPLOYMENT_COMMIT" == "$requested_commit" ]] \
      || fail "environment commit does not match requested $action commit"
    verify_immutable_artifact
    "$deployment_dir/scripts/bclif-collector-certification.sh" "$deployment_dir"
    compose config --quiet
    if [[ "$action" == "rollback" ]]; then
      printf 'ROLLBACK target=%s digest=%s\n' "$BCLIF_IMAGE_REFERENCE" "$BCLIF_IMAGE_DIGEST"
    fi
    compose stop --timeout 60 "$service_name" >/dev/null 2>&1 || true
    compose up --detach --no-build --pull never "$service_name"
    verify_running_artifact
    wait_for_ready
    printf '%s COMPLETE commit=%s image=%s digest=%s migration-action=NOT_RUN\n' \
      "${action^^}" "$BCLIF_DEPLOYMENT_COMMIT" "$BCLIF_IMAGE_REFERENCE" "$BCLIF_IMAGE_DIGEST"
    ;;
  status)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" host
    configure_compose_environment
    verify_immutable_artifact
    compose config --quiet
    compose ps "$service_name"
    verify_running_artifact
    wait_for_ready
    printf 'STATUS PASS commit=%s digest=%s migration-action=NOT_RUN\n' "$BCLIF_DEPLOYMENT_COMMIT" "$BCLIF_IMAGE_DIGEST"
    ;;
  drain)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" host
    configure_compose_environment
    compose config --quiet
    compose stop --timeout 60 "$service_name"
    compose ps --all "$service_name"
    printf 'DRAIN COMPLETE graceful-timeout=60s spool-volume=preserved migration-action=NOT_RUN\n'
    ;;
  restart)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" host
    configure_compose_environment
    verify_immutable_artifact
    compose config --quiet
    compose stop --timeout 60 "$service_name" >/dev/null 2>&1 || true
    compose up --detach --no-build --pull never "$service_name"
    verify_running_artifact
    wait_for_ready
    printf 'RESTART COMPLETE commit=%s digest=%s migration-action=NOT_RUN\n' "$BCLIF_DEPLOYMENT_COMMIT" "$BCLIF_IMAGE_DIGEST"
    ;;
  certify)
    "$deployment_dir/scripts/bclif-collector-preflight.sh" "$deployment_dir" "$environment_file" host
    configure_compose_environment
    verify_immutable_artifact
    "$deployment_dir/scripts/bclif-collector-certification.sh" "$deployment_dir"
    compose config --quiet
    verify_running_artifact
    wait_for_ready
    printf 'CERTIFY PASS repository=yes runtime=yes visual=yes migration-action=NOT_RUN\n'
    ;;
  *) usage ;;
esac
