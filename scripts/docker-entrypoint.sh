#!/bin/sh
# Container entrypoint:
#   1. Fix ownership + permissions on the bind-mounted /app/data so the
#      `node` user (uid 1000) can always read/write — host-side perms
#      from `docker run -v ./data:/app/data` otherwise win and locked
#      out new installs on Linux hosts.
#   2. Detect every `/dev/dri/render*` and `/dev/dri/card*` device
#      mounted into the container, look up its GID on the host, and add
#      `node` to a matching group so VAAPI / QSV ffmpeg can open the
#      device for hardware-accelerated thumbnails. The host GID varies
#      by distro AND Synology DSM version (DSM 6 ≈ 937, DSM 7 ≈ 100, RHEL
#      uses 39, plain Debian uses 104), so a hard-coded `group_add` in
#      compose isn't portable. Detect at boot instead.
#   3. Drop privileges to `node` via gosu and exec the CMD.
#
# Idempotent: safe to run on every container start. The chown/chmod walk
# is a no-op once perms are already correct (millisecond-cost on most
# volumes; if you have millions of files set FAST_BOOT=1 to skip it).

set -e

if [ "$(id -u)" = "0" ]; then
    if [ "${FAST_BOOT:-0}" != "1" ]; then
        # Pre-create every directory the running app writes to. `backups`
        # holds pre-update DB snapshots (data/backups/db-pre-update-*.sqlite)
        # — pre-creating it here means the first /api/update click can't
        # silently depend on /app/data having g+w during the on-demand
        # mkdir inside the request handler.
        mkdir -p \
            /app/data \
            /app/data/downloads \
            /app/data/logs \
            /app/data/sessions \
            /app/data/backups
        chown -R node:node /app/data 2>/dev/null || true
        chmod -R u+rwX,g+rwX,o+rX /app/data 2>/dev/null || true
    fi

    # ---- GPU passthrough: align in-container groups with host /dev/dri ----
    #
    # Pass ENTRYPOINT_DEBUG_GPU=1 in compose env to print every detection
    # step. Otherwise the block is silent on success.
    _gpu_log() {
        if [ "${ENTRYPOINT_DEBUG_GPU:-0}" = "1" ]; then
            echo "[entrypoint:gpu] $*"
        fi
    }
    _add_node_to_gid() {
        gid="$1"
        device="$2"
        # 0 = root; nothing to add
        if [ -z "$gid" ] || [ "$gid" = "0" ]; then
            _gpu_log "$device owned by root — skipping"
            return 0
        fi
        # Already in a group with this GID?
        if id -G node 2>/dev/null | tr ' ' '\n' | grep -qx "$gid"; then
            return 0
        fi
        # Find an existing group with this GID, or create one.
        existing="$(getent group "$gid" 2>/dev/null | cut -d: -f1 || true)"
        if [ -z "$existing" ]; then
            existing="hostgpu_$gid"
            groupadd -g "$gid" "$existing" 2>/dev/null \
                || addgroup -g "$gid" "$existing" 2>/dev/null \
                || {
                    _gpu_log "could not create group with gid=$gid for $device"
                    return 0
                }
            _gpu_log "created group $existing (gid=$gid) for $device"
        fi
        usermod -a -G "$existing" node 2>/dev/null \
            || addgroup node "$existing" 2>/dev/null \
            || {
                _gpu_log "could not add node to group $existing"
                return 0
            }
        echo "[entrypoint] node added to group '$existing' (gid=$gid) for $device"
    }
    if [ -d /dev/dri ]; then
        for dev in /dev/dri/renderD* /dev/dri/card*; do
            [ -e "$dev" ] || continue
            gid="$(stat -c '%g' "$dev" 2>/dev/null || echo '')"
            _add_node_to_gid "$gid" "$dev"
        done
    else
        _gpu_log "/dev/dri not present — host did not pass the GPU through (ffmpeg will use CPU)"
    fi
    # NVIDIA / non-DRI accelerators (cuda) — `nvidia-container-runtime`
    # injects /dev/nvidia* with mode 0666, so no group fix is needed; the
    # device works for any UID. Skip the loop.

    exec gosu node:node "$@"
fi

exec "$@"
