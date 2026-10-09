#!/bin/sh
# Container entrypoint, kept at the 2.x path (/app/scripts/docker-entrypoint.sh)
# so Synology patch scripts that exec it keep working after the Go cutover.
#
# As root it prepares the bind-mounted data folder and GPU device groups,
# then drops to the unprivileged `node` user (uid 1000, unchanged from 2.x)
# before running the command. Started as a non-root user it just runs it.
set -e

if [ "$(id -u)" = "0" ]; then
    if [ "${FAST_BOOT:-0}" != "1" ]; then
        mkdir -p \
            /app/data \
            /app/data/downloads \
            /app/data/logs \
            /app/data/sessions \
            /app/data/backups
        chown -R node:node /app/data 2>/dev/null || true
        chmod -R u+rwX,g+rwX,o+rX /app/data 2>/dev/null || true
        if [ -n "${TGDL_DOWNLOADS_DIR:-}" ]; then
            mkdir -p "${TGDL_DOWNLOADS_DIR}"
            chown node:node "${TGDL_DOWNLOADS_DIR}" 2>/dev/null || true
            chmod u+rwX,g+rwX,o+rX "${TGDL_DOWNLOADS_DIR}" 2>/dev/null || true
        fi
    fi

    _gpu_log() {
        if [ "${ENTRYPOINT_DEBUG_GPU:-0}" = "1" ]; then
            echo "[entrypoint:gpu] $*"
        fi
    }
    # Join whatever group owns the passed-through render device; its GID
    # differs between hosts (and between Synology DSM versions).
    _add_node_to_gid() {
        gid="$1"
        device="$2"
        if [ -z "$gid" ] || [ "$gid" = "0" ]; then
            _gpu_log "$device owned by root — skipping"
            return 0
        fi
        if id -G node 2>/dev/null | tr ' ' '\n' | grep -qx "$gid"; then
            return 0
        fi
        existing="$(getent group "$gid" 2>/dev/null | cut -d: -f1 || true)"
        if [ -z "$existing" ]; then
            existing="hostgpu_$gid"
            groupadd -g "$gid" "$existing" 2>/dev/null || {
                _gpu_log "could not create group with gid=$gid for $device"
                return 0
            }
        fi
        usermod -a -G "$existing" node 2>/dev/null || {
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
    # Some hosts bind these 0640 root:root; the app user must resolve DNS.
    chmod a+r /etc/hosts /etc/resolv.conf /etc/hostname 2>/dev/null || true
    exec gosu node "$@"
fi
exec "$@"
