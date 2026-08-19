# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-08-19

### Added
- Threshold alerts: a desktop notification when a metric stays past its
  urgent threshold for 3 consecutive ticks (5-minute per-metric cooldown;
  `alerts` setting, default On). Temperatures and battery use critical
  urgency.
- GPU tab: usage sparkline for the primary card, power draw per card
  (amdgpu `power1_average` / nvidia-smi `power.draw`), and session-peak
  temperature.
- Session peaks: CPU temperature, network down/up, and disk I/O peaks
  since shell start, shown in their tabs.
- Fan rows fall back to `fan1`/`fan2`/… names when a chip exposes
  unlabeled headers (Super I/O chips expose several), and the README
  documents loading `nct6775`/`it87` for motherboard fans.
- CI: GitHub Actions runs the model tests on every push.

### Changed
- One sampler now runs for the whole shell instead of one per bar surface
  (the service became a Quickshell singleton) — multi-monitor setups halve
  their sampling work.
- Top processes are sampled only while a panel is open.
- Implausible Super I/O temperature readings (below −40° or above 250°)
  are dropped.
- Refreshed all README screenshots; added the PROC tab.

## [0.3.0] — 2026-08-19

### Added
- Sparkline history in the panel: CPU and RAM usage plus network
  download/upload, over the last 60 samples.
- Urgent-threshold highlighting: bar segments switch to the theme's urgent
  color past configurable thresholds (`urgentCpuPct`, `urgentMemPct`,
  `urgentTempC`, `urgentDiskPct`); load average keys off the thread count
  and battery off ≤15% while discharging.
- Disk I/O rates (read/write per physical disk, from `/proc/diskstats`) in
  the DISK tab and as a selectable `io` bar metric.
- Fan speeds (hwmon `fan*_input`) in the TEMP tab.
- PROC tab: top processes by CPU and by memory.
- Battery support: a BAT tab (charge, status, power draw, health, time
  estimate) and a `bat` bar metric with level/charging glyphs — both appear
  only on machines with a system battery; peripheral batteries (mice,
  keyboards) are filtered out via the sysfs `scope` attribute.
- Bar metrics are reorderable: the stored `show` order is now the display
  order, with move up/down arrows in the BAR tab.

### Changed
- The sampler is split into `static` (hostname, CPU model, disk models,
  GPU names — run once at shell start) and `dynamic` (everything else) —
  `lsblk` and `lspci` no longer run on every tick.
- `nvidia-smi` is never invoked while every NVIDIA card is
  runtime-suspended, so polling cannot keep an Optimus dGPU awake; the
  card is shown as asleep with its last-known identity until it wakes.

## [0.2.1] — 2026-08-18

- Placeholder icon (the eye of Argus, optically centered) when no metric
  renders, so the panel stays reachable from the bar.

## [0.2.0] — 2026-08-18

- NVIDIA GPU support via nvidia-smi, alongside amdgpu; hybrid systems list
  both, with the bar following the card with the most VRAM.

## [0.1.0] — 2026-08-18

- Initial release: selectable bar metrics persisted to shell.json and a
  tabbed panel (CPU, MEM, GPU, DISK, NET, TEMP, BAR) with keyboard
  navigation and IPC.
