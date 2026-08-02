# Black Cloud Single-VPS Deployment

## Scope and present boundary

The existing VPS is the only authorized execution host and will be registered as `BLACK_CLOUD_NODE_01`. Vercel remains the frontend/control API plane and Supabase remains the durable state and coordination plane. The worker is not deployed to Vercel, a browser, a workstation, or a second VPS.

The repository-side deployment package is ready. Remote deployment is **not certified** until an operator supplies a reachable VPS address, SSH username, SSH port, and an SSH public-key identity. No usable destination or identity was discoverable in the current Codex environment.

## Topology

```text
black-terminal.live (Vercel)
        |
        v
Supabase auth, durable queue, leases, audit and encrypted envelopes
        |
        v
existing VPS / BLACK_CLOUD_NODE_01
        |
        v
Bybit Demo or Bybit Mainnet Live
```

The single container owns persistent Bybit private streams, reconciliation, durable command consumption, leases/fencing, health and metrics. It does not expose an inbound order-submission API.

## Required remote-access tuple

- `VPS_HOST`: existing VPS public DNS name or IP.
- `VPS_SSH_USER`: key-authenticated deployment administrator.
- `VPS_SSH_PORT`: confirmed SSH port; do not assume 22 if customized.
- SSH identity: private key available locally or loaded into `ssh-agent`; never paste its contents into Git or documentation.
- `sudo` access for `/opt/black-terminal` and `/etc/black-terminal` preparation.

Connectivity check:

```bash
ssh -p <VPS_SSH_PORT> <VPS_SSH_USER>@<VPS_HOST> 'uname -a; id; hostnamectl'
```

Expected: Linux host facts and the selected non-root administrator identity. Authentication failure, an unverified host key, or an unexpected host must stop the deployment.

## Production directory and secret file

```bash
sudo install -d -o root -g blackcloud -m 0750 /opt/black-terminal/black-cloud
sudo install -d -o root -g blackcloud -m 0750 /etc/black-terminal
sudo install -o root -g root -m 0600 /dev/null /etc/black-terminal/black-cloud-node01.env
```

Populate the environment file through the host's secure administrative editor. Do not pass secrets as command-line arguments. Use [.env.black-cloud.example](../../.env.black-cloud.example) as the name-only manifest.

## Deployment sequence

Run on the existing VPS after the final commit is on `main`:

```bash
cd /opt/black-terminal/black-cloud
git fetch origin main
git merge --ff-only origin/main
git status --short --branch
git rev-parse HEAD
sudo ./scripts/black-cloud-node-preflight.sh "$PWD" /etc/black-terminal/black-cloud-node01.env
sudo BLACK_CLOUD_DEPLOYMENT_DIR="$PWD" BLACK_CLOUD_ENV_FILE=/etc/black-terminal/black-cloud-node01.env ./scripts/deploy-black-cloud-node01.sh build <FINAL_COMMIT>
```

Expected build result:

```text
BUILD COMPLETE image=black-terminal-black-cloud:<7-char-commit> digest=sha256:<64-hex>
```

Update only `BLACK_CLOUD_IMAGE_REFERENCE`, `BLACK_CLOUD_IMAGE_DIGEST`, and `BLACK_CLOUD_DEPLOYMENT_COMMIT` in the mode-600 environment file, then deploy:

```bash
sudo BLACK_CLOUD_DEPLOYMENT_DIR="$PWD" BLACK_CLOUD_ENV_FILE=/etc/black-terminal/black-cloud-node01.env ./scripts/deploy-black-cloud-node01.sh deploy <FINAL_COMMIT>
```

Expected: Compose reports `black-cloud-node-01` running and healthy; `/health/live` returns HTTP 200; `/health/ready` returns HTTP 200 only after config, crypto, schema, lease, queue and clock checks pass; the metrics output contains `black_cloud_worker_ready 1`.

## Verification

```bash
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
curl --fail http://127.0.0.1:8080/metrics | grep '^black_cloud_'
sudo docker inspect black-cloud-node-01 --format '{{.Config.Image}} {{.Image}} {{.State.Health.Status}}'
sudo docker compose --env-file /etc/black-terminal/black-cloud-node01.env -f /opt/black-terminal/black-cloud/docker-compose.black-cloud.yml ps
```

The host firewall must not expose 8080 publicly. External order certification is a separate, explicitly authorized workflow; deployment alone never authorizes an order.

## Acceptance limitation

A running container proves infrastructure only. Browser-offline execution, VPS reboot recovery, private stream authentication, reconciliation, lease loss, protection, resource capacity, and any Demo/Mainnet order lifecycle remain `NOT TESTED` until executed on the actual VPS with a user-selected connection and explicit order authorization.
