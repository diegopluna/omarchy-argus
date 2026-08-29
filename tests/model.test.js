// Run with: node tests/model.test.js
// Exercises Model.js against a live sample from this machine plus fixtures
// for hardware this machine may not have (NVIDIA, batteries, fans).
const { execSync } = require("child_process")
const path = require("path")
const Model = require(path.join(__dirname, "..", "Model.js"))

const assert = require("assert")

// CI runners are VMs without hwmon sensors or predictable disks; gate the
// hardware-shaped live assertions there. Everything fixture-based runs
// everywhere.
const CI = !!process.env.CI

const script = path.join(__dirname, "..", "sample.sh")
const text = execSync("bash " + script).toString()
const sample = Model.parseSample(text)

assert.ok(sample.host.length > 0, "host parsed")
assert.ok(sample.cpus.length > 1, "aggregate + per-core cpu lines")
assert.strictEqual(sample.cpus[0].id, "cpu")
assert.ok(sample.mem.total > 0, "MemTotal parsed")
assert.ok(sample.load.uptimeSec > 0, "uptime parsed")
assert.ok(sample.disks.length > 0, "disks parsed")
assert.ok(sample.disks.every(d => d.size > 0))
if (!CI) assert.ok(sample.temps.length > 0, "temps parsed")
assert.ok(sample.io.length > 0, "diskstats parsed")
assert.ok(sample.psCpu.length > 0, "top-cpu processes parsed")
assert.ok(sample.psMem.length > 0, "top-mem processes parsed")
assert.ok(sample.psCpu.every(p => isFinite(p.cpu) && p.comm.length > 0))

// The static/dynamic split concatenates back into a full sample.
const staticText = execSync("bash " + script + " static").toString()
const dynamicText = execSync("bash " + script + " dynamic").toString()
const merged = Model.parseSample(staticText + "\n" + dynamicText)
assert.strictEqual(merged.host, sample.host, "static host merges")
assert.strictEqual(merged.cpuName, sample.cpuName)
assert.ok(merged.cpus.length === sample.cpus.length, "dynamic stat merges")
assert.ok(Object.keys(merged.diskModels).length > 0, "disk models from static half")
const dynamicOnly = Model.parseSample(dynamicText)
assert.strictEqual(dynamicOnly.host, "", "dynamic half carries no identity")
assert.ok(dynamicOnly.cpus.length > 1, "dynamic half carries the stats")
assert.strictEqual(dynamicOnly.psCpu.length, 0, "processes skipped while no panel is open")
const panelText = execSync("bash " + script + " dynamic panel").toString()
assert.ok(Model.parseSample(panelText).psCpu.length > 0, "processes sampled with the panel flag")

// Second sample for deltas.
const text2 = execSync("bash " + script).toString()
const sample2 = Model.parseSample(text2)
const usage = Model.cpuUsage(sample.cpus, sample2.cpus)
assert.strictEqual(usage.length, sample2.cpus.length)
assert.ok(usage.every(u => u.pct >= 0 && u.pct <= 100), "cpu pct in range")

const rates = Model.netRates(sample.net, sample2.net, 1)
assert.ok(rates.down >= 0 && rates.up >= 0)

const io = Model.ioRates(sample.io, sample2.io, 1, sample.diskModels, sample.diskLinks)
assert.ok(io.read >= 0 && io.write >= 0)
if (!CI) {
  assert.ok(io.perDisk.length > 0, "whole disks found in diskstats")
  assert.ok(io.perDisk.every(d => !/p\d+$/.test(d.dev)), "partitions filtered out")
}

const gpu = Model.primaryGpu(sample.gpus)
if (sample.gpus.length > 0) {
  assert.ok(gpu.vramTotal >= 0)
  assert.ok(typeof gpu.name === "string", "gpu name attached from GPUNAMES")
}

const barData = {
  cpuPct: 12.4,
  cpuTemp: Model.cpuTemp(sample.temps),
  memPct: 61.2,
  gpu: gpu,
  disk: Model.diskFor(sample.disks, "/"),
  io: { read: 1048576, write: 2048 },
  netDown: 1234567,
  netUp: 4321,
  load1: 1.86,
  cores: 16,
  battery: null
}

assert.strictEqual(Model.fmtPct(12.4), "12%")
assert.strictEqual(Model.fmtBytes(1536), "1.5 KB")
assert.strictEqual(Model.fmtUptime(90061), "1d 1h")
assert.strictEqual(Model.fmtRateShort(1234567), "1.2M")
assert.strictEqual(Model.fmtWatts(7.24), "7.2 W")
assert.strictEqual(Model.fmtWatts(0), "—")

const barText = Model.barText(["cpu", "ram", "cputemp", "net", "load"], barData)
assert.ok(barText.includes("12%"), "bar shows cpu")
assert.ok(barText.includes("61%"), "bar shows ram")
assert.ok(barText.includes("1.86"), "bar shows load")
assert.ok(Model.metricValue("io", barData).includes("R1.0M"), "io metric renders rates")

// NVIDIA parsing (fixture-based: nvidia-smi csv,noheader,nounits output,
// now including power.draw).
const nv = Model.parseNvidia([
  "0, NVIDIA GeForce RTX 3080, 5, 45, 1024, 10240, 98.5",
  "1, NVIDIA RTX A6000, [N/A], 38, 512, 49140, [N/A]"
])
assert.strictEqual(nv.length, 2)
assert.strictEqual(nv[0].card, "nv0")
assert.strictEqual(nv[0].name, "NVIDIA GeForce RTX 3080")
assert.strictEqual(nv[0].busy, 5)
assert.strictEqual(nv[0].celsius, 45)
assert.strictEqual(nv[0].vramUsed, 1024 * 1048576)
assert.strictEqual(nv[0].vramTotal, 10240 * 1048576)
assert.strictEqual(nv[0].powerW, 98.5)
assert.ok(Number.isNaN(nv[1].busy), "[N/A] utilization -> NaN")
assert.ok(Number.isNaN(nv[1].powerW), "[N/A] power -> NaN")
assert.strictEqual(nv[1].celsius, 38)
// Bar hides the gpu segment when utilization is unsupported.
assert.strictEqual(Model.metricValue("gpu", { gpu: nv[1] }), "")
assert.strictEqual(Model.metricValue("gpu", { gpu: nv[0] }), "5%")
assert.strictEqual(Model.metricValue("gputemp", { gpu: nv[0] }), "45°")
assert.strictEqual(Model.metricValue("vram", { gpu: nv[0] }), "10%")
// nvidia-smi dGPU outranks an amdgpu iGPU by VRAM size.
const hybrid = Model.primaryGpu([{ card: "0", vramTotal: 512 * 1048576 }, nv[0]])
assert.strictEqual(hybrid.card, "nv0")
// GPU names arrive via the static GPUNAMES section.
const nvSample = Model.parseSample(
  "###GPUNAMES\n0|Vendor [X] Foo [Radeon RX]\n###GPU\n0|25|100|200|48000|12000000\n###NVIDIA\n0, NVIDIA GeForce RTX 4070, 12, 51, 2048, 12282, 45.2")
assert.strictEqual(nvSample.gpus.length, 2)
assert.strictEqual(nvSample.gpus[0].label, "GPU 0")
assert.strictEqual(nvSample.gpus[0].name, "Radeon RX")
assert.strictEqual(nvSample.gpus[0].powerW, 12, "amdgpu power µW → W")
assert.strictEqual(nvSample.gpus[1].label, "GPU 0 (NVIDIA)")
assert.strictEqual(nvSample.gpus[1].powerW, 45.2)

// APU memory pool: an iGPU's mem_info_vram_total is only the BIOS
// carve-out; its real ceiling adds GTT (shared system RAM). dGPUs keep
// plain VRAM, and pre-0.9.0 captures without the GTT fields still parse.
const apuSample = Model.parseSample(
  "###GPU\n0|5|268435456|536870912|48000|12000000|4294967296|16389763072|1\n" +
  "1|25|1073741824|17095983104|52000|220000000|97386496|16389763072|0")
assert.strictEqual(apuSample.gpus[0].apu, true)
assert.strictEqual(apuSample.gpus[0].gttTotal, 16389763072)
assert.strictEqual(apuSample.gpus[1].apu, false, "dGPU with mem_busy_percent")
assert.strictEqual(Model.gpuMemUsed(apuSample.gpus[0]), 268435456 + 4294967296, "APU pool adds GTT")
assert.strictEqual(Model.gpuMemTotal(apuSample.gpus[0]), 536870912 + 16389763072)
assert.strictEqual(Model.gpuMemUsed(apuSample.gpus[1]), 1073741824, "dGPU pool is VRAM alone")
assert.strictEqual(Model.gpuMemTotal(apuSample.gpus[1]), 17095983104)
assert.strictEqual(Model.metricValue("vram", { gpu: apuSample.gpus[0] }), "27%", "bar vram uses the pool")
assert.strictEqual(Model.metricUrgent("vram", { gpu: apuSample.gpus[0] }, Model.thresholdsFrom({ urgentVramPct: 25 })), true)
const oldFormat = Model.parseSample("###GPU\n0|25|100|200|48000|12000000").gpus[0]
assert.strictEqual(oldFormat.apu, false)
assert.strictEqual(oldFormat.gttTotal, 0)
assert.strictEqual(Model.gpuMemTotal(oldFormat), 200)
// Primary ranking stays on dedicated VRAM: a 2-CU iGPU's RAM-sized GTT
// must not outrank a real dGPU.
assert.strictEqual(Model.primaryGpu(apuSample.gpus).card, "1")

// Runtime-suspended NVIDIA: sampler emits "suspended"; last-known values
// replay as an asleep card that renders nothing in the bar.
const suspended = Model.parseSample("###GPU\n###NVIDIA\nsuspended")
assert.strictEqual(suspended.nvidiaSuspended, true)
assert.strictEqual(suspended.gpus.length, 0)
const asleep = Model.markGpuAsleep(nv[0])
assert.strictEqual(asleep.asleep, true)
assert.strictEqual(asleep.name, nv[0].name)
assert.strictEqual(asleep.vramTotal, nv[0].vramTotal, "keeps primary-GPU ranking")
assert.strictEqual(Model.metricValue("gpu", { gpu: asleep }), "", "asleep gpu hides")
assert.strictEqual(Model.metricValue("gputemp", { gpu: asleep }), "")
assert.strictEqual(Model.metricValue("vram", { gpu: asleep }), "")

// Implausible Super I/O temperatures are dropped, real ones kept.
const junk = Model.parseSample("###TEMP\nnct6799|AUXTIN1|-62000|\nnct6799|SYSTIN|32000|\nk10temp|Tctl|48000|")
assert.strictEqual(junk.temps.length, 2, "bogus -62° input filtered")
assert.strictEqual(Model.cpuTemp(junk.temps), 48)

// Fans share the temp line shape; zero RPM is kept.
const fans = Model.parseFans(["nct6798|fan2|1250|", "amdgpu||0|"])
assert.strictEqual(fans.length, 2)
assert.strictEqual(fans[0].rpm, 1250)
assert.strictEqual(fans[1].rpm, 0)
assert.strictEqual(Model.tempName(fans[1]), "GPU · amdgpu")

// Processes: pid pcpu pmem comm, comm keeps its spaces.
const ps = Model.parsePs([" 155995 46.4  2.5 Isolated Web Co", "  1451  1.9  0.7 Hyprland"])
assert.strictEqual(ps.length, 2)
assert.strictEqual(ps[0].comm, "Isolated Web Co")
assert.strictEqual(ps[0].cpu, 46.4)
assert.strictEqual(ps[1].pid, "1451")

// Batteries: energies in µWh, power in µW; desktops parse to an empty list
// and a null summary (this machine's mouse battery is filtered by scope).
assert.deepStrictEqual(sample.batteries, [], "no system battery on this desktop")
assert.strictEqual(Model.batterySummary(sample.batteries), null)
const bats = Model.parseBattery(["BAT0|Discharging|76|43200000|57000000|60500000|8300000|DELL XYZ"])
assert.strictEqual(bats.length, 1)
assert.strictEqual(bats[0].status, "Discharging")
assert.strictEqual(bats[0].energyNowWh, 43.2)
assert.strictEqual(bats[0].powerW, 8.3)
const summary = Model.batterySummary(bats)
assert.ok(Math.abs(summary.pct - 75.79) < 0.1, "pct from energies")
assert.strictEqual(summary.discharging, true)
assert.ok(Math.abs(summary.timeSec - 43.2 / 8.3 * 3600) < 1, "time remaining")
assert.ok(Math.abs(summary.healthPct - 94.21) < 0.1, "health from design")
const batData = { battery: summary }
assert.ok(Model.metricValue("bat", batData).includes("76%"), "battery bar metric")
assert.strictEqual(Model.metricValue("bat", { battery: null }), "", "no battery, no segment")
assert.strictEqual(Model.batteryIcon(100, false), "\u{f0079}")
assert.strictEqual(Model.batteryIcon(50, false), "\u{f007e}")
assert.strictEqual(Model.batteryIcon(50, true), "\u{f0084}")
assert.strictEqual(Model.metricUrgent("bat", { battery: summary }, null), false)
const low = Model.batterySummary(Model.parseBattery(["BAT0|Discharging|12|6000000|57000000|60500000|8300000|X"]))
assert.strictEqual(Model.metricUrgent("bat", { battery: low }, null), true, "low battery urgent")

// Alert messages reuse the threshold config.
assert.strictEqual(
  Model.alertText("cputemp", { cpuTemp: 92.4 }, Model.thresholdsFrom({})),
  "CPU temperature at 92° (threshold 85°)")
assert.strictEqual(
  Model.alertText("bat", { battery: low }, null),
  "Battery at 11% (threshold 15%)")
assert.ok(Model.ALERT_KEYS.indexOf("load") === -1, "load never alerts")

// Urgency thresholds — per-component temps, with the legacy single
// urgentTempC still honored as a CPU/GPU fallback.
const th = Model.thresholdsFrom({ urgentCpuPct: 80 })
assert.strictEqual(th.cpuPct, 80)
assert.strictEqual(th.cpuTempC, Model.DEFAULT_THRESHOLDS.cpuTempC)
assert.strictEqual(th.gpuTempC, 90)
assert.strictEqual(th.driveTempC, 70)
const perComponent = Model.thresholdsFrom({ urgentCpuTempC: 80, urgentGpuTempC: 100, urgentDriveTempC: 60 })
assert.strictEqual(perComponent.cpuTempC, 80)
assert.strictEqual(perComponent.gpuTempC, 100)
assert.strictEqual(perComponent.driveTempC, 60)
const legacy = Model.thresholdsFrom({ urgentTempC: 75 })
assert.strictEqual(legacy.cpuTempC, 75, "legacy urgentTempC covers cpu")
assert.strictEqual(legacy.gpuTempC, 75, "legacy urgentTempC covers gpu")
assert.strictEqual(Model.thresholdsFrom({ urgentTempC: 75, urgentGpuTempC: 95 }).gpuTempC, 95, "specific beats legacy")
assert.strictEqual(Model.metricUrgent("gputemp", { gpu: { celsius: 92, busy: 1 } }, perComponent), false)
assert.strictEqual(Model.metricUrgent("gputemp", { gpu: { celsius: 101, busy: 1 } }, perComponent), true)
// Drive-temperature alert (alert-only, never a bar segment).
const hotDrive = Model.hottestDrive([
  { chip: "k10temp", label: "Tctl", celsius: 80, device: "" },
  { chip: "nvme", label: "Composite", celsius: 72, device: "ADATA FALCON" },
  { chip: "nvme", label: "Composite", celsius: 55, device: "KINGSTON" }
])
assert.strictEqual(hotDrive.celsius, 72)
assert.strictEqual(Model.metricUrgent("drivetemp", { driveTemp: hotDrive }, null), true)
assert.strictEqual(Model.metricUrgent("drivetemp", { driveTemp: hotDrive }, perComponent), true)
assert.strictEqual(Model.metricUrgent("drivetemp", { driveTemp: null }, null), false)
assert.strictEqual(
  Model.alertText("drivetemp", { driveTemp: hotDrive }, null),
  "Drive temperature (ADATA FALCON) at 72° (threshold 70°)")
assert.ok(Model.ALERT_KEYS.indexOf("drivetemp") !== -1)
assert.strictEqual(Model.metricUrgent("cpu", { cpuPct: 85 }, th), true)
assert.strictEqual(Model.metricUrgent("cpu", { cpuPct: 85 }, null), false, "default threshold is 90")
assert.strictEqual(Model.metricUrgent("load", { load1: 17, cores: 16 }, null), true)
assert.strictEqual(Model.metricUrgent("load", { load1: 3, cores: 16 }, null), false)

// GPU/VRAM split off from the shared CPU/RAM values in 0.9.0; the old
// shared settings still cover them until their own are set.
assert.strictEqual(Model.thresholdsFrom({}).gpuPct, 90)
assert.strictEqual(Model.thresholdsFrom({ urgentCpuPct: 70 }).gpuPct, 70, "urgentCpuPct still covers gpu")
assert.strictEqual(Model.thresholdsFrom({ urgentCpuPct: 70, urgentGpuPct: 95 }).gpuPct, 95, "specific beats shared")
assert.strictEqual(Model.thresholdsFrom({ urgentMemPct: 60 }).vramPct, 60)
assert.strictEqual(Model.thresholdsFrom({ urgentVramPct: 85 }).vramPct, 85)
assert.strictEqual(Model.metricUrgent("gpu", { gpu: { busy: 96, celsius: 50 } }, Model.thresholdsFrom({ urgentGpuPct: 95 })), true)
assert.strictEqual(Model.metricUrgent("gpu", { gpu: { busy: 94, celsius: 50 } }, Model.thresholdsFrom({ urgentGpuPct: 95 })), false)

// Battery low and drive wear — hardcoded before 0.9.0 — are settings now.
assert.strictEqual(Model.thresholdsFrom({}).batPct, 15)
assert.strictEqual(Model.thresholdsFrom({}).wearPct, 90)
const batTh = Model.thresholdsFrom({ urgentBatPct: 30 })
assert.strictEqual(Model.metricUrgent("bat", { battery: { charging: false, pct: 25 } }, batTh), true, "custom low threshold")
assert.strictEqual(Model.metricUrgent("bat", { battery: { charging: false, pct: 25 } }, null), false, "default stays 15")
assert.ok(Model.alertText("bat", { battery: { pct: 25 } }, batTh).includes("threshold 30%"))

// Per-metric alert opt-in: off by default, list round-trips, unknown keys
// dropped.
assert.deepStrictEqual(Model.normalizeAlertsOn(null), [], "alerts off by default")
assert.deepStrictEqual(Model.normalizeAlertsOn(["cpu", "cpu", "bogus", "bat"]), ["cpu", "bat"])
let alertsOn = Model.toggleAlertOn(null, "cputemp")
assert.deepStrictEqual(alertsOn, ["cputemp"])
alertsOn = Model.toggleAlertOn(alertsOn, "drivehealth")
assert.strictEqual(alertsOn.length, 2)
assert.deepStrictEqual(Model.toggleAlertOn(alertsOn, "cputemp"), ["drivehealth"])
assert.deepStrictEqual(Model.toggleAlertOn([], "nonsense"), [], "unknown keys don't toggle on")
assert.strictEqual(Model.ALERT_SETTINGS.length, Model.ALERT_KEYS.length + 1, "every tick alert + drivehealth")
Model.ALERT_KEYS.forEach(k => assert.ok(Model.alertSettingByKey(k), "alert setting for " + k))
Model.ALERT_SETTINGS.forEach(a =>
  assert.ok(isFinite(Model.thresholdsFrom({})[a.thKey]), "thresholdsFrom resolves " + a.thKey))
// Groups drive the ALERTS-tab section headers, so every entry needs one
// and entries sharing a group must be contiguous.
{
  const seen = []
  for (const a of Model.ALERT_SETTINGS) {
    assert.ok(typeof a.group === "string" && a.group.length > 0, a.key + " has a group")
    if (seen[seen.length - 1] !== a.group) {
      assert.ok(!seen.includes(a.group), "group " + a.group + " is contiguous")
      seen.push(a.group)
    }
  }
}

// GPU-tab display order: primary card first, the rest in card order.
const ordered = Model.primaryFirstGpus(apuSample.gpus)
assert.strictEqual(ordered[0].card, "1", "primary (most dedicated VRAM) leads")
assert.strictEqual(ordered[1].card, "0")
assert.strictEqual(ordered.length, apuSample.gpus.length)
assert.deepStrictEqual(Model.primaryFirstGpus([]), [], "no GPUs, no reorder")

// Alert rows show the live reading the alert watches; unavailable
// readings (asleep GPU, no drive sensor) render nothing.
const nowData = { cpuPct: 43.2, cpuTemp: 61, memPct: 55, gpu: apuSample.gpus[0], disk: { used: 50, size: 100 }, driveTemp: hotDrive, battery: summary }
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("cpu"), nowData), "43%")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("cputemp"), nowData), "61°")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("vram"), nowData), "27%", "APU pool feeds the vram reading")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("drivetemp"), nowData), "72°")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("bat"), nowData), "76%")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("gputemp"), { gpu: Model.markGpuAsleep(nv[0]) }), "", "asleep GPU reads nothing")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("drivetemp"), { driveTemp: null }), "")
const nowHealth = Model.parseDriveHealth(["nvme2n1|nvme|A|10||9|0|0|0|0", "nvme1n1|nvme|B|10||91|0|0|0|0"])
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("drivehealth"), {}, nowHealth), "91%", "worst drive wear")
assert.strictEqual(Model.alertNowText(Model.alertSettingByKey("drivehealth"), {}, []), "")

// Threshold steppers clamp to each alert's bounds.
const cpuEntry = Model.alertSettingByKey("cpu")
assert.strictEqual(Model.stepAlertThreshold(cpuEntry, 90, 1), 95)
assert.strictEqual(Model.stepAlertThreshold(cpuEntry, 100, 1), 100, "clamped at max")
assert.strictEqual(Model.stepAlertThreshold(cpuEntry, 50, -1), 50, "clamped at min")
assert.strictEqual(Model.stepAlertThreshold(cpuEntry, NaN, 1), 95, "NaN falls back to the default")
assert.strictEqual(Model.alertLimitText(cpuEntry, Model.thresholdsFrom({})), "≥ 90%")
assert.strictEqual(Model.alertLimitText(Model.alertSettingByKey("bat"), Model.thresholdsFrom({})), "≤ 15%")
assert.strictEqual(Model.alertLimitText(Model.alertSettingByKey("drivehealth"), null), "≥ 90% worn")
const segs = Model.barSegments(["cpu", "ram"], { cpuPct: 95, memPct: 20 }, null)
assert.strictEqual(segs.length, 2)
assert.strictEqual(segs[0].urgent, true)
assert.strictEqual(segs[1].urgent, false)

// With nothing selected (or nothing renderable) the bar shows a placeholder
// icon so the panel stays reachable.
assert.strictEqual(Model.barText([], barData), Model.PLACEHOLDER_ICON)
assert.strictEqual(Model.barText(["gputemp"], { gpu: null }), Model.PLACEHOLDER_ICON)
assert.deepStrictEqual(Model.barLines([], barData), [{ text: Model.PLACEHOLDER_ICON, urgent: false }])
assert.ok(Model.barText(["cpu"], barData) !== Model.PLACEHOLDER_ICON)
const lines = Model.barLines(["cpu", "net", "io", "bat"], Object.assign({}, barData, { battery: summary }))
assert.strictEqual(lines.length, 4, "net and io skipped, cpu 2 lines + bat 2 lines")
assert.strictEqual(lines[3].text, "76%")

// Show-list editing: order preserved, moves clamp at the edges.
const toggled = Model.toggleShow(["cpu", "ram"], "disk")
assert.deepStrictEqual(toggled, ["cpu", "ram", "disk"])
assert.deepStrictEqual(Model.toggleShow(toggled, "ram"), ["cpu", "disk"])
assert.deepStrictEqual(Model.normalizeShow(["disk", "cpu", "bogus"]), ["disk", "cpu"], "stored order wins")
assert.deepStrictEqual(Model.moveShow(["cpu", "ram", "disk"], "disk", -1), ["cpu", "disk", "ram"])
assert.deepStrictEqual(Model.moveShow(["cpu", "ram"], "cpu", -1), ["cpu", "ram"], "clamped at top")
assert.deepStrictEqual(Model.moveShow(["cpu", "ram"], "ram", 1), ["cpu", "ram"], "clamped at bottom")

// PSI parsing (avg10 of each resource).
const psi = Model.parsePsi([
  "cpu some avg10=1.50 avg60=0.31 avg300=0.41 total=1",
  "cpu full avg10=0.00 avg60=0.00 avg300=0.00 total=0",
  "memory some avg10=0.10 avg60=0.00 avg300=0.00 total=1",
  "memory full avg10=0.05 avg60=0.00 avg300=0.00 total=1",
  "io some avg10=2.20 avg60=0.30 avg300=0.39 total=1"
])
assert.strictEqual(psi.cpu.some, 1.5)
assert.strictEqual(psi.cpu.some60, 0.31)
assert.strictEqual(psi.cpu.some300, 0.41)
assert.strictEqual(psi.memory.full, 0.05)
assert.strictEqual(psi.io.some, 2.2)
assert.strictEqual(Model.fmtPsi(psi.cpu, "some"), "1.5 / 0.3 / 0.4 %")
assert.strictEqual(Model.fmtPsi(psi.cpu, "full"), "0.0 / 0.0 / 0.0 %")
assert.strictEqual(Model.fmtPsi(null, "some"), "")
assert.strictEqual(Model.fmtPsi({ some: NaN }, "some"), "")
assert.ok(sample.psi.cpu && isFinite(sample.psi.cpu.some), "live PSI parsed")

// Virtual interfaces stay out of the totals but keep their per-iface rows.
const phys = Model.parseNetPhys(["eno1"])
const netA = [{ iface: "eno1", rx: 0, tx: 0 }, { iface: "tun0", rx: 0, tx: 0 }]
const netB = [{ iface: "eno1", rx: 1000, tx: 100 }, { iface: "tun0", rx: 900, tx: 90 }]
const filtered = Model.netRates(netA, netB, 1, phys)
assert.strictEqual(filtered.down, 1000, "tunnel excluded from totals")
assert.strictEqual(filtered.perIface.length, 2)
assert.strictEqual(filtered.perIface[1].virtual, true)
// All-virtual environments (containers) fall back to counting everything.
const allVirtual = Model.netRates(netA, netB, 1, Model.parseNetPhys([]))
assert.strictEqual(allVirtual.down, 1900)
if (!CI) assert.ok(Object.keys(sample.netPhys).length > 0, "live physical interfaces found")

// Intel GPUs: temp/power from hwmon, usage honestly unavailable.
const intel = Model.parseIntelGpus(["1|45000|8000000", "2||"], { "1": "Vendor [Arc A770]" })
assert.strictEqual(intel.length, 2)
assert.strictEqual(intel[0].label, "GPU 1 (Intel)")
assert.strictEqual(intel[0].name, "Arc A770")
assert.strictEqual(intel[0].celsius, 45)
assert.strictEqual(intel[0].powerW, 8)
assert.ok(Number.isNaN(intel[0].busy) && intel[0].noBusyCounter)
assert.ok(Number.isNaN(intel[1].celsius))
assert.strictEqual(Model.metricValue("gpu", { gpu: intel[0] }), "", "no busy → bar segment hidden")
const intelSample = Model.parseSample("###GPUINTEL\n0|41000|5500000\n###NVIDIA\n")
assert.strictEqual(intelSample.gpus.length, 1)

// Battery charge limit (9th field; absent or 100 → NaN).
const capped = Model.parseBattery(["BAT0|Not charging|80|45600000|57000000|60500000|0|X|80"])
assert.strictEqual(capped[0].chargeLimit, 80)
assert.ok(Number.isNaN(Model.parseBattery(["BAT0|Full|100|1|2|3|0|X|100"])[0].chargeLimit))
assert.ok(Number.isNaN(Model.parseBattery(["BAT0|Full|100|1|2|3|0|X"])[0].chargeLimit))

// Desktop-without-Super-I/O hint helpers.
assert.strictEqual(Model.isDesktopChassis(3), true)
assert.strictEqual(Model.isDesktopChassis(10), false, "laptop chassis")
assert.strictEqual(Model.hasMotherboardSensors([{ chip: "nct6799" }], []), true)
assert.strictEqual(Model.hasMotherboardSensors([{ chip: "k10temp" }, { chip: "nvme" }], [{ chip: "amdgpu" }]), false)
assert.strictEqual(Model.hasMotherboardSensors([], [{ chip: "it8620" }]), true)

// Static identity now includes kernel and chassis.
assert.ok(merged.kernel.length > 0, "kernel version parsed")
assert.ok(merged.chassisType > 0, "chassis type parsed")

// Per-sensor thresholds: stable keys, clamped values, off = removed.
const sensor = { chip: "nvme", label: "Composite", celsius: 62, device: "ADATA FALCON" }
const skey = Model.sensorKey(sensor)
assert.strictEqual(skey, "nvme|ADATA FALCON|Composite")
let sensorMap = Model.setSensorThreshold(null, skey, 70)
assert.strictEqual(Model.sensorThreshold(sensorMap, sensor), 70)
sensorMap = Model.setSensorThreshold(sensorMap, skey, 200)
assert.strictEqual(sensorMap[skey], Model.SENSOR_THRESHOLD_MAX, "clamped to max")
sensorMap = Model.setSensorThreshold(sensorMap, skey, NaN)
assert.ok(!(skey in sensorMap), "NaN removes the threshold")
assert.strictEqual(Model.sensorThreshold(sensorMap, sensor), NaN === NaN ? NaN : NaN)
assert.ok(Number.isNaN(Model.sensorThreshold(sensorMap, sensor)))
assert.deepStrictEqual(Model.normalizeSensorThresholds({ good: 75, low: 5, junk: "x" }), { good: 75 }, "invalid entries dropped")
assert.strictEqual(Model.suggestedSensorThreshold(62), 75, "current+10 on a 5° grid")
assert.strictEqual(Model.suggestedSensorThreshold(NaN), 70)

// Hidden sensors: dedup, toggle round-trips.
let hidden = Model.toggleHiddenSensor(null, "nct6799||AUXTIN1")
assert.deepStrictEqual(hidden, ["nct6799||AUXTIN1"])
hidden = Model.toggleHiddenSensor(hidden, "nct6799||AUXTIN5")
assert.strictEqual(hidden.length, 2)
assert.deepStrictEqual(Model.toggleHiddenSensor(hidden, "nct6799||AUXTIN1"), ["nct6799||AUXTIN5"])
assert.deepStrictEqual(Model.normalizeHiddenSensors(["a", "a", 3, ""]), ["a"])

// Process display names: argv0 path stripped, kernel threads untouched.
assert.strictEqual(Model.procDisplay("/usr/lib/zen/zen-bin --flag x"), "zen-bin --flag x")
assert.strictEqual(Model.procDisplay("[kworker/0:1-events]"), "[kworker/0:1-events]")
assert.strictEqual(Model.procDisplay("Isolated Web Content"), "Isolated Web Content")
assert.ok(sample.psCpu.every(p => p.comm.length > 0), "args-based names parsed")

// Sparkline history is fixed-length and NaN-safe.
let hist = []
for (let i = 0; i < Model.HISTORY_LEN + 10; i++) hist = Model.pushHistory(hist, i)
assert.strictEqual(hist.length, Model.HISTORY_LEN)
assert.strictEqual(hist[hist.length - 1], Model.HISTORY_LEN + 9)
assert.strictEqual(Model.pushHistory([], NaN)[0], 0)

// Bar segments pad values with no-break spaces so the bar keeps a stable
// width as numbers change; unpadded callers (vertical bar) are untouched.
const NBSP = "\u00A0"
assert.strictEqual(Model.padValue("5%", 3), NBSP + "5%")
assert.strictEqual(Model.padValue("100%", 3), "100%", "wide values never truncate")
assert.strictEqual(Model.metricValue("cpu", { cpuPct: 5 }, true), NBSP + "5%")
assert.strictEqual(Model.metricValue("cpu", { cpuPct: 5 }), "5%", "no pad by default")
assert.strictEqual(Model.metricValue("io", { io: { read: 0, write: 1048576 } }, true),
  "R" + NBSP + NBSP + NBSP + "0 W1.0M")
assert.strictEqual(Model.metricValue("gputemp", { gpu: null }, true), "", "empty stays empty, not padded")
const paddedSegs = Model.barSegments(["cpu"], { cpuPct: 5 }, null)
assert.ok(paddedSegs[0].text.includes(NBSP + "5%"), "bar segments use padded values")
assert.deepStrictEqual(Model.barLines(["cpu"], { cpuPct: 5 })[1].text, "5%", "vertical bar stays unpadded")

// TEMP-tab grouping: sensors sharing a device collapse under one title.
const grouped = Model.groupTemps([
  { chip: "nvme", label: "Composite", celsius: 40, device: "KINGSTON SNV3S1000G" },
  { chip: "nvme", label: "Sensor 1", celsius: 42, device: "KINGSTON SNV3S1000G" },
  { chip: "nct6799", label: "SYSTIN", celsius: 36, device: "" },
  { chip: "nct6799", label: "CPUTIN", celsius: 43, device: "" },
  { chip: "mt7921_phy0", label: "", celsius: 50, device: "" }
])
assert.strictEqual(grouped.length, 3)
assert.strictEqual(grouped[0].title, "NVMe · KINGSTON SNV3S1000G")
assert.strictEqual(grouped[0].sensors.length, 2)
assert.strictEqual(grouped[1].title, "Motherboard · nct6799")
assert.strictEqual(grouped[2].title, "Wi-Fi · mt7921_phy0")
assert.strictEqual(Model.sensorRowLabel(grouped[0].sensors[1]), "Sensor 1")
assert.strictEqual(Model.sensorRowLabel(grouped[2].sensors[0]), "Temperature", "unnamed sensor gets a generic row label")
assert.strictEqual(Model.tempName(grouped[2].sensors[0]), "Wi-Fi · mt7921_phy0", "tempName unchanged for fans")

// Alert attribution: CPU-driven alerts name the top CPU process, memory
// alerts the top memory process; rates and drive temps stay unattributed.
const psCpuFix = Model.parsePs([" 4242 61.0  2.0 /usr/lib/chromium/chromium --type=renderer"])
const psMemFix = Model.parsePs([" 1111  1.0 12.5 /usr/lib/zen/zen-bin -contentproc"])
assert.strictEqual(Model.attributionFor("cpu", psCpuFix, psMemFix, 0), "chromium 61%")
assert.strictEqual(Model.attributionFor("cputemp", psCpuFix, psMemFix, 0), "chromium 61%")
assert.strictEqual(Model.attributionFor("ram", psCpuFix, psMemFix, 32 * 1073741824), "zen-bin 4.0 GB")
assert.strictEqual(Model.attributionFor("cpu", [], [], 0), "", "empty list → no attribution")
assert.strictEqual(Model.attributionFor("gputemp", psCpuFix, psMemFix, 0), "", "gpu temp unattributed")
assert.ok(Model.attributableAlert("cpu") && Model.attributableAlert("ram"))
assert.ok(!Model.attributableAlert("io") && !Model.attributableAlert("drivetemp"))

// The one-shot ps sampler mode emits just the process sections.
const psOnly = Model.parseSample(execSync("bash " + script + " ps").toString())
assert.ok(psOnly.psCpu.length > 0 && psOnly.psMem.length > 0, "ps mode samples processes")
assert.strictEqual(psOnly.host, "", "ps mode carries nothing else")
assert.strictEqual(psOnly.cpus.length, 0)

// Alert markers land on the sparkline slot for their timestamp; alerts
// older than the window drop out, same-slot alerts collapse.
const nowMs = 1000000
assert.deepStrictEqual(Model.markerIndices([nowMs], nowMs, 2, 60), [0], "just fired → right edge")
assert.deepStrictEqual(Model.markerIndices([nowMs - 20000], nowMs, 2, 60), [10])
assert.deepStrictEqual(Model.markerIndices([nowMs - 300000], nowMs, 2, 60), [], "outside the window")
assert.deepStrictEqual(Model.markerIndices([nowMs - 20000, nowMs - 20500], nowMs, 2, 60), [10], "deduped")
assert.deepStrictEqual(Model.markerIndices([], nowMs, 2, 60), [])

// Tiered history: the hour ring accumulates each slot's peak, closes slots
// on the wall clock, and renders the live partial slot at the right edge.
let hour = Model.emptyHourHist()
const t0 = 5000000
hour = Model.pushHourHist(hour, { cpu: 10, mem: 1, gpu: 0, netDown: 100, netUp: 0, ioRead: 0, ioWrite: 0 }, t0)
hour = Model.pushHourHist(hour, { cpu: 80, mem: 2, gpu: 0, netDown: 50, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + 2000)
hour = Model.pushHourHist(hour, { cpu: 20, mem: 3, gpu: 0, netDown: 70, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + 4000)
assert.deepStrictEqual(hour.cpu.values, [], "slot still open")
assert.deepStrictEqual(Model.hourValues(hour, "cpu"), [80], "partial slot shows the running peak")
assert.deepStrictEqual(Model.hourValues(hour, "netDown"), [100])
// 60s later the slot closes with its peak and a new one starts.
hour = Model.pushHourHist(hour, { cpu: 30, mem: 4, gpu: 0, netDown: 10, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + 61000)
assert.deepStrictEqual(hour.cpu.values, [80], "closed slot kept the peak")
assert.ok(Number.isNaN(hour.cpu.acc), "next slot starts empty")
hour = Model.pushHourHist(hour, { cpu: 5, mem: 4, gpu: NaN, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + 63000)
assert.deepStrictEqual(Model.hourValues(hour, "cpu"), [80, 5], "completed + partial")
assert.deepStrictEqual(Model.hourValues(hour, "gpu"), [0, 0], "NaN series folds to 0")
// The ring caps at HISTORY_LEN even with the partial slot appended.
let hourCap = Model.emptyHourHist()
for (let i = 0; i < Model.HISTORY_LEN + 5; i++) {
  hourCap = Model.pushHourHist(hourCap, { cpu: i, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + i * 61000)
}
assert.strictEqual(Model.hourValues(hourCap, "cpu").length, Model.HISTORY_LEN)
assert.deepStrictEqual(Model.hourValues(Model.emptyHourHist(), "cpu"), [], "empty ring renders empty")

// Per-process GPU: fdinfo clients dedupe, aggregate per (pid, card), and
// derive usage from cumulative engine-time deltas.
const gpuProcSample = Model.parseSample(
  "###GPUPDEV\n0|0000:0f:00.0\n1|0000:03:00.0\n###GPUPROC\n" +
  "100|zen-bin|0000:03:00.0|7|1000000000|1024\n" +
  "100|zen-bin|0000:03:00.0|9|2000000000|2048\n" +
  "200|Hyprland|0000:0f:00.0|3|500000000|512")
assert.deepStrictEqual(gpuProcSample.gpuPdev, { "0": "0000:0f:00.0", "1": "0000:03:00.0" })
assert.strictEqual(gpuProcSample.gpuProcs.length, 3)
const gpuPrev = gpuProcSample.gpuProcs
const gpuCur = [
  { pid: "100", comm: "zen-bin", pdev: "0000:03:00.0", client: "7", engineNs: 1000000000 + 6e8, vramKib: 1024 },
  { pid: "100", comm: "zen-bin", pdev: "0000:03:00.0", client: "9", engineNs: 2000000000 + 4e8, vramKib: 2048 },
  { pid: "200", comm: "Hyprland", pdev: "0000:0f:00.0", client: "3", engineNs: 500000000 + 1e8, vramKib: 512 }
]
const gpuRates = Model.gpuProcRates(gpuPrev, gpuCur, 2)
assert.strictEqual(gpuRates.length, 2, "clients aggregate per pid+card")
assert.strictEqual(gpuRates[0].comm, "zen-bin")
assert.ok(Math.abs(gpuRates[0].pct - 50) < 0.01, "0.6s + 0.4s over 2s = 50%")
assert.strictEqual(gpuRates[0].vramKib, 3072)
assert.ok(Math.abs(gpuRates[1].pct - 5) < 0.01)
assert.strictEqual(Model.gpuProcRates(null, gpuCur, 2)[0].pct, 0, "no prev → no rate, vram still present")
// A restarted client (counter went backwards) contributes no rate.
const restarted = [{ pid: "100", comm: "x", pdev: "a", client: "7", engineNs: 10, vramKib: 0 }]
assert.strictEqual(Model.gpuProcRates(gpuPrev, restarted, 2)[0].pct, 0)
// Parallel engines can sum past 100; the cap keeps the display honest.
const hot = Model.gpuProcRates(
  [{ pid: "1", comm: "x", pdev: "a", client: "1", engineNs: 0, vramKib: 0 },
   { pid: "1", comm: "x", pdev: "a", client: "2", engineNs: 0, vramKib: 0 }],
  [{ pid: "1", comm: "x", pdev: "a", client: "1", engineNs: 2e9, vramKib: 0 },
   { pid: "1", comm: "x", pdev: "a", client: "2", engineNs: 2e9, vramKib: 0 }], 2)
assert.strictEqual(hot[0].pct, 100)

// Drive health from udisks2: NVMe with attributes, SATA with the failing
// flag, and the bad-drive predicate.
const health = Model.parseDriveHealth([
  "nvme2n1|nvme|ADATA FALCON|3565||9|0|0|0|195",
  "nvme1n1|nvme|WDC WDS480G2G0C-00AJM0|15257|spare-low|91|120|0|3|149",
  "sda|ata|WD Blue|20000|failing"
])
assert.strictEqual(health.length, 3)
assert.strictEqual(health[0].wearPct, 9)
assert.strictEqual(health[0].unsafeShutdowns, 195)
assert.strictEqual(Model.driveHealthBad(health[0]), false, "worn 9% is fine")
assert.strictEqual(Model.driveHealthBad(health[1]), true, "critical warning + worn 91%")
assert.strictEqual(Model.driveHealthBad(health[2]), true, "SATA failing flag")
assert.strictEqual(Model.fmtDriveHealth(health[0]), "worn 9% · on 148d 13h · healthy")
assert.ok(Model.fmtDriveHealth(health[1]).includes("spare-low"))
assert.ok(Model.fmtDriveHealth(health[2]).includes("failing"))
const mediaErr = Model.parseDriveHealth(["nvme0n1|nvme|X|10||5|0|0|2|0"])[0]
assert.strictEqual(Model.driveHealthBad(mediaErr), true, "media errors are bad")
assert.strictEqual(Model.driveHealthBad(health[0], 5), true, "worn 9% trips a 5% wear alarm")
assert.strictEqual(Model.driveHealthBad(health[1], 95), true, "critical warning trips at any wear level")
assert.ok(Model.fmtDriveHealth(mediaErr).includes("2 media errors"))
// The live health mode parses (may be empty where udisks2 is absent — CI).
const liveHealth = Model.parseSample(execSync("bash " + script + " health").toString())
assert.ok(Array.isArray(liveHealth.driveHealth))
if (!CI) assert.ok(liveHealth.driveHealth.length > 0, "live drives found via udisks2")
// The panel sample carries GPU clients on machines with fdinfo drivers.
const livePanel = Model.parseSample(execSync("bash " + script + " dynamic panel").toString())
assert.ok(Array.isArray(livePanel.gpuProcs))
if (!CI) assert.ok(livePanel.gpuProcs.length > 0, "live DRM clients found")

// ---- Fixture corpus -------------------------------------------------------
// Every file in tests/fixtures/ is a scrubbed `sample.sh` capture from a
// real machine (see tests/make-fixture.sh). Each one must parse cleanly
// and survive every derived-value path — a contributed fixture makes that
// hardware's layout a permanent regression test.
const fs = require("fs")
const fixturesDir = path.join(__dirname, "fixtures")
const fixtures = fs.readdirSync(fixturesDir).filter(f => f.endsWith(".txt"))
assert.ok(fixtures.length > 0, "fixture corpus present")
for (const name of fixtures) {
  const fx = Model.parseSample(fs.readFileSync(path.join(fixturesDir, name), "utf8"))
  const tag = "fixture " + name + ": "
  assert.ok(fx.cpus.length > 1, tag + "cpu lines")
  assert.ok(fx.mem.total > 0, tag + "memory")
  assert.ok(fx.disks.every(d => d.size > 0), tag + "disk sizes")
  assert.ok(fx.temps.every(t => t.celsius > -41 && t.celsius < 251), tag + "plausible temps")
  assert.ok(fx.gpus.every(g => g.card !== "" && g.label !== ""), tag + "gpu identity")
  // Every derived path the panel renders must hold up on this hardware.
  Model.groupTemps(fx.temps).forEach(g => assert.ok(g.title.length > 0, tag + "group titles"))
  fx.temps.forEach(t => assert.ok(Model.tempName(t).length > 0, tag + "sensor names"))
  fx.fans.forEach(f => assert.ok(Model.tempName(f).length > 0, tag + "fan names"))
  Model.cpuUsage(null, fx.cpus)
  Model.netRates(null, fx.net, 1, fx.netPhys)
  Model.ioRates(null, fx.io, 1, fx.diskModels, fx.diskLinks)
  const fbd = {
    cpuPct: 1, cpuTemp: Model.cpuTemp(fx.temps), memPct: 1,
    gpu: Model.primaryGpu(fx.gpus), disk: Model.diskFor(fx.disks, "/"),
    io: { read: 0, write: 0 }, netDown: 0, netUp: 0,
    load1: fx.load.load1, cores: fx.cpus.length - 1,
    battery: Model.batterySummary(fx.batteries),
    driveTemp: Model.hottestDrive(fx.temps)
  }
  const allKeys = Model.METRICS.map(m => m.key)
  assert.ok(Model.barText(allKeys, fbd).length > 0, tag + "bar renders")
  Model.barLines(allKeys, fbd, null)
  Model.ALERT_KEYS.forEach(k => assert.ok(Model.alertText(k, fbd, null).length > 0, tag + "alert texts"))
  fx.driveHealth.forEach(d => assert.ok(Model.fmtDriveHealth(d).length > 0, tag + "drive health"))
}
console.log("fixtures:", fixtures.join(" "))

console.log("bar text:", barText)
console.log("cpu temp:", Model.fmtTemp(barData.cpuTemp), "gpus:", sample.gpus.length,
  "disks:", sample.disks.map(d => d.mount).join(" "),
  "io disks:", io.perDisk.map(d => d.dev).join(" "),
  "fans:", sample.fans.length, "procs:", sample.psCpu.length)
console.log("all tests passed")
