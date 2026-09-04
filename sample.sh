#!/usr/bin/env bash
# Emits one system sample as sectioned plain text; parsed by Model.js.
#
# Usage: sample.sh [static|dynamic [flags...]|ps|health]
#   static  — hardware identity that never changes while the shell runs
#             (hostname, CPU model, disk models/topology, GPU names)
#   dynamic — everything that moves; sampled every tick. Flags:
#               panel   — also emit the sections only the open panel
#                         displays (top processes, per-process GPU clients)
#               fast    — skip TEMP/FAN. Temperatures move on seconds, and
#                         an NVMe temp read is an admin command the drive
#                         can take ~75ms to answer (and it keeps the drive
#                         awake) — so the shell samples them every third
#                         tick and replays the last values between.
#               procs   — the full process table instead of the top 60
#                         (only the PROC tab needs all of it)
#               netinfo — interface IP/SSID identity (changes rarely; the
#                         shell asks every fifth panel tick)
#   ps      — just the top-process section; a one-shot the alert path runs
#             to attribute a fired alert while no panel is open.
#   health  — drive SMART health via udisks2 (no root needed); sampled at
#             startup and on panel open — wear moves in weeks, not ticks.
#   (none)  — everything, for tests and one-shot use

mode="${1:-all}"
panel=""
fast=""
procs=""
netinfo=""
for arg in "${@:2}"; do
  case "$arg" in
    panel) panel="panel" ;;
    fast) fast="fast" ;;
    procs) procs="procs" ;;
    netinfo) netinfo="netinfo" ;;
  esac
done
if [ "$mode" = "all" ]; then
  panel="panel"; procs="procs"; netinfo="netinfo"
fi

# Zero-fork one-line file read into $REPLY (sysfs/proc values). A `cat`
# per value looks harmless but forks; the sensor loops read dozens of
# files per tick, and fork/exec was ~95% of the sampler's cost. Succeeds
# if anything was read, even without a trailing newline.
rline() {
  REPLY=""
  IFS= read -r REPLY 2>/dev/null < "$1" || [ -n "$REPLY" ]
}

# Trim trailing whitespace in pure bash (device model strings pad with
# spaces; sed here would be a fork per sensor chip).
rtrim() {
  REPLY="${1%"${1##*[![:space:]]}"}"
}

emit_ps() {
  # The process table, one ps call; the model sorts/filters/caps it.
  # args= instead of comm=: comm truncates at 15 chars ("Isolated Web Co");
  # cut keeps browser-length command lines bounded. user:16 fixed-width so
  # spaces in args stay unambiguous; nlwp is the thread count. The full
  # table ships only when the PROC tab is watching; the CPU-sorted top 60
  # covers Home, attribution, and the kept-last preview.
  echo '###PS'
  if [ "$1" = "full" ]; then
    ps axo pid=,user:16=,pcpu=,pmem=,nlwp=,args= --sort=-pcpu 2>/dev/null | cut -c1-170
  else
    ps axo pid=,user:16=,pcpu=,pmem=,nlwp=,args= --sort=-pcpu 2>/dev/null | head -n 60 | cut -c1-170
  fi
}

if [ "$mode" = "ps" ]; then
  emit_ps
  exit 0
fi

# Drive SMART health through udisks2's D-Bus API — the one SMART source
# that needs no root. NVMe controllers expose wear and error counters via
# SmartGetAttributes; SATA drives expose the overall failing flag. Lines:
#   dev|nvme|model|poweron_h|critwarn|wear_pct|warn_temp_s|crit_temp_s|media_err|unsafe_shutdowns
#   dev|ata|model|poweron_h|failing
if [ "$mode" = "health" ]; then
  echo '###DRIVEHEALTH'
  command -v busctl >/dev/null 2>&1 || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
  objs=$(timeout 5 busctl call org.freedesktop.UDisks2 /org/freedesktop/UDisks2 \
    org.freedesktop.DBus.ObjectManager GetManagedObjects --json=short 2>/dev/null) || exit 0
  echo "$objs" | jq -r '
    .data[0] as $o |
    $o | to_entries[]
    | select(.key | test("/block_devices/"))
    | select(.value["org.freedesktop.UDisks2.Partition"] | not)
    | (.value["org.freedesktop.UDisks2.Block"].Drive.data // "/") as $dp
    | select($dp != "/")
    | $o[$dp] as $d | select($d)
    | (.key | split("/") | last) as $dev
    | ($d["org.freedesktop.UDisks2.Drive"].Model.data // "") as $model
    | if $d["org.freedesktop.UDisks2.NVMe.Controller"] then
        $d["org.freedesktop.UDisks2.NVMe.Controller"] as $c |
        "\($dev)|nvme|\($model)|\($c.SmartPowerOnHours.data // "")|\($c.SmartCriticalWarning.data // [] | join(";"))|\($dp)"
      elif $d["org.freedesktop.UDisks2.Drive.Ata"] then
        $d["org.freedesktop.UDisks2.Drive.Ata"] as $a |
        "\($dev)|ata|\($model)|\((($a.SmartPowerOnSeconds.data // 0) / 3600) | floor)|\(if $a.SmartFailing.data == true then "failing" else "" end)"
      else empty end
  ' 2>/dev/null | while IFS='|' read -r dev kind model poweron warn drivepath; do
    if [ "$kind" = "nvme" ] && [ -n "$drivepath" ]; then
      attrs=$(timeout 5 busctl call org.freedesktop.UDisks2 "$drivepath" \
        org.freedesktop.UDisks2.NVMe.Controller SmartGetAttributes 'a{sv}' 0 --json=short 2>/dev/null |
        jq -r '.data[0] | "\(.percent_used.data // "")|\(.warning_temp_time.data // "")|\(.critical_temp_time.data // "")|\(.media_errors.data // "")|\(.unsafe_shutdowns.data // "")"' 2>/dev/null)
      echo "$dev|nvme|$model|$poweron|$warn|$attrs"
    else
      echo "$dev|$kind|$model|$poweron|$warn"
    fi
  done
  exit 0
fi

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

  # card → PCI address, to join per-process GPU clients (which carry
  # drm-pdev) back to their card.
  echo '###GPUPDEV'
  for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
    d="$c/device"
    [ -d "$d" ] || continue
    echo "${c##*/card}|$(basename "$(readlink -f "$d")" 2>/dev/null)"
  done

  # Thread topology, for the CPU tab's core grid: which threads share a
  # core (SMT siblings), which cores share an L3 slice (CCDs on Zen,
  # clusters elsewhere), and each thread's rated ceiling (separates P/E
  # cores on hybrid chips). Lines: cpu|core_id|l3_shared_list|max_khz
  echo '###CPUTOPO'
  for c in /sys/devices/system/cpu/cpu[0-9]*; do
    n=${c##*/cpu}
    core=""; rline "$c/topology/core_id" && core=$REPLY
    l3=""; rline "$c/cache/index3/shared_cpu_list" && l3=$REPLY
    maxf=""; rline "$c/cpufreq/cpuinfo_max_freq" && maxf=$REPLY
    echo "$n|$core|$l3|$maxf"
  done
fi

[ "$mode" = "static" ] && exit 0

echo '###STAT'
grep '^cpu' /proc/stat

echo '###MEM'
grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|Shmem|Dirty|SwapTotal|SwapFree):' /proc/meminfo

echo '###SWAPS'
tail -n +2 /proc/swaps 2>/dev/null

echo '###LOAD'
rline /proc/loadavg && echo "$REPLY"
rline /proc/uptime && echo "$REPLY"
awk -F: '/^cpu MHz/ { s += $2; n++ } END { if (n) printf "%d\n", s / n }' /proc/cpuinfo

echo '###CPUFREQ'
for f in /sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq; do
  [ -r "$f" ] || continue
  rline "$f" || continue
  c=${f%/cpufreq/scaling_cur_freq}
  echo "${c##*/cpu}|$REPLY"
done

echo '###POWER'
# RAPL energy counters (cumulative µJ). Kernels since the PLATYPUS
# mitigation keep energy_uj root-only by default; emit a restricted
# marker so the panel can hint at the udev unlock instead of showing
# nothing.
for d in /sys/class/powercap/intel-rapl*; do
  [ -e "$d/name" ] || continue
  rline "$d/name" || continue
  name=$REPLY
  if [ -r "$d/energy_uj" ] && rline "$d/energy_uj"; then
    e=$REPLY
    max=""; rline "$d/max_energy_range_uj" && max=$REPLY
    echo "rapl|$name|$e|$max"
  else
    echo "rapl-restricted|$name"
  fi
done

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

if [ "$fast" != "fast" ]; then
echo '###TEMP'
for h in /sys/class/hwmon/hwmon*; do
  rline "$h/name" || continue
  name=$REPLY
  device=""
  if rline "$h/device/model"; then rtrim "$REPLY"; device=$REPLY; fi
  for t in "$h"/temp*_input; do
    [ -r "$t" ] || continue
    rline "$t" || continue
    value=$REPLY
    [ -n "$value" ] || continue
    label=""
    rline "${t%_input}_label" && label=$REPLY
    echo "$name|$label|$value|$device"
  done
done

echo '###FAN'
for h in /sys/class/hwmon/hwmon*; do
  rline "$h/name" || continue
  name=$REPLY
  device=""
  if rline "$h/device/model"; then rtrim "$REPLY"; device=$REPLY; fi
  for f in "$h"/fan*_input; do
    [ -r "$f" ] || continue
    rline "$f" || continue
    value=$REPLY
    [ -n "$value" ] || continue
    label=""
    rline "${f%_input}_label" && label=$REPLY
    # Super I/O chips (nct*, it87) expose several unlabeled headers; fall
    # back to fan1/fan2/… so the rows stay distinguishable.
    if [ -z "$label" ]; then label=${f%_input}; label=${label##*/}; fi
    echo "$name|$label|$value|$device"
  done
done
fi

echo '###GPU'
for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
  d="$c/device"
  [ -r "$d/gpu_busy_percent" ] || continue
  busy=""; rline "$d/gpu_busy_percent" && busy=$REPLY
  vram_used=""; rline "$d/mem_info_vram_used" && vram_used=$REPLY
  vram_total=""; rline "$d/mem_info_vram_total" && vram_total=$REPLY
  gtt_used=""; rline "$d/mem_info_gtt_used" && gtt_used=$REPLY
  gtt_total=""; rline "$d/mem_info_gtt_total" && gtt_total=$REPLY
  # APU or dGPU? The kernel exposes mem_busy_percent only for dedicated
  # VRAM, so its absence marks an iGPU — whose mem_info_vram_total is just
  # the BIOS carve-out, with the real ceiling in GTT (shared system RAM).
  apu=0; [ -r "$d/mem_busy_percent" ] || apu=1
  temp=""
  power=""
  for t in "$d"/hwmon/hwmon*/temp*_input; do
    [ -r "$t" ] || continue
    rline "$t" || continue
    v=$REPLY
    [ -n "$v" ] || continue
    label=""; rline "${t%_input}_label" && label=$REPLY
    if [ "$label" = "edge" ] || [ -z "$temp" ]; then temp=$v; fi
  done
  for p in "$d"/hwmon/hwmon*/power1_average "$d"/hwmon/hwmon*/power1_input; do
    [ -r "$p" ] || continue
    rline "$p" && power=$REPLY
    break
  done
  echo "${c##*/card}|$busy|$vram_used|$vram_total|$temp|$power|$gtt_used|$gtt_total|$apu"
done

echo '###GPUINTEL'
# Intel cards (i915/xe) expose no gpu_busy_percent; hwmon still provides
# temperature and (on Arc) power, so show what exists.
#
# Since v1.3.0 (zimixin fork) Intel busy/power are sampled through a
# background intel_gpu_top daemon: i915/xe have no unprivileged busy
# counter, but intel_gpu_top (with CAP_PERFMON) reads the real engines.
# Emit the daemon's latest reading (busy% = 100 - RC6, freq MHz, GPU power
# W) in the GPUINTEL line so the bar/panel show real usage instead of
# "unavailable". Without the daemon the old `card|temp|power` behaviour
# (busy=NaN) is kept — graceful on machines without intel_gpu_top.
for c in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do
  d="$c/device"
  [ -r "$d/vendor" ] || continue
  rline "$d/vendor" || continue
  [ "$REPLY" = "0x8086" ] || continue
  [ -r "$d/gpu_busy_percent" ] && continue
  temp=""
  power=""
  for t in "$d"/hwmon/hwmon*/temp*_input; do
    [ -r "$t" ] || continue
    rline "$t" || continue
    [ -n "$REPLY" ] && { temp=$REPLY; break; }
  done
  for p in "$d"/hwmon/hwmon*/power1_input "$d"/hwmon/hwmon*/power1_average; do
    [ -r "$p" ] || continue
    rline "$p" && power=$REPLY
    break
  done

  # --- intel_gpu_top daemon data (zimixin fork) ---
  busy=""; freq=""; igt_power=""
  STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/argus"
  CSV="$STATE_DIR/intel-gpu.csv"
  # Daemon is a systemd --user unit (`omarchy-argus-intel-gpu.service`),
  # enabled at session login; sample.sh only READS its CSV output. If the
  # service is stopped the CSV goes stale and busy stays NaN (the honest
  # upstream fallback) — no sample.sh ever spawns a collector, so there are
  # exactly 0 or 1 daemons, owned by systemd.
  # Fresh CSV (< 10s stale) -> take its last data line. intel_gpu_top
  # writes CRLF, and the \r turns grep/awk line-reads flaky (binary-file
  # match), so strip \r and take the literal last line — always the newest
  # sample once the file has any. A file with only the header returns the
  # header, which the freq_Numeric guard below drops (starts with "Freq").
  if [ -s "$CSV" ] && [ $(( $(date +%s) - $(stat -c %Y "$CSV") )) -lt 10 ]; then
    last_line="$(tail -n 1 "$CSV" | tr -d '\r')"
    case "$last_line" in
      Freq*) last_line="" ;;
    esac
    if [ -n "$last_line" ]; then
      # columns: freq_req, freq_act, irq, rc6, p_gpu, p_pkg, rcs.., bcs.., vcs.., vecs..
      freq_act="$(echo "$last_line" | cut -d, -f2)"
      rc6="$(echo "$last_line" | cut -d, -f4)"
      p_gpu="$(echo "$last_line" | cut -d, -f5)"
      # busy% ≈ 100 - RC6, clamped to [0,100]
      busy=$(awk -v rc="$rc6" 'BEGIN{v=100-rc; if(v<0)v=0; if(v>100)v=100; printf "%d", v}')
      freq=$(awk -v f="$freq_act" 'BEGIN{printf "%d", f}')
      igt_power=$(awk -v p="$p_gpu" 'BEGIN{printf "%.3f", p}')
    fi
  fi
  # Power: prefer intel_gpu_top's real GPU power (W); hwmon power on Intel
  # iGPUs is usually absent. Busy/freq only from the daemon. Sample line:
  #   card|temp(mC)|power(W)|busy|freq(MHz)
  if [ -n "$igt_power" ]; then
    echo "${c##*/card}|$temp|$igt_power|$busy|$freq"
  else
    echo "${c##*/card}|$temp|$power"
  fi
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
    gpath=${g%/}
    s=""; rline "/sys/bus/pci/devices/${gpath##*/}/power/runtime_status" && s=$REPLY
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
if [ "$panel" = "panel" ]; then
  if [ "$procs" = "procs" ]; then emit_ps full; else emit_ps; fi

  # Interface identity for the NET tab: kind, IPv4, and Wi-Fi SSID.
  # Panel-only and throttled — the bar needs rates, not addresses. SSID
  # last so a "|" in a network name can't shift the other fields.
  if [ "$netinfo" = "netinfo" ]; then
  echo '###NETINFO'
  for n in /sys/class/net/*; do
    i=${n##*/}
    [ "$i" = "lo" ] && continue
    kind="virtual"
    if [ -d "$n/wireless" ]; then kind="wifi"
    elif [ -e "$n/device" ]; then kind="eth"; fi
    addr=$(timeout 2 ip -4 -o addr show dev "$i" 2>/dev/null | awk '{print $4; exit}')
    ssid=""
    if [ "$kind" = "wifi" ] && command -v iw >/dev/null 2>&1; then
      ssid=$(timeout 2 iw dev "$i" info 2>/dev/null | awk '$1 == "ssid" { $1=""; sub(/^ /,""); print; exit }')
    fi
    echo "$i|$kind|$addr|$ssid"
  done
  fi

  # Per-process GPU clients from DRM fdinfo (amdgpu, i915/xe, nouveau —
  # any driver that implements the drm-usage-stats spec). One gawk pass
  # over every readable fdinfo file (~15ms); unreadable processes simply
  # don't appear in the glob, so only the user's own processes are seen.
  # Engine time is cumulative ns — the panel derives usage from deltas.
  # Lines: pid|comm|pdev|client-id|engine_ns_total|vram_kib
  # gawk-only (BEGINFILE/ENDFILE), which Omarchy's Arch base guarantees.
  echo '###GPUPROC'
  gawk '
    BEGINFILE { if (ERRNO) { nextfile }; drv=""; client=""; pdev=""; eng=0; vram=0 }
    /^drm-driver:/ { drv=$2 }
    /^drm-pdev:/ { pdev=$2 }
    /^drm-client-id:/ { client=$2 }
    /^drm-engine-/ { eng += $2 }
    /^drm-memory-vram:/ { vram = $2 }
    ENDFILE {
      if (drv != "" && client != "") {
        split(FILENAME, parts, "/"); pid = parts[3]
        key = pid "|" client
        if (!(key in seen)) {
          seen[key] = 1
          comm = ""; cf = "/proc/" pid "/comm"
          if ((getline comm < cf) > 0) close(cf)
          print pid "|" comm "|" pdev "|" client "|" eng "|" vram
        }
      }
    }
  ' /proc/[0-9]*/fdinfo/* 2>/dev/null || true
fi

echo '###BAT'
for b in /sys/class/power_supply/*; do
  [ -d "$b" ] || continue
  rline "$b/type" || continue
  [ "$REPLY" = "Battery" ] || continue
  # Peripheral batteries (mice, keyboards, gamepads) carry scope=Device;
  # only system batteries (laptops/UPSes) belong here.
  scope=""; rline "$b/scope" && scope=$REPLY
  [ "$scope" = "Device" ] && continue
  status=""; rline "$b/status" && status=$REPLY
  capacity=""; rline "$b/capacity" && capacity=$REPLY
  energy_now=""; rline "$b/energy_now" && energy_now=$REPLY
  energy_full=""; rline "$b/energy_full" && energy_full=$REPLY
  energy_design=""; rline "$b/energy_full_design" && energy_design=$REPLY
  power_now=""; rline "$b/power_now" && power_now=$REPLY
  # charge_*-only batteries: µAh × µV → µWh is (c/1000) × (v/1000).
  if [ -z "$energy_now" ] && [ -r "$b/charge_now" ]; then
    v=0; rline "$b/voltage_now" && v=${REPLY:-0}
    c=0; rline "$b/charge_now" && c=${REPLY:-0}
    energy_now=$(( c / 1000 * (v / 1000) ))
    c=0; rline "$b/charge_full" && c=${REPLY:-0}
    energy_full=$(( c / 1000 * (v / 1000) ))
    c=0; rline "$b/charge_full_design" && c=${REPLY:-0}
    energy_design=$(( c / 1000 * (v / 1000) ))
  fi
  if [ -z "$power_now" ] && [ -r "$b/current_now" ]; then
    v=0; rline "$b/voltage_now" && v=${REPLY:-0}
    i=0; rline "$b/current_now" && i=${REPLY:-0}
    power_now=$(( i / 1000 * (v / 1000) ))
  fi
  model=""; rline "$b/model_name" && model=$REPLY
  limit=""; rline "$b/charge_control_end_threshold" && limit=$REPLY
  echo "${b##*/}|$status|$capacity|$energy_now|$energy_full|$energy_design|$power_now|$model|$limit"
done
