#!/usr/bin/env bash
# update-uxie — pull latest uxie image from GHCR, restart, wait for ready, rollback on failure.
#
# Idempotent. Safe to run multiple times. Single-instance via flock.
# Logs every run to /var/log/sup-updates/uxie.log with ISO-8601 timestamps.
#
# Exit codes:
#   0  success (or no-op when image unchanged)
#   1  ready-check failed (rollback attempted)
#   2  pull / login failed
#   3  another instance already running
#   4  misconfiguration (missing secrets, missing compose file)
#
# Install:
#   sudo install -m 0755 -o ubuntu -g ubuntu \
#     scripts/vps/update-uxie.sh /home/ubuntu/bin/update-uxie
#
# Run:
#   ~/bin/update-uxie          # manual
#   crontab -e  → 0 2 * * * /home/ubuntu/bin/update-uxie   # nightly

set -euo pipefail

LOG_DIR=/var/log/sup-updates
LOG=$LOG_DIR/uxie.log
COMPOSE=/home/ubuntu/uxie/docker-compose.vps.yml
IMAGE=ghcr.io/psianion/uxie:latest
LOCK=/var/lock/update-uxie.lock
SECRETS=/opt/secrets/shared.env

mkdir -p "$LOG_DIR"

log()    { printf '[%s] %s\n' "$(date -Iseconds)" "$*" | tee -a "$LOG" >&2; }
fail()   { log "FAIL: $1"; exit "${2:-1}"; }
notify() { [ -x "$HOME/bin/sup-notify" ] && "$HOME/bin/sup-notify" "$1" || true; }

# Single-instance lock — prevents cron + manual collision and concurrent restarts.
exec 9>"$LOCK"
flock -n 9 || fail "another update-uxie run is in progress" 3

log "=== update-uxie start (uid=$(id -u) host=$(hostname)) ==="

[[ -r "$SECRETS" ]] || fail "missing or unreadable $SECRETS — see runbook §bootstrap" 4
# shellcheck disable=SC1090
source "$SECRETS"
[[ -n "${GHCR_PAT:-}" && -n "${GHCR_USER:-}" ]] \
  || fail "GHCR_PAT / GHCR_USER not set in $SECRETS" 4

[[ -r "$COMPOSE" ]] || fail "compose file not found: $COMPOSE" 4

# Capture pre-state for rollback + audit trail.
PREV_IMAGE_ID=$(docker inspect --format='{{.Image}}' uxie 2>/dev/null || echo "none")
PREV_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$PREV_IMAGE_ID" 2>/dev/null || echo "none")
log "pre: container_image_id=$PREV_IMAGE_ID digest=$PREV_DIGEST"

log "logging in to ghcr.io as $GHCR_USER"
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null 2>&1 \
  || fail "docker login failed — check GHCR_PAT in $SECRETS" 2

log "pulling $IMAGE"
docker pull "$IMAGE" >> "$LOG" 2>&1 || fail "docker pull failed" 2

NEW_DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo "unknown")
log "post-pull: new_digest=$NEW_DIGEST"

# Idempotency: if the image hash hasn't changed, do nothing.
if [[ "$PREV_DIGEST" == "$NEW_DIGEST" && "$PREV_DIGEST" != "none" ]]; then
  log "no-op: image unchanged ($NEW_DIGEST)"
  log "=== update-uxie done (no-op) ==="
  exit 0
fi

START_TIME=$(date -Iseconds)
log "restarting container with new image"
docker compose -f "$COMPOSE" up -d --remove-orphans >> "$LOG" 2>&1 \
  || fail "docker compose up failed" 1

# Ready-check: uxie's ClientReady handler logs one line of JSON containing
# "uxie ready" once the Discord gateway connection is up. No HTTP surface to
# poll, so grep the container's own logs instead of curling a healthcheck.
log "waiting for \"uxie ready\" in container logs (up to 30s)"
ready=false
for i in $(seq 1 15); do
  if docker logs uxie --since "$START_TIME" 2>&1 | grep -q "uxie ready"; then
    ready=true
    log "ready OK on attempt $i"
    break
  fi
  sleep 2
done

if ! $ready; then
  log "ready-check FAILED after 30s"
  log "--- last 50 container log lines ---"
  docker logs --tail 50 uxie >> "$LOG" 2>&1 || true
  log "-----------------------------------"

  if [[ "$PREV_IMAGE_ID" != "none" ]]; then
    log "rolling back container image to $PREV_IMAGE_ID"
    docker tag "$PREV_IMAGE_ID" "$IMAGE"
    docker compose -f "$COMPOSE" up -d >> "$LOG" 2>&1 || true
    notify "uxie update rolled back: ready-check timeout (new_digest=$NEW_DIGEST)"
    log "rollback dispatched"
  else
    log "no previous image to roll back to — manual intervention required"
    notify "uxie update failed: no previous image to roll back to (new_digest=$NEW_DIGEST)"
  fi
  exit 1
fi

# Idempotent guild-command replace — ships command changes with the same update.
log "registering slash commands"
docker compose -f "$COMPOSE" run --rm uxie bun run deploy >> "$LOG" 2>&1 \
  || log "WARN: slash-command registration failed — bot is running but commands may be stale"

docker image prune -f >> "$LOG" 2>&1 || true

log "=== update-uxie done (digest=$NEW_DIGEST) ==="
