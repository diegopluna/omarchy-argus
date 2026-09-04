#!/bin/bash
# Intel GPU collector daemon for the Argus fork (Intel busy/power support).
#
# i915/xe expose no unprivileged busy counter, so Argus honestly marks
# Intel GPU usage "unavailable". This daemon fills that gap by sampling the
# real GPU via intel_gpu_top in a tight loop and appending CSV lines to a
# state file. sample.sh reads the LAST line on each tick — busy is derived
# as 100 - RC6, plus requested/actual freq and GPU/package power.
#
# intel_gpu_top needs CAP_PERFMON; set once with:
#   sudo setcap cap_perfmon=ep /usr/bin/intel_gpu_top
# Without it, or if intel_gpu_top is absent, the daemon writes nothing and
# Argus falls back to the upstream "unavailable" behaviour — graceful.
#
# Usage: intel-gpu-collector.sh STATE_FILE
# Runs until killed. Restarts intel_gpu_top if it dies (transient errors).

set -u

STATE_FILE="${1:-${XDG_STATE_HOME:-$HOME/.local/state}/argus/intel-gpu.csv}"
SAMPLE_MS="${IGT_SAMPLE_MS:-1500}"

# intel_gpu_top appends one CSV line per sample until interrupted; on a
# transient exit (driver reload, EPERM edge case) just respawn after a
# short pause instead of dead-ending the daemon.
while true; do
  if command -v intel_gpu_top >/dev/null 2>&1; then
    timeout 20 intel_gpu_top -c -s "$SAMPLE_MS" -o "$STATE_FILE" 2>/dev/null
  fi
  sleep 2
done