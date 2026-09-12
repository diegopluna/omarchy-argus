#!/bin/bash
# Argus Intel GPU support — explicit setup (Omarchy's plugin installer
# deliberately runs NO install hooks, so enabling the collector is manual).
# Reversible with bin/uninstall-intel-gpu.sh.
#
# Usage: bin/install-intel-gpu.sh [PLUGIN_DIR]
#   PLUGIN_DIR defaults to this repo's parent (the plugin install path).

set -e

NAME=omarchy-argus-intel-gpu
PLUGIN_DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BIN="$PLUGIN_DIR/bin/intel-gpu-collector.sh"
SERVICE="$PLUGIN_DIR/bin/$NAME.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/$NAME.service"

if [ ! -f "$BIN" ] || [ ! -f "$SERVICE" ]; then
  echo "error: Argus plugin bin/ not found under '$PLUGIN_DIR' (pass the plugin dir as \$1)" >&2
  exit 1
fi

# intel_gpu_top must be able to read i915 busy counters (CAP_PERFMON).
if command -v intel_gpu_top >/dev/null 2>&1 && ! getcap /usr/bin/intel_gpu_top 2>/dev/null | grep -q cap_perfmon; then
  echo "NOTE: run 'sudo setcap cap_perfmon=ep /usr/bin/intel_gpu_top' to enable i915 busy counters." >&2
fi

mkdir -p "$UNIT_DIR"
cp -f "$SERVICE" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$NAME.service"
systemctl --user --no-pager --lines=0 status "$NAME.service" >/dev/null 2>&1 \
  && echo "Intel GPU collector is active." \
  || echo "warn: unit did not start — review 'systemctl --user status $NAME.service'." >&2
echo "Remove with: bin/uninstall-intel-gpu.sh"
