#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
deployment_commit="${2:-}"
deployment_dir="${BLACK_CLOUD_DEPLOYMENT_DIR:-/opt/black-terminal/black-cloud}"
environment_file="${BLACK_CLOUD_ENV_FILE:-/etc/black-terminal/black-cloud-node01.env}"
compose_file="$deployment_dir/docker-compose.black-cloud.yml"

fail() {
  printf 'FAIL %s\n' "$1" >&2
  exit 1
}

[[ "$action" == "build" || "$action" == "deploy" || "$action" == "rollback" ]] || fail "usage: $0 build|deploy|rollback <git-commit>"
[[ "$deployment_commit" =~ ^[a-fA-F0-9]{7,40}$ ]] || fail "a 7-40 character Git commit is required"

"$deployment_dir/scripts/black-cloud-node-preflight.sh" "$deployment_dir" "$environment_file"
actual_commit="$(git -C "$deployment_dir" rev-parse HEAD)"
[[ "$actual_commit" == "$deployment_commit" || "$actual_commit" == "$deployment_commit"* ]] || fail "checkout commit $actual_commit does not match requested commit $deployment_commit"

image_reference="black-terminal-black-cloud:${deployment_commit:0:7}"

if [[ "$action" == "build" ]]; then
  docker run --rm --read-only --tmpfs /work:rw,nosuid,size=2g --tmpfs /tmp:rw,noexec,nosuid,size=512m \
    --env HOME=/tmp --env npm_config_cache=/tmp/npm-cache \
    --volume "$deployment_dir:/source:ro" --workdir /work node:22.23.1-bookworm-slim \
    bash -lc 'cp -a /source/. /work/app && cd /work/app && npm ci && npm run test:phase5-chapter2 && npm run test:black-cloud-production && npm run security:contracts && npm run security:verify-migration-source'
  docker build --pull --file "$deployment_dir/Dockerfile.black-cloud" \
    --build-arg "BLACK_CLOUD_DEPLOYMENT_COMMIT=$actual_commit" \
    --tag "$image_reference" --tag black-terminal-black-cloud:production "$deployment_dir"
  image_digest="$(docker image inspect "$image_reference" --format '{{.Id}}')"
  printf 'BUILD COMPLETE image=%s digest=%s\n' "$image_reference" "$image_digest"
  printf 'Set BLACK_CLOUD_IMAGE_REFERENCE=%s and BLACK_CLOUD_IMAGE_DIGEST=%s in %s, without placing secrets in shell history.\n' "$image_reference" "$image_digest" "$environment_file"
  exit 0
fi

grep -Fxq "BLACK_CLOUD_DEPLOYMENT_COMMIT=$deployment_commit" "$environment_file" || grep -Fxq "BLACK_CLOUD_DEPLOYMENT_COMMIT=$actual_commit" "$environment_file" || fail "environment commit does not match deployment"
grep -Fxq "BLACK_CLOUD_IMAGE_REFERENCE=$image_reference" "$environment_file" || fail "environment image reference does not match immutable commit tag"
expected_digest="$(docker image inspect "$image_reference" --format '{{.Id}}')"
grep -Fxq "BLACK_CLOUD_IMAGE_DIGEST=$expected_digest" "$environment_file" || fail "environment image digest does not match the local immutable image"

export BLACK_CLOUD_ENV_FILE="$environment_file"
export BLACK_CLOUD_IMAGE_REFERENCE="$image_reference"
docker compose --env-file "$environment_file" --file "$compose_file" config --quiet

if [[ "$action" == "rollback" ]]; then
  printf 'ROLLBACK target=%s digest=%s\n' "$image_reference" "$expected_digest"
fi

docker compose --env-file "$environment_file" --file "$compose_file" stop --timeout 45 black-cloud-worker || true
docker compose --env-file "$environment_file" --file "$compose_file" up --detach --no-build --pull never black-cloud-worker
docker compose --env-file "$environment_file" --file "$compose_file" ps
curl --fail --silent --show-error http://127.0.0.1:8080/health/live
curl --fail --silent --show-error http://127.0.0.1:8080/health/ready
curl --fail --silent --show-error http://127.0.0.1:8080/metrics | grep '^black_cloud_worker_ready '
