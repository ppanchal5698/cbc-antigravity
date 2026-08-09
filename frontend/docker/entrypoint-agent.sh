#!/usr/bin/env bash
# Prepares the containerised CBC workspace, then starts whatever was asked for.
#
# Everything here is idempotent and guarded by a marker file, so restarting the
# service does not rebuild the venv or re-seed the workspace.
set -euo pipefail

WORKSPACE="${WORKSPACE_ROOT:-/workspace}"
SEED="${SEED_ROOT:-/seed}"
MARKER="$WORKSPACE/.container-initialised"

log() { printf '[entrypoint] %s\n' "$*"; }

# --- credential keyring ------------------------------------------------------
# agy stores its OAuth tokens in the Secret Service keyring. A bare container
# has no dbus session, so start one and unlock a keyring. The keyring itself
# lives in the agy-home volume, so the one-time login survives restarts.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
fi
if [ -n "${KEYRING_PASSWORD:-}" ]; then
  printf '%s' "$KEYRING_PASSWORD" \
    | gnome-keyring-daemon --unlock --replace --daemonize >/dev/null 2>&1 \
    || log "WARNING: gnome-keyring failed to unlock; agy auth may not persist"
fi

# --- seed the workspace ------------------------------------------------------
# /seed is the host CBC workspace mounted read-only. /workspace is a named
# volume, so the container can rewrite mcp_config.json to Linux paths without
# touching the host copy that the Antigravity IDE still uses.
if [ ! -f "$MARKER" ]; then
  if [ -d "$SEED" ] && [ -n "$(ls -A "$SEED" 2>/dev/null)" ]; then
    log "seeding workspace from $SEED"
    rsync -a --delete-excluded \
      --exclude '.venv/' \
      --exclude 'frontend/' \
      --exclude '.git/' \
      --exclude '__pycache__/' \
      --exclude '*.egg-info/' \
      --exclude '.pytest_cache/' \
      "$SEED"/ "$WORKSPACE"/
  else
    log "no seed mounted at $SEED; starting with an empty workspace"
    mkdir -p "$WORKSPACE/plans"
  fi

  # --- Linux virtualenv for the three MCP servers ----------------------------
  if [ -d "$WORKSPACE/.agent/mcp" ]; then
    log "building the Linux virtualenv"
    python3 -m venv "$WORKSPACE/.venv"
    "$WORKSPACE/.venv/bin/pip" install --no-cache-dir --upgrade pip setuptools wheel
    # openpyxl is now declared in both pyproject.toml files, so the editable installs
    # below bring it in. Kept as a belt-and-braces install for a workspace seeded from
    # an older checkout, where catalog-intelligence would otherwise fail to read a
    # spreadsheet price list.
    "$WORKSPACE/.venv/bin/pip" install --no-cache-dir openpyxl
    for server in building-plan-intelligence catalog-intelligence cbc-estimating-engine; do
      if [ -d "$WORKSPACE/.agent/mcp/$server" ]; then
        log "installing $server"
        "$WORKSPACE/.venv/bin/pip" install --no-cache-dir -e "$WORKSPACE/.agent/mcp/$server"
      fi
    done
  fi

  touch "$MARKER"
  log "workspace initialised"
fi

# --- Linux MCP registration --------------------------------------------------
# Rewritten every boot: the seeded copy carries Windows paths that cannot spawn
# here, and the image's config is the authority inside the container.
if [ -f /app/docker/mcp_config.linux.json ]; then
  mkdir -p "$WORKSPACE/.agent" "$HOME/.gemini/config"
  cp /app/docker/mcp_config.linux.json "$WORKSPACE/.agent/mcp_config.json"
  cp /app/docker/mcp_config.linux.json "$HOME/.gemini/config/mcp_config.json"
fi

mkdir -p "$WORKSPACE/plans" "$WORKSPACE/.agent/cache"

# --- catalog and plan indexes ------------------------------------------------
# Outside the first-boot marker, so a volume created before these were seeded
# picks them up on restart instead of needing `docker compose down -v`. The
# indexes are what the Shelf and Sheets surfaces read, and re-indexing the
# 744-page Hager book is not something to repeat on every fresh container.
for index in catalog-intelligence building-plan-intelligence; do
  target="$WORKSPACE/.agent/cache/$index"
  if [ -d "$SEED/.agent/cache/$index" ] && [ -z "$(ls -A "$target" 2>/dev/null)" ]; then
    log "seeding $index index"
    mkdir -p "$target"
    cp -r "$SEED/.agent/cache/$index/." "$target"/ || log "WARNING: could not seed $index"
  fi
done

exec "$@"
