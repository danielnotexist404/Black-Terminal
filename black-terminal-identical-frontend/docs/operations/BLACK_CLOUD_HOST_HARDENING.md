# Black Cloud Host Hardening

Host changes must follow read-only discovery and the actual operating system. The commands below are Debian/Ubuntu examples, not evidence of the unknown existing VPS configuration.

## Baseline

```bash
uname -a
cat /etc/os-release
uname -m
timedatectl status
df -h
free -h
docker version
docker compose version
ss -lntup
```

Expected: 64-bit Linux (`x86_64` or `aarch64`), synchronized time, sufficient measured capacity, Docker Engine and Compose available, and no public worker port.

## Least privilege

Create a system deployment group/user only after confirming it does not already exist:

```bash
sudo adduser --system --group --home /opt/black-terminal blackcloud
sudo install -d -o root -g blackcloud -m 0750 /opt/black-terminal/black-cloud /etc/black-terminal
```

The container runs as the Node image's non-root `node` user, with a read-only filesystem, all Linux capabilities dropped, `no-new-privileges`, no host networking, no privileged mode, and no Docker socket.

## SSH

Confirm working key authentication and an out-of-band recovery path before editing `sshd_config`. Then require public-key authentication, disable password authentication and direct root login, and restrict inbound SSH to trusted source ranges where practical. Validate configuration with `sudo sshd -t` before reload. Document only host alias, username, port and public-key fingerprint.

## Firewall and time

The worker requires outbound HTTPS/WSS to the configured Supabase project and approved Bybit endpoints. Inbound worker access is unnecessary. Allow the confirmed SSH port, keep 8080/9090 private, and verify NTP using `timedatectl show -p NTPSynchronized --value`.

## Updates, disk and logs

Use the OS-supported update process during an approved maintenance window. Docker JSON logs are limited to five 10 MB files. Monitor Docker storage and root filesystem usage. No local disk is the authoritative copy of orders, fills, mandates, strategy state, credential envelopes or audit events; those remain in Supabase. Decrypted broker credentials are never written to disk.
