# Changelog

All notable changes to Argus are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/).

## [0.8.1] — 2026-08-21

### Security
- Every Text rendering system-controlled strings (process command lines,
  sensor and device names, drive models, alert log entries) is pinned to
  `textFormat: Text.PlainText` — Qt's default AutoText can interpret
  such strings as StyledText markup, and process argv is
  attacker-influenceable. The kill-confirmation dialog's process name is
  additionally stripped of markup-significant characters, since it flows
  into a shell component the plugin cannot pin.

### Changed
- Refreshed every screenshot and the Okomart `preview.png` to the 0.8.0
  UI (watch row, grouped TEMP, per-process GPU, flat BAR tab), and
  reorganized the README: alert behavior — firing rules, attribution,
  per-sensor thresholds, the hook — now lives in one Alerts section, and
  sampling cost sits with the sampling internals.

## [0.8.0] — 2026-08-21

### Changed
- The sampler's CPU cost dropped ~8× (≈81ms → ≈10ms per tick): the
  per-value `cat` calls in the sensor/GPU/battery loops — a fork each,
  ~95% of the sampler's CPU — became zero-fork bash builtin reads, and
  the per-chip `sed` trims became parameter expansion. Output is
  byte-for-byte structurally identical. Most remaining wall time is the
  hwmon sensor bus itself (Super I/O chips take milliseconds per reading
  in the kernel), which no sampler can skip.
- The panel hero now carries the eye of Argus (blinking, same as the
  bar placeholder) instead of a generic CPU glyph, and its meta line
  keeps only the 1-minute load — the full triple lives in the CPU tab.
- TEMP tab groups sensors by physical device — one header per device,
  just the sensor label per row — instead of repeating "Motherboard ·
  nct6799 · …" on every line. A group whose sensors are all hidden hides
  its header too.
- Bar segment values are no-break-space padded to a stable width, so
  "9%" → "10%" no longer shifts every neighboring bar widget.
- Sparklines draw a solid baseline and idle samples render nothing —
  no more dashed row of minimum-height stubs when a series is quiet;
  the per-thread grid likewise leaves idle cells empty.
- Rate sparklines (NET, DISK I/O) scale to the session peak and mark it
  with a faint ceiling line, so the y-axis stays put instead of
  rescaling every time a spike scrolls out of the window.
- BAR tab rows are flat (label + switch) instead of bordered cards, with
  a fixed icon column; network and battery — whose bar segments compose
  their own glyphs — get static list icons so no row is iconless.
- Tab labels underline their first letter, advertising the letter-jump
  hotkey; NET rows use the same "·" separator style as DISK.

### Added
- The watch row: a quiet strip of vitals (CPU, RAM, CPU/GPU temperature,
  disk, battery) under the host name, visible on every tab — Argus never
  goes blind to the rest of the system while you read one tab. A vital
  turns urgent with its metric, the current tab's vital reads in the
  foreground color, and clicking one jumps to the tab that explains it.
- Alert hook: an `alertCommand` setting runs a shell command on every
  fired alert with `ARGUS_ALERT_KEY`/`TEXT`/`CRITICAL`/`AT` in the
  environment — one setting turns alerts into automation (ntfy, logs,
  webhooks). Drive-health alerts flow through the same path.
- Self-accounting: the BAR tab shows what sampling actually costs (wall
  clock per tick, measured), also exposed as `samplerMs` in the
  `metrics` IPC snapshot.
- Fixture corpus: `tests/fixtures/` holds scrubbed `sample.sh` captures
  from real machines, each fully re-parsed and rendered through every
  derived-value path on every CI run. `tests/make-fixture.sh` generates
  a contributable (hostname- and process-scrubbed) capture; seeded with
  this Ryzen 9700X + Radeon 9070 box.
- Per-process GPU usage: each GPU's panel section lists its busiest
  processes with usage percent and VRAM, from DRM fdinfo usage stats
  (amdgpu, i915/xe, nouveau — one ~15ms gawk pass, panel-only; the
  proprietary NVIDIA driver exposes no fdinfo stats and lists nothing).
- Drive health: the DISK tab shows each drive's wear, power-on time, and
  status from SMART via udisks2's D-Bus API — the one SMART source that
  needs no root. A drive reporting a critical warning, ≥90% wear, or
  media errors renders urgent and fires one notification per session.
  Sampled at startup and panel open; also in the `metrics` IPC snapshot
  (`driveHealth`).
- Tiered history: behind every sparkline's ~2-minute per-tick ring sits a
  1-hour ring keeping each minute's peak (peaks, not averages — zooming
  out must not erase the spike you're looking for). Click any chart
  caption to flip every chart between the two spans; alert markers move
  with the span, and `span 2m|1h` does the same over IPC.
- Alert attribution: CPU and memory alerts name their likely culprit —
  "CPU usage at 100% (threshold 90%) — chromium 61%". While no panel is
  open, a one-shot `sample.sh ps` fetches the process snapshot at the
  moment the alert fires (with a 2s timeout falling back to an
  unattributed alert).
- Alert markers: the CPU, MEM, and GPU sparklines cap the bar where an
  alert fired with a foreground-colored tick, so the alert log and the
  history tell one story.
- The `metrics` IPC snapshot now includes the alert log (`alerts`).
- A thin scroll indicator on the panel, so long tabs signal the content
  below the fold.
- The hero's refresh glyph spins on every refresh (button, `r`, middle
  click) — refreshing previously gave no visible acknowledgment.

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
