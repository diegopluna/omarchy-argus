#!/usr/bin/env bash
# Emits one system sample as sectioned plain text; parsed by Model.js.
#
# Usage: sample.sh [static|dynamic [panel]]
#   static  — hardware identity that never changes while the shell runs
#             (hostname, CPU model, disk models/topology, GPU names)
#   dynamic — everything that moves; sampled every tick. With the extra
#             "panel" argument, also emits the sections only the open panel
#             displays (top processes).
#   (none)  — everything, for tests and one-shot use

mode="${1:-all}"
panel="${2:-}"

if [ "$mode" != "dynamic" ]; then
  echo '###HOST'
  cat /proc/sys/kernel/hostname 2>/dev/null

  echo '###CPUNAME'
  grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^[[:space:]]*//'

  echo '###KERNEL'
  uname -r

  echo '###CHASSIS'
  cat /sys/class/dmi/id/chassis_type 2>/dev/null

  echo '###DISKNAMES'
  timeout 3 lsblk -dno NAME,MODEL 2>/dev/null

  echo '###DISKLINKS'
  timeout 3 lsblk -rno NAME,PKNAME 2>/dev/null

  echo '###GPUNAMES'
  for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
    d="$c/device"
    [ -d "$d" ] || continue
    pci=$(basename "$(readlink -f "$d")" 2>/dev/null)
    name=$(lspci -s "$pci" 2>/dev/null | head -1 | cut -d: -f3- | sed 's/^[[:space:]]*//')
    [ -n "$name" ] && echo "${c##*/card}|$name"
  done
fi

[ "$mode" = "static" ] && exit 0

echo '###STAT'
grep '^cpu' /proc/stat

echo '###MEM'
grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo

echo '###LOAD'
cat /proc/loadavg
cat /proc/uptime
grep '^cpu MHz' /proc/cpuinfo | awk '{ s += $4; n++ } END { if (n) printf "%d\n", s / n }'

echo '###NET'
tail -n +3 /proc/net/dev

echo '###DF'
# timeout: a stale network mount (NFS/sshfs) blocks df forever, which would
# otherwise freeze sampling permanently.
timeout 3 df -B1 --output=source,size,used,target -x tmpfs -x devtmpfs -x efivarfs -x overlay -x squashfs 2>/dev/null | tail -n +2

echo '###PSI'
for r in cpu memory io; do
  [ -r "/proc/pressure/$r" ] || continue
  while IFS= read -r line; do echo "$r $line"; done < "/proc/pressure/$r"
done

echo '###NETPHYS'
for n in /sys/class/net/*; do
  [ -e "$n/device" ] && echo "${n##*/}"
done

echo '###DISKSTATS'
cat /proc/diskstats 2>/dev/null

echo '###TEMP'
for h in /sys/class/hwmon/hwmon*; do
  name=$(cat "$h/name" 2>/dev/null) || continue
  device=$(cat "$h/device/model" 2>/dev/null | sed 's/[[:space:]]*$//')
  for t in "$h"/temp*_input; do
    [ -r "$t" ] || continue
    value=$(cat "$t" 2>/dev/null) || continue
    [ -n "$value" ] || continue
    label=$(cat "${t%_input}_label" 2>/dev/null)
    echo "$name|$label|$value|$device"
  done
done

echo '###FAN'
for h in /sys/class/hwmon/hwmon*; do
  name=$(cat "$h/name" 2>/dev/null) || continue
  device=$(cat "$h/device/model" 2>/dev/null | sed 's/[[:space:]]*$//')
  for f in "$h"/fan*_input; do
    [ -r "$f" ] || continue
    value=$(cat "$f" 2>/dev/null) || continue
    [ -n "$value" ] || continue
    label=$(cat "${f%_input}_label" 2>/dev/null)
    # Super I/O chips (nct*, it87) expose several unlabeled headers; fall
    # back to fan1/fan2/… so the rows stay distinguishable.
    if [ -z "$label" ]; then label=$(basename "${f%_input}"); fi
    echo "$name|$label|$value|$device"
  done
done

echo '###GPU'
for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
  d="$c/device"
  [ -r "$d/gpu_busy_percent" ] || continue
  busy=$(cat "$d/gpu_busy_percent" 2>/dev/null)
  vram_used=$(cat "$d/mem_info_vram_used" 2>/dev/null)
  vram_total=$(cat "$d/mem_info_vram_total" 2>/dev/null)
  temp=""
  power=""
  for t in "$d"/hwmon/hwmon*/temp*_input; do
    [ -r "$t" ] || continue
    v=$(cat "$t" 2>/dev/null)
    [ -n "$v" ] || continue
    label=$(cat "${t%_input}_label" 2>/dev/null)
    if [ "$label" = "edge" ] || [ -z "$temp" ]; then temp=$v; fi
  done
  for p in "$d"/hwmon/hwmon*/power1_average "$d"/hwmon/hwmon*/power1_input; do
    [ -r "$p" ] || continue
    power=$(cat "$p" 2>/dev/null)
    break
  done
  echo "${c##*/card}|$busy|$vram_used|$vram_total|$temp|$power"
done

echo '###GPUINTEL'
# Intel cards (i915/xe) expose no gpu_busy_percent; hwmon still provides
# temperature and (on Arc) power, so show what exists.
for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
  d="$c/device"
  [ -r "$d/vendor" ] || continue
  [ "$(cat "$d/vendor" 2>/dev/null)" = "0x8086" ] || continue
  [ -r "$d/gpu_busy_percent" ] && continue
  temp=""
  power=""
  for t in "$d"/hwmon/hwmon*/temp*_input; do
    [ -r "$t" ] || continue
    v=$(cat "$t" 2>/dev/null)
    [ -n "$v" ] && { temp=$v; break; }
  done
  for p in "$d"/hwmon/hwmon*/power1_input "$d"/hwmon/hwmon*/power1_average; do
    [ -r "$p" ] || continue
    power=$(cat "$p" 2>/dev/null)
    break
  done
  echo "${c##*/card}|$temp|$power"
done

echo '###NVIDIA'
# The proprietary NVIDIA driver exposes no gpu_busy_percent/vram sysfs, so
# query nvidia-smi instead — but only when the driver is actually loaded
# (/proc/driver/nvidia exists), so machines with a stray nvidia-smi binary
# never pay for a failing call. And never while every NVIDIA card is
# runtime-suspended: waking the dGPU for a poll would keep it from ever
# sleeping on Optimus laptops. "suspended" tells Model.js to keep showing
# the last known values as asleep.
if [ -e /proc/driver/nvidia/version ] && command -v nvidia-smi >/dev/null 2>&1; then
  awake=0
  found=0
  for g in /proc/driver/nvidia/gpus/*/; do
    [ -d "$g" ] || continue
    found=1
    s=$(cat "/sys/bus/pci/devices/$(basename "$g")/power/runtime_status" 2>/dev/null)
    [ "$s" = "suspended" ] || awake=1
  done
  if [ "$found" = 0 ] || [ "$awake" = 1 ]; then
    timeout 3 nvidia-smi \
      --query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw \
      --format=csv,noheader,nounits 2>/dev/null
  else
    echo "suspended"
  fi
fi

# Top processes are only visible in the open panel; skip them on the
# always-on bar tick.
if [ "$mode" = "all" ] || [ "$panel" = "panel" ]; then
  # args= instead of comm=: comm truncates at 15 chars ("Isolated Web Co");
  # cut keeps browser-length command lines bounded.
  echo '###PSCPU'
  ps axo pid=,pcpu=,pmem=,args= --sort=-pcpu 2>/dev/null | head -n 10 | cut -c1-140

  echo '###PSMEM'
  ps axo pid=,pcpu=,pmem=,args= --sort=-pmem 2>/dev/null | head -n 10 | cut -c1-140
fi

echo '###BAT'
for b in /sys/class/power_supply/*; do
  [ -d "$b" ] || continue
  [ "$(cat "$b/type" 2>/dev/null)" = "Battery" ] || continue
  # Peripheral batteries (mice, keyboards, gamepads) carry scope=Device;
  # only system batteries (laptops/UPSes) belong here.
  [ "$(cat "$b/scope" 2>/dev/null)" = "Device" ] && continue
  status=$(cat "$b/status" 2>/dev/null)
  capacity=$(cat "$b/capacity" 2>/dev/null)
  energy_now=$(cat "$b/energy_now" 2>/dev/null)
  energy_full=$(cat "$b/energy_full" 2>/dev/null)
  energy_design=$(cat "$b/energy_full_design" 2>/dev/null)
  power_now=$(cat "$b/power_now" 2>/dev/null)
  # charge_*-only batteries: µAh × µV → µWh is (c/1000) × (v/1000).
  if [ -z "$energy_now" ] && [ -r "$b/charge_now" ]; then
    v=$(cat "$b/voltage_now" 2>/dev/null); v=${v:-0}
    c=$(cat "$b/charge_now" 2>/dev/null); c=${c:-0}
    energy_now=$(( c / 1000 * (v / 1000) ))
    c=$(cat "$b/charge_full" 2>/dev/null); c=${c:-0}
    energy_full=$(( c / 1000 * (v / 1000) ))
    c=$(cat "$b/charge_full_design" 2>/dev/null); c=${c:-0}
    energy_design=$(( c / 1000 * (v / 1000) ))
  fi
  if [ -z "$power_now" ] && [ -r "$b/current_now" ]; then
    v=$(cat "$b/voltage_now" 2>/dev/null); v=${v:-0}
    i=$(cat "$b/current_now" 2>/dev/null); i=${i:-0}
    power_now=$(( i / 1000 * (v / 1000) ))
  fi
  model=$(cat "$b/model_name" 2>/dev/null)
  limit=$(cat "$b/charge_control_end_threshold" 2>/dev/null)
  echo "${b##*/}|$status|$capacity|$energy_now|$energy_full|$energy_design|$power_now|$model|$limit"
done
