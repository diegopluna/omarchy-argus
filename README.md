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

- **CPU** — processor model, overall usage with sparkline history, per-thread bars, frequency, temperature with session peak, load, uptime, PSI pressure, kernel version
- **MEM** — RAM usage with sparkline history, swap, PSI memory pressure
- **GPU** — every GPU (AMD via amdgpu sysfs, NVIDIA via nvidia-smi, Intel via hwmon): name, usage with sparkline history, VRAM, temperature with session peak, power draw
- **DISK** — every real filesystem with its physical disk model (LUKS/LVM resolved via lsblk), live read/write rates per physical disk, PSI I/O pressure
- **NET** — total and per-interface download/upload rates, with download/upload sparklines; virtual interfaces (VPN tunnels, bridges, veth) are listed but kept out of the totals so VPN traffic isn't counted twice
- **PROC** — top processes by CPU and by memory (full command lines), each with a terminate button (SIGTERM, after confirmation)
- **TEMP** — every hwmon sensor with friendly names (CPU, GPU, NVMe with drive model, RAM, Wi-Fi, …), plus fan speeds; each sensor row can carry its own alert threshold, set inline, and noisy sensors can be hidden (hidden sensors keep alerting)
- **BAT** — per-battery charge, status, power draw, health, and time estimate (tab appears only when a system battery exists)
- **BAR** — toggles and reorder arrows for which metrics the bar shows, plus the last few fired alerts with timestamps

| | |
|---|---|
| ![CPU tab](screenshots/tab-cpu.png) | ![GPU tab](screenshots/tab-gpu.png) |
| ![TEMP tab](screenshots/tab-temp.png) | ![BAR tab](screenshots/tab-bar.png) |
| ![MEM tab](screenshots/tab-mem.png) | ![NET tab](screenshots/tab-net.png) |
| ![DISK tab](screenshots/tab-disk.png) | ![PROC tab](screenshots/tab-proc.png) |

## Interactions

- Bar button: left click opens the panel, middle click refreshes, right click launches btop
- Panel: `h`/`l` or ←/→ switch tabs, `1`–`9` or a tab's first letter jump straight to it, `j`/`k` or ↑/↓ scroll, `r` refreshes, `Esc` closes
- Opening the panel while a metric is urgent lands on the tab that explains it

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
| `urgentCpuTempC` | `85` | CPU temperature (°C) threshold |
| `urgentGpuTempC` | `90` | GPU temperature (°C) threshold |
| `urgentDriveTempC` | `70` | Drive (NVMe/SATA) temperature (°C) alert threshold |
| `urgentDiskPct` | `90` | Disk usage % at which the bar segment turns urgent |
| `alerts` | `"On"` | Desktop notification when a metric stays past its threshold |

Temperature thresholds are per component — GPUs run hot by design, SSDs
throttle early. The pre-0.5.0 single `urgentTempC` still works as a
fallback for the CPU/GPU thresholds. Load average turns urgent when the
1-minute load reaches the thread count; battery turns urgent at ≤15% while
discharging. Drive temperature is alert-only (it has no bar segment) and
watches the hottest NVMe/SATA sensor.

On top of those defaults, **any individual sensor** can carry its own
alert threshold, set from the TEMP tab: the 󰂚 button on a sensor row opens
a stepper (−/+/off). A sensor over its limit renders its row in the urgent
color and fires a notification with the usual 3-tick hold and cooldown.
These persist in shell.json as a `sensorThresholds` map keyed by
`chip|device|label`, so they survive reboots and hwmon renumbering.

## Alerts

With `alerts` on, a metric that stays past its urgent threshold for three
consecutive ticks fires one desktop notification (via `notify-send`, so it
renders through the Omarchy shell), e.g. *"CPU temperature at 92°
(threshold 85°)"*. Temperature and battery alerts use critical urgency;
usage alerts are normal. Each metric then stays quiet for a 5-minute
cooldown. Alerts evaluate every sampled metric, whether or not its bar
segment is shown. The last ten fired alerts are kept, with timestamps, at
the bottom of the BAR tab — for the "did anything trip while I was away?"
question that a vanished notification can't answer.

## Fans

Argus lists every `fan*_input` the kernel exposes under
`/sys/class/hwmon`. GPU and NVMe fans appear out of the box; motherboard
fan headers need the board's Super I/O driver loaded — on most consumer
boards (ASUS/MSI/Gigabyte with Nuvoton chips):

```bash
sudo modprobe nct6775
echo nct6775 | sudo tee /etc/modules-load.d/nct6775.conf
```

(`it87` for ITE chips; `asus_ec_sensors` covers some ASUS boards.)

## IPC

```bash
omarchy-shell io.github.diegopluna.argus toggle
omarchy-shell io.github.diegopluna.argus refresh
omarchy-shell io.github.diegopluna.argus tab TEMP
omarchy-shell io.github.diegopluna.argus metrics   # current snapshot as JSON, for scripts
```

## Data sources

`/proc` (stat, meminfo, loadavg, uptime, net/dev, cpuinfo, diskstats), `df`,
`lsblk`, `ps`, `/sys/class/hwmon` for temperatures and fans,
`/sys/class/power_supply` for batteries (peripheral batteries such as mice
are filtered out via the sysfs `scope` attribute), and
`/sys/class/drm/card*/device` for AMD GPU busy/VRAM (amdgpu). NVIDIA GPUs
are read through `nvidia-smi --query-gpu=... --format=csv,noheader,nounits`
and Intel GPUs (i915/xe) through their hwmon temperature/power — Intel
exposes no unprivileged busy counter, so usage is honestly marked
unavailable rather than shown as zero. nvidia-smi is
invoked only when `/proc/driver/nvidia/version` shows the driver is loaded,
guarded by a 3-second timeout; `[N/A]` fields (e.g. utilization on some
GPUs) degrade gracefully. While every NVIDIA card is runtime-suspended
(`/sys/bus/pci/.../power/runtime_status`), Argus skips the query entirely so
polling never keeps an Optimus dGPU awake, and shows the card as asleep.
Hybrid AMD iGPU + NVIDIA dGPU systems list both, with the bar's GPU metrics
following the card with the most VRAM.

One short bash sampler runs per refresh — shared by every bar surface, so
multi-monitor setups still sample once. Hardware identity that cannot
change while the shell runs (hostname, CPU model, disk models, GPU names)
is sampled once at startup (`sample.sh static`), and top processes are
sampled only while a panel is open, so `lsblk`/`lspci`/`ps` stay off the
always-on hot path. `df` and `lsblk` run under `timeout` so a stale
network mount degrades one tick instead of freezing the widget. GPU power draw comes from amdgpu's hwmon
`power1_average` and nvidia-smi's `power.draw`. Usage deltas are computed
in QML.

---

*Argus Panoptes never sleeps. Should you ever doubt that all hundred eyes
are still open, address him by name.*
