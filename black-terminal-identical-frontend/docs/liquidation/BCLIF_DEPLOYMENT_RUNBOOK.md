# BCLIF Deployment Runbook

## Current boundary

The target is a dedicated Linux analytics host named `LIQUIDATION_INTELLIGENCE_NODE_01` or `IMM_NODE_01`. Never deploy this workload to the Black Cloud execution node, its Raspberry Pi, Vercel functions, or a user browser. No analytics host was provided for Chapter III-C, Docker tooling is unavailable on the development workstation, both BCLIF migrations remain unapplied, and the visual baselines are stale. The repository is packaged but not deployable through the formal gate until the visual result is a real `PASS`.

## Host prerequisites

- Linux amd64 or arm64, Docker Engine with Compose and Buildx, synchronized UTC/NTP, restricted firewall, and enough measured CPU, RAM and disk for the selected symbol count.
- Node 22 and installed development dependencies (`npm ci`) for formal repository certification.
- A clean `main` checkout (or detached immutable commit) on local storage. Production must not mount the source tree into the container.
- A root-owned mode-600 file at `/etc/black-terminal/liquidation-intelligence.env`, copied from `.env.liquidation-intelligence.example` and with every placeholder replaced.
- Only the Supabase URL/service-role credential and public-market collector settings. Broker credentials, exchange private keys, execution vault material, and Black Cloud variables are forbidden.
- Private `bclif-field-chunks` storage plus the reviewed database schema. Do not activate the collector against a partially migrated database.

The preflight requires `BCLIF_HOST_ROLE=LIQUIDATION_INTELLIGENCE` and refuses a Raspberry Pi/Black Cloud identity, a dirty checkout, an unsupported architecture, missing NTP, placeholder artifact identities, weak environment-file ownership/mode, and forbidden execution secrets. Health is published only on host loopback `127.0.0.1:8091`; inspect it locally or through an authenticated SSH tunnel and never expose it publicly.

## Repository and image gates

From the immutable checkout:

```bash
npm ci
commit="$(git rev-parse HEAD)"
scripts/bclif-collector-preflight.sh "$PWD" /etc/black-terminal/liquidation-intelligence.env build-only
scripts/deploy-bclif-collector.sh build "$commit"
```

The build prints the commit-tagged image reference and digest. A local single-platform build reports the local image/config digest; a pushed multi-architecture build reports the manifest digest. Record the exact printed values as `BCLIF_DEPLOYMENT_COMMIT`, `BCLIF_IMAGE_REFERENCE`, and `BCLIF_IMAGE_DIGEST` in the root-owned environment file.

An amd64+arm64 build requires a writable registry and:

```bash
BCLIF_BUILD_PLATFORMS=linux/amd64,linux/arm64 \
BCLIF_MULTIARCH_PUSH=1 \
BCLIF_IMAGE_REPOSITORY=registry.example/black-terminal-bclif \
scripts/deploy-bclif-collector.sh build "$commit"
```

Multi-architecture support in the script is not evidence that either image has been exercised.

Formal certification requires a clean commit and runs frontend/collector TypeScript, the production build and secret audit, model/API/migration/client/collector/order-book/recovery/codec/no-lookahead/benchmark contracts, security migration-source checks, Compose validation, and the visual comparison. `SKIP` is deliberately non-passing. With the current stale visual baselines, `deploy` and `certify` stop before mutating the running container.

Repository-owned command aliases are available for every collector gate and operation. Commands that require a commit receive it after npm's `--` separator:

```bash
npm run test:bclif-collector-contracts
npm run benchmark:bclif-collector
npm run test:bclif-visual          # currently returns SKIP, never PASS
npm run bclif:preflight -- "$PWD" /etc/black-terminal/liquidation-intelligence.env build-only
npm run bclif:build -- "$commit"
npm run bclif:deploy -- "$commit"
npm run bclif:status
npm run bclif:drain
npm run bclif:restart
npm run bclif:rollback -- <full-40-character-target-commit>
npm run bclif:certify
npm run bclif:soak -- 1h
```

`bclif:collector` is the daemon entry point used by the image. Starting it in a developer shell is not deployment evidence and requires the same reviewed service-only configuration and activated schema as the container.

## Database activation gate

Container rollback and database rollback are separate operations. Before applying either migration:

1. Assign a rollback owner, record the Supabase project/ref, and create a provider-supported point-in-time or verified logical backup. Record its recovery identifier outside the repository and test restoration in staging.
2. Apply and verify, in order, `202608050001_bclif_liquidation_intelligence_foundation.sql` and `202608050002_bclif_persistent_market_memory.sql` in staging.
3. Run runtime RLS tests as anonymous, authenticated, and service roles; verify the bucket is private; test allowed and denied object operations; exercise protected routes with and without indicator entitlement; and run a checkpoint/tile write-read-delete rehearsal.
4. Repeat against production only after rollback approval, then record migration versions and timestamps.
5. If verification or a partial migration fails, stop the collector and restore the recorded database/storage recovery point. Do not improvise a destructive down migration and do not use container rollback as a substitute for database recovery.

Chapter III-C performed source/static contract checks only. It did not apply either migration, create a backup, or run database/storage policies against a live project.

## Deploy and operate

After migrations, reviewed visual goldens, and every certification gate pass:

```bash
commit="$(git rev-parse HEAD)"
scripts/deploy-bclif-collector.sh deploy "$commit"
scripts/deploy-bclif-collector.sh status
scripts/deploy-bclif-collector.sh restart
scripts/deploy-bclif-collector.sh drain
scripts/deploy-bclif-collector.sh certify
scripts/bclif-collector-soak.sh 1h
```

`deploy`, `restart`, and `status` verify the exact revision label and image/registry digest. If the configured exact image is absent, the script may retrieve that tag at the exact digest and retag it locally before `pull_policy: never` Compose start; `status` is therefore a verification/reconciliation action, not guaranteed network-read-only inspection.

Readiness must show the active fenced instance, recovered checkpoint/state, acknowledged sources, current live OI, valid book snapshot, a produced causal frame, object storage, and safe clock. Then verify protected coverage/manifest/tile access from an entitled client and denial from an unentitled client.

Use `scripts/bclif-collector-soak.sh 1h`, then `6h`, then `24h`; each report records exact elapsed time and fails incomplete duration. Do not promote a shorter run to a longer claim. A zero-hour result remains `NOT RUN`.

## Drain, spool, restart, and rollback

The durable local spool is the named Docker volume `black-terminal-bclif-spool`. `drain` and normal replacement preserve it. Never use `docker compose down --volumes` or delete that volume during routine deployment. Before a host move, inspect/snapshot the volume with the host's approved backup mechanism, preserve its mode/ownership for container UID/GID `10001`, and restore it before starting the replacement instance. A new writer still must acquire a higher database fencing epoch; spool ownership never grants authority.

For an application rollback, prepare a clean checkout at the reviewed target commit, build or retrieve the target commit-tagged image by its exact digest, update the three immutable artifact values in the environment file, and run:

```bash
scripts/deploy-bclif-collector.sh rollback <full-40-character-target-commit>
```

The script performs a graceful 60-second stop, preserves the spool volume, verifies the target artifact, starts without building or using an unverified tag, and waits for readiness. If the previous release changed the database contract incompatibly, first execute the separately approved database recovery plan. Never point an older collector at an unreviewed newer schema.

After any restart/rollback, verify no dedup/source-offset regression, no duplicate finalized tile, checkpoint checksum/replay continuity, one active lease/fence, and truthful coverage. Complete 3W status requires three weeks of verified continuous source intervals or truly equivalent supported historical inputs; process uptime alone is not coverage.
