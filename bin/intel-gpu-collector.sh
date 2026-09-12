#!/bin/bash
# Intel GPU collector daemon for Argus (Intel busy/power/freq support).
#
# i915/xe expose no unprivileged busy counter, so Argus honestly marks
# Intel GPU usage "unavailable". This daemon fills that gap by sampling the
# real GPU engines via intel_gpu_top. It discovers every Intel DRM card
# that lacks a native gpu_busy_percent counter and runs ONE intel_gpu_top
# per card (device-selected with -d drm:/dev/dri/cardN), writing a per-card
# CSV (intel-gpu-<cardN>.csv) under the XDG state dir. sample.sh reads each
# card's OWN csv, so on multi-Intel-GPU systems telemetry is never
# duplicated or misattributed.
#
# intel_gpu_top needs CAP_PERFMON; set once with:
#   sudo setcap cap_perfmon=ep /usr/bin/intel_gpu_top
# Without it, or if intel_gpu_top is absent, the daemon writes nothing and
# Argus falls back to the upstream "unavailable" behaviour — graceful.
#
# Environment:
#   INTEL_GPU_SAMPLE_MS  sample period in ms (default 1500)
#
# Run as a systemd --user unit (omarchy-argus-intel-gpu.service, installed
# via bin/install-intel-gpu.sh) or directly: bin/intel-gpu-collector.sh.
# Keeps running until killed; respawns intel_gpu_top on transient exits.

set -u

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/argus"
SAMPLE_MS="${INTEL_GPU_SAMPLE_MS:-1500}"
mkdir -p "$STATE_DIR"

# One respawning collector child per Intel card.
collect_one() {
  local dev="$1" out="$2"
  while true; do
    if command -v intel_gpu_top >/dev/null 2>&1; then
      # -o truncates on open, so the 20s timeout bounds the file size and a
      # respawn rewrites it fresh; on a transient exit (driver reload, EPERM
      # edge case) just retry after a short pause instead of dead-ending.
      timeout 20 intel_gpu_top -d "$dev" -c -s "$SAMPLE_MS" -o "$out" 2>/dev/null
    fi
    sleep 2
  done
}

launched=0
for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
  [ -r "$c/device/vendor" ] || continue
  [ "$(cat "$c/device/vendor" 2>/dev/null)" = "0x8086" ] || continue
  # Cards with a native gpu_busy_percent counter are handled by Argus itself.
  [ -r "$c/device/gpu_busy_percent" ] && continue
  card="${c##*/card}"
  # Select the device via the sysfs path (canonical PCI device dir): this
  # walks sysfs and is robust in restricted contexts where opening the
  # /dev/dri node directly can fail. If intel_gpu_top still can't open it,
  # it just exits and gets respawned by collect_one.
  dev="sys:$(readlink -f "$c/device")"
  collect_one "$dev" "$STATE_DIR/intel-gpu-$card.csv" &
  launched=1
done

# No Intel cards needing the daemon — exit cleanly (nothing to collect).
[ "$launched" = 1 ] || exit 0

# Keep the child collectors running for the lifetime of the unit.
wait
