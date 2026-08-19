# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [0.7.1] — 2026-08-19

### Changed
- PSI rows renamed to "Stall pressure" and now show the 10s/1m/5m windows
  like a load average, with an in-panel note that 0 means nothing had to
  wait — the single 10-second value read as permanently broken-at-zero on
  healthy machines (verified against induced contention: the pipeline
  reports exactly what the kernel does).
- The `metrics` IPC snapshot now includes the PSI values.

## [0.7.0] — 2026-08-19

### Added
- Terminate button on PROC rows: SIGTERM after a confirmation dialog
  (Esc cancels the dialog before it closes the panel).
- Recent-alerts log: the last ten fired alerts with timestamps, shown at
  the bottom of the BAR tab.
- Hide noisy sensors: an eye button per TEMP row persists a
  `hiddenSensors` list; a footer row reveals them again. Hidden sensors'
  thresholds keep alerting.
- Tab hotkeys: `1`–`9` and first-letter jumps (repeats cycle BAR/BAT);
  opening the panel while a metric is urgent lands on the relevant tab.
- `metrics` IPC method returning the current snapshot as JSON, for
  scripting: `omarchy-shell io.github.diegopluna.argus metrics`.
- Sparklines everywhere state their timespan ("last 2m"), and the DISK
  tab gains read/write sparklines.
- One or two things are better discovered than documented.

### Changed
- PROC shows full command lines (argv0 path stripped) instead of the
  kernel's 15-character `comm` truncation.
- Refreshed screenshots and the Okomart `preview.png`, which still showed
  the 0.2.x panel.

## [0.6.0] — 2026-08-19

### Added
- Per-sensor alert thresholds, set from the TEMP tab UI: each sensor row
  has a 󰂚 button opening an inline −/+/off stepper. A sensor over its
  limit renders urgent and fires a critical notification (same 3-tick
  hold and 5-minute cooldown as the built-in alerts). Persisted in
  shell.json as a `sensorThresholds` map keyed by `chip|device|label`,
  stable across reboots and hwmon renumbering. Independent of — and in
  addition to — the CPU/GPU/drive component thresholds.

## [0.5.0] — 2026-08-19

### Added
- Per-component temperature thresholds: `urgentCpuTempC` (85),
  `urgentGpuTempC` (90), and `urgentDriveTempC` (70) replace the single
  `urgentTempC`, which remains honored as a CPU/GPU fallback.
- Drive-temperature alert: watches the hottest NVMe/SATA sensor
  (alert-only, no bar segment; critical urgency).
- Intel GPU support (i915/xe): name, temperature, and power via hwmon;
  usage is marked unavailable rather than shown as zero, since Intel
  exposes no unprivileged busy counter.
- PSI pressure rows (`/proc/pressure`, 10-second averages) in the CPU,
  MEM, and DISK tabs.
- TEMP-tab hint on desktop machines whose motherboard Super I/O sensor
  driver is not loaded, pointing at the README's Fans section.
- Battery charge-limit row (`charge_control_end_threshold`), so a battery
  parked at 80% doesn't look like a bug.
- Kernel version in the CPU tab; battery status in the bar tooltip.

### Changed
- Virtual network interfaces (VPN tunnels, bridges, veth) are excluded
  from the bar's throughput totals — VPN traffic previously counted twice
  — and flagged in the NET tab. All-virtual environments still count
  everything.
- `df` and `lsblk` run under `timeout`: a stale NFS/sshfs mount now costs
  one degraded tick instead of freezing the widget permanently.

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
