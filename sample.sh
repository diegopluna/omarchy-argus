#!/usr/bin/env bash
# Emits one system sample as sectioned plain text; parsed by Model.js.
#
# Usage: sample.sh [static|dynamic]
#   static  — hardware identity that never changes while the shell runs
#             (hostname, CPU model, disk models/topology, GPU names)
#   dynamic — everything that moves; sampled every tick
#   (none)  — both, for tests and one-shot use

mode="${1:-all}"

if [ "$mode" != "dynamic" ]; then
  echo '###HOST'
  cat /proc/sys/kernel/hostname 2>/dev/null

  echo '###CPUNAME'
  grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^[[:space:]]*//'

  echo '###DISKNAMES'
  lsblk -dno NAME,MODEL 2>/dev/null

  echo '###DISKLINKS'
  lsblk -rno NAME,PKNAME 2>/dev/null

  echo '###GPUNAMES'
  for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
    d="$c/device"
    [ -r "$d/gpu_busy_percent" ] || continue
    pci=$(basename "$(readlink -f "$d")" 2>/dev/null)
    name=$(lspci -s "$pci" 2>/dev/null | head -1 | cut -d: -f3- | sed 's/^[[:space:]]*//')
    echo "${c##*/card}|$name"
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
df -B1 --output=source,size,used,target -x tmpfs -x devtmpfs -x efivarfs -x overlay -x squashfs 2>/dev/null | tail -n +2

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
  for t in "$d"/hwmon/hwmon*/temp*_input; do
    [ -r "$t" ] || continue
    v=$(cat "$t" 2>/dev/null)
    [ -n "$v" ] || continue
    label=$(cat "${t%_input}_label" 2>/dev/null)
    if [ "$label" = "edge" ] || [ -z "$temp" ]; then temp=$v; fi
  done
  echo "${c##*/card}|$busy|$vram_used|$vram_total|$temp"
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
      --query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total \
      --format=csv,noheader,nounits 2>/dev/null
  else
    echo "suspended"
  fi
fi

echo '###PSCPU'
ps axo pid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null | head -n 10

echo '###PSMEM'
ps axo pid=,pcpu=,pmem=,comm= --sort=-pmem 2>/dev/null | head -n 10

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
  echo "${b##*/}|$status|$capacity|$energy_now|$energy_full|$energy_design|$power_now|$model"
done
