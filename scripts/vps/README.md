# scripts/vps — Uxie VPS runbook

Production deploy of Uxie onto the para-raid VPS. Image is pulled from GHCR
(`ghcr.io/psianion/uxie:latest`), built by `.github/workflows/release.yml` on
git tag `vX.Y.Z`.

## Topology

- VPS host: `para-raid` (alias in `~/.ssh/config`)
- Container: `uxie`, `network_mode: host`, no inbound port
- Outbound-only: Discord gateway + scrypt on loopback (`http://127.0.0.1:3777`)
- Local dev is `bun run dev` against scrypt's own compose — uxie-in-Docker
  locally can't reach scrypt anyway, and `bun --hot` is the better dev loop

## §bootstrap — first-time setup on a fresh VPS

Run once per host. Idempotent: re-running is safe.

```bash
# 1. Compose file
sudo mkdir -p /home/ubuntu/uxie
sudo install -m 0644 -o ubuntu -g ubuntu \
  docker-compose.vps.yml /home/ubuntu/uxie/docker-compose.vps.yml

# 2. Secrets — copy template and fill values
sudo mkdir -p /opt/secrets
sudo install -m 0600 -o ubuntu -g ubuntu \
  scripts/vps/uxie.env.example /opt/secrets/uxie.env
sudo -u ubuntu vi /opt/secrets/uxie.env  # set DISCORD_*, SCRYPT_AUTH

# 3. Update script
sudo install -m 0755 -o ubuntu -g ubuntu \
  scripts/vps/update-uxie.sh /home/ubuntu/bin/update-uxie

# 4. Log directory
sudo mkdir -p /var/log/sup-updates
sudo chown ubuntu:ubuntu /var/log/sup-updates

# 5. First pull + start
~/bin/update-uxie
```

## Update flow

Tag locally → CI publishes image → run update on VPS:

```bash
# laptop
git tag v1.4.3 && git push origin v1.4.3

# VPS
ssh para-raid '~/bin/update-uxie'
```

`update-uxie` is idempotent (no-op when image digest is unchanged) and rolls
back automatically if the post-restart ready-check fails. Slash commands are
re-registered (`bun run deploy`) on every successful update, so command
changes ship with the same release.

## Ready-check

No HTTP surface — a gateway bot's liveness is process-up, which the restart
policy already covers. `update-uxie` instead greps `docker logs uxie` for the
one-line JSON `"msg":"uxie ready"` emitted by the `ClientReady` handler
(`src/index.ts`), for up to 30s after restart.

## ALLOW_SCRYPT_RESTART

Kept at `0` in `/opt/secrets/uxie.env` in prod. Enabling it inside a
container would require mounting `docker.sock` — root-equivalent host
access. Scrypt already self-heals via its own restart policy + healthcheck,
so uxie doesn't need the ability to restart it.

## GHCR PAT rotation

Shared with scrypt — see `scrypt/scripts/vps/README.md` §GHCR PAT rotation
(sibling repo, same `/opt/secrets/shared.env`). `~/bin/update-uxie`
re-logs-in on every run.

## Logs

- Update history: `/var/log/sup-updates/uxie.log`
- Container logs: `docker logs uxie` (json-file driver, 10MB × 5 rotation)
