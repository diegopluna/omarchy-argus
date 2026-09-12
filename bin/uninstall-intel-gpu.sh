#!/bin/bash
# Argus Intel GPU support — remove the per-user systemd unit installed by
# bin/install-intel-gpu.sh. Leaves CAP_PERFMON on intel_gpu_top (shared with
# other tools); strip it separately if you want to.

set -e

NAME=omarchy-argus-intel-gpu
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service"

systemctl --user disable --now "$NAME.service" 2>/dev/null || true
rm -f "$UNIT"
systemctl --user daemon-reload
systemctl --user reset-failed "$NAME.service" 2>/dev/null || true

echo "Uninstalled $NAME."
echo "Optional: 'sudo setcap -r /usr/bin/intel_gpu_top' to drop CAP_PERFMON."
