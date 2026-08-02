# Black Cloud Deployment and Rollback

## Pre-deployment

1. Confirm the approved commit is on `origin/main` and the VPS checkout is clean.
2. Confirm Supabase migrations II-B, II-C and II-D are applied once in ledger order.
3. Confirm the mode-600 root environment file contains names from the production manifest.
4. Run preflight and the containerized regression suite using `deploy-black-cloud-node01.sh build <COMMIT>`.
5. Record the commit-tagged image and `sha256:` image ID.
6. Update the environment file securely; never pass secrets in shell history.

## Deploy

```bash
sudo BLACK_CLOUD_DEPLOYMENT_DIR=/opt/black-terminal/black-cloud BLACK_CLOUD_ENV_FILE=/etc/black-terminal/black-cloud-node01.env /opt/black-terminal/black-cloud/scripts/deploy-black-cloud-node01.sh deploy <COMMIT>
```

The script validates the checkout, secret-file ownership, NTP, exact commit, exact image reference and exact digest. It gracefully stops the old container, deploys without building or pulling, then verifies liveness, readiness and metrics.

## Post-deployment

Record the node/instance IDs, commit, digest, startup time, crypto result, clock state, heartbeat, container health, lease state and reconciliation state. A successful deployment does not activate Mainnet orders or strategies.

## Rollback

Retain the previous commit-tagged local image. Set the environment file's commit, image reference and digest to that known-good artifact, ensure the repository checkout matches, then run:

```bash
sudo BLACK_CLOUD_DEPLOYMENT_DIR=/opt/black-terminal/black-cloud BLACK_CLOUD_ENV_FILE=/etc/black-terminal/black-cloud-node01.env /opt/black-terminal/black-cloud/scripts/deploy-black-cloud-node01.sh rollback <PREVIOUS_COMMIT>
```

Do not destructively roll back Supabase migrations. If the old binary is incompatible with an additive migration, deploy a forward compatibility fix. Reconcile every account before resuming new automated entries.
