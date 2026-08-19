# Argus — System Monitor for Omarchy

Argus is a bar widget for the [Omarchy](https://omarchy.org) shell that shows live
system stats in the bar — you pick which, in the order you want — and opens a
tabbed panel with the full picture. Bar segments switch to the theme's urgent
color when a metric crosses its threshold.

![Argus in the bar](screenshots/bar.png)

## Bar metrics (all selectable, reorderable)

CPU usage, CPU temperature, RAM usage, GPU usage, GPU temperature, VRAM
usage, disk usage, disk I/O, network throughput, load average, and battery
(shown only on machines that have one). Pick any subset and arrange the
order in the panel's **BAR** tab; the choice persists to
`~/.config/omarchy/shell.json`.

## Panel tabs

- **CPU** — processor model, overall usage with sparkline history, per-thread bars, frequency, temperature, load, uptime
- **MEM** — RAM usage with sparkline history, swap
- **GPU** — every GPU (AMD via amdgpu sysfs, NVIDIA via nvidia-smi): name, usage, VRAM, temperature
- **DISK** — every real filesystem with its physical disk model (LUKS/LVM resolved via lsblk), plus live read/write rates per physical disk
- **NET** — total and per-interface download/upload rates, with download/upload sparklines
- **PROC** — top processes by CPU and by memory
- **TEMP** — every hwmon sensor with friendly names (CPU, GPU, NVMe with drive model, RAM, Wi-Fi, …), plus fan speeds
- **BAT** — per-battery charge, status, power draw, health, and time estimate (tab appears only when a system battery exists)
- **BAR** — toggles and reorder arrows for which metrics the bar shows

| | |
|---|---|
| ![CPU tab](screenshots/tab-cpu.png) | ![GPU tab](screenshots/tab-gpu.png) |
| ![TEMP tab](screenshots/tab-temp.png) | ![BAR tab](screenshots/tab-bar.png) |
| ![MEM tab](screenshots/tab-mem.png) | ![NET tab](screenshots/tab-net.png) |
| ![DISK tab](screenshots/tab-disk.png) | |

## Interactions

- Bar button: left click opens the panel, middle click refreshes, right click launches btop
- Panel: `h`/`l` or ←/→ switch tabs, `j`/`k` or ↑/↓ scroll, `r` refreshes, `Esc` closes

## Install

```bash
git clone https://github.com/diegopluna/omarchy-argus \
  ~/.config/omarchy/plugins/io.github.diegopluna.argus
omarchy plugin enable io.github.diegopluna.argus
```

Requires only tools an Omarchy install already has: `bash`, `coreutils`,
`df`, `ps` (procps), `lsblk` (util-linux), and `lspci` (pciutils) for GPU
names. On NVIDIA systems, `nvidia-smi` (which ships with the driver)
provides GPU stats. `btop` is optional (right-click launch).

## Uninstall

```bash
omarchy plugin disable io.github.diegopluna.argus
rm -rf ~/.config/omarchy/plugins/io.github.diegopluna.argus
```

Disabling removes the widget from the bar; the only state Argus writes is
its own entry in `~/.config/omarchy/shell.json`.

## Settings

Inline settings on the widget's entry in `shell.json`:

| Key | Default | Meaning |
|---|---|---|
| `show` | `["cpu", "ram", "cputemp"]` | Metric keys shown in the bar, in display order |
| `intervalSec` | `2` | Poll interval in seconds (1–60) |
| `diskMount` | `/` | Mount point used by the bar's disk metric |
| `urgentCpuPct` | `90` | CPU/GPU usage % at which the bar segment turns urgent |
| `urgentMemPct` | `90` | RAM/VRAM usage % at which the bar segment turns urgent |
| `urgentTempC` | `85` | Temperature (°C) at which temp segments turn urgent |
| `urgentDiskPct` | `90` | Disk usage % at which the bar segment turns urgent |

Load average turns urgent when the 1-minute load reaches the thread count;
battery turns urgent at ≤15% while discharging.

## IPC

```bash
omarchy-shell io.github.diegopluna.argus toggle
omarchy-shell io.github.diegopluna.argus refresh
omarchy-shell io.github.diegopluna.argus tab TEMP
```

## Data sources

`/proc` (stat, meminfo, loadavg, uptime, net/dev, cpuinfo, diskstats), `df`,
`lsblk`, `ps`, `/sys/class/hwmon` for temperatures and fans,
`/sys/class/power_supply` for batteries (peripheral batteries such as mice
are filtered out via the sysfs `scope` attribute), and
`/sys/class/drm/card*/device` for AMD GPU busy/VRAM (amdgpu). NVIDIA GPUs
are read through `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`,
invoked only when `/proc/driver/nvidia/version` shows the driver is loaded,
guarded by a 3-second timeout; `[N/A]` fields (e.g. utilization on some
GPUs) degrade gracefully. While every NVIDIA card is runtime-suspended
(`/sys/bus/pci/.../power/runtime_status`), Argus skips the query entirely so
polling never keeps an Optimus dGPU awake, and shows the card as asleep.
Hybrid AMD iGPU + NVIDIA dGPU systems list both, with the bar's GPU metrics
following the card with the most VRAM.

One short bash sampler runs per refresh; hardware identity that cannot
change while the shell runs (hostname, CPU model, disk models, GPU names)
is sampled once at startup (`sample.sh static`), so `lsblk`/`lspci` stay off
the hot path. Usage deltas are computed in QML.
