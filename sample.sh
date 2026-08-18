#!/usr/bin/env bash
# Emits one system sample as sectioned plain text; parsed by Model.js.

echo '###HOST'
cat /proc/sys/kernel/hostname 2>/dev/null

echo '###CPUNAME'
grep -m1 '^model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^[[:space:]]*//'

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

echo '###DISKNAMES'
lsblk -dno NAME,MODEL 2>/dev/null

echo '###DISKLINKS'
lsblk -rno NAME,PKNAME 2>/dev/null

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
  pci=$(basename "$(readlink -f "$d")" 2>/dev/null)
  gpu_name=$(lspci -s "$pci" 2>/dev/null | head -1 | cut -d: -f3- | sed 's/^[[:space:]]*//')
  echo "${c##*/card}|$busy|$vram_used|$vram_total|$temp|$gpu_name"
done
