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

// Urgency thresholds.
const th = Model.thresholdsFrom({ urgentCpuPct: 80 })
assert.strictEqual(th.cpuPct, 80)
assert.strictEqual(th.tempC, Model.DEFAULT_THRESHOLDS.tempC)
assert.strictEqual(Model.metricUrgent("cpu", { cpuPct: 85 }, th), true)
assert.strictEqual(Model.metricUrgent("cpu", { cpuPct: 85 }, null), false, "default threshold is 90")
assert.strictEqual(Model.metricUrgent("load", { load1: 17, cores: 16 }, null), true)
assert.strictEqual(Model.metricUrgent("load", { load1: 3, cores: 16 }, null), false)
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

// Sparkline history is fixed-length and NaN-safe.
let hist = []
for (let i = 0; i < Model.HISTORY_LEN + 10; i++) hist = Model.pushHistory(hist, i)
assert.strictEqual(hist.length, Model.HISTORY_LEN)
assert.strictEqual(hist[hist.length - 1], Model.HISTORY_LEN + 9)
assert.strictEqual(Model.pushHistory([], NaN)[0], 0)

console.log("bar text:", barText)
console.log("cpu temp:", Model.fmtTemp(barData.cpuTemp), "gpus:", sample.gpus.length,
  "disks:", sample.disks.map(d => d.mount).join(" "),
  "io disks:", io.perDisk.map(d => d.dev).join(" "),
  "fans:", sample.fans.length, "procs:", sample.psCpu.length)
console.log("all tests passed")
