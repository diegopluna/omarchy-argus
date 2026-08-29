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
assert.ok(Model.parseSample(panelText).psAll.length <= 60, "panel ships the top 60 by default")
assert.ok(Model.parseSample(execSync("bash " + script + " dynamic panel procs").toString()).psAll.length > 60,
  "procs flag ships the full table")

// The shell parses the static half once and hands it back as context, so
// dynamic ticks parse alone but keep the identity fields.
const staticCtx = Model.parseSample(staticText)
const ctxMerged = Model.parseSample(dynamicText, staticCtx)
assert.strictEqual(ctxMerged.host, sample.host, "host from context")
assert.strictEqual(ctxMerged.cpuName, sample.cpuName)
assert.strictEqual(ctxMerged.cpuTopo, staticCtx.cpuTopo, "topology is the same object, not a re-parse")
assert.ok(Object.keys(ctxMerged.diskModels).length > 0, "disk models from context")
if (!CI) assert.ok(ctxMerged.disks.some(d => d.model !== ""), "dynamic disks still get their models")

// The fast tick skips the sensor bus entirely; the shell replays the
// last temperatures between full ticks.
const fastText = execSync("bash " + script + " dynamic fast").toString()
const fastParsed = Model.parseSample(fastText, staticCtx)
assert.strictEqual(fastParsed.temps.length, 0, "fast tick carries no temps")
assert.strictEqual(fastParsed.fans.length, 0)
assert.ok(fastParsed.cpus.length > 1, "fast tick still carries the stats")

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

// GPU display names from lspci: the last bracket wins unless it is a bare
// vendor tag — "[AMD/ATI] Phoenix1" must yield the chip, not the vendor.
assert.strictEqual(Model.prettyGpuName("Advanced Micro Devices, Inc. [AMD/ATI] Phoenix1 (rev c1)"), "Phoenix1")
assert.strictEqual(Model.prettyGpuName("Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070/9070 XT/9070 GRE] (rev c0)"), "Radeon RX 9070/9070 XT/9070 GRE")
assert.strictEqual(Model.prettyGpuName("NVIDIA Corporation GA102 [GeForce RTX 3080] (rev a1)"), "GeForce RTX 3080")
assert.strictEqual(Model.prettyGpuName("Intel Corporation DG2 [Arc A770]"), "Arc A770")
assert.strictEqual(Model.prettyGpuName("Advanced Micro Devices, Inc. [AMD/ATI]"), "Advanced Micro Devices, Inc. [AMD/ATI]", "nothing after the vendor tag keeps the raw name")

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
// iGPU die codenames mean nothing to most people; APUs get a plain name.
assert.strictEqual(apuSample.gpus[0].name, "AMD Integrated Graphics")
assert.notStrictEqual(apuSample.gpus[1].name, "AMD Integrated Graphics", "dGPU keeps its lspci name")

// The ALERTS tab's sensor-alert overview: armed thresholds resolve to
// live sensors; stale keys still render by their key parts.
const sensorRows = Model.sensorAlertRows(
  { "nvme|ADATA FALCON|Composite": 70, "nct6799||SYSTIN": 55, "gone|OLD|x": 90 },
  [{ chip: "nvme", label: "Composite", celsius: 62, device: "ADATA FALCON" },
   { chip: "nct6799", label: "SYSTIN", celsius: 36, device: "" }])
assert.strictEqual(sensorRows.length, 3)
const nvmeRow = sensorRows.find(r => r.key.startsWith("nvme"))
assert.strictEqual(nvmeRow.label, "NVMe · ADATA FALCON · Composite")
assert.strictEqual(nvmeRow.now, 62)
assert.strictEqual(nvmeRow.limit, 70)
const staleRow = sensorRows.find(r => r.key.startsWith("gone"))
assert.strictEqual(staleRow.label, "gone · OLD · x", "unplugged sensor renders by key")
assert.ok(Number.isNaN(staleRow.now))
assert.deepStrictEqual(Model.sensorAlertRows({}, []), [])

// Home tiles: same list mechanics as the bar's `show`.
assert.deepStrictEqual(Model.normalizeHomeTiles(null), Model.DEFAULT_HOME)
assert.deepStrictEqual(Model.normalizeHomeTiles(["disk", "cpu", "junk", "cpu"]), ["disk", "cpu"])
assert.deepStrictEqual(Model.toggleHomeTile(["cpu"], "bat"), ["cpu", "bat"])
assert.deepStrictEqual(Model.toggleHomeTile(["cpu", "bat"], "cpu"), ["bat"])
Model.HOME_TILES.forEach(t => assert.ok(t.key && t.label && t.icon && t.tab, "tile " + t.key + " complete"))
assert.deepStrictEqual(Model.sumHist([1, 2, 3], [10, 20, 30]), [11, 22, 33])
assert.deepStrictEqual(Model.sumHist([2, 3], [10, 20, 30]), [10, 22, 33], "shorter ring aligns to the right edge")
assert.deepStrictEqual(Model.sumHist([], []), [])

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

// Processes: pid user pcpu pmem nlwp args — args keeps its spaces, and
// the pre-0.10 four-field shape still parses.
const ps = Model.parsePs([" 155995 dpeter           46.4  2.5  143 Isolated Web Co", "  1451 root              1.9  0.7   21 Hyprland --flag"])
assert.strictEqual(ps.length, 2)
assert.strictEqual(ps[0].comm, "Isolated Web Co")
assert.strictEqual(ps[0].user, "dpeter")
assert.strictEqual(ps[0].threads, 143)
assert.strictEqual(ps[0].cpu, 46.4)
assert.strictEqual(ps[1].pid, "1451")
assert.strictEqual(ps[1].comm, "Hyprland --flag")
const legacyPs = Model.parsePs([" 155995 46.4  2.5 Isolated Web Co"])
assert.strictEqual(legacyPs[0].comm, "Isolated Web Co")
assert.strictEqual(legacyPs[0].user, "")

// Process table slicing: filter matches name/user/pid, sorts are stable
// per key, the cap reports what it hid, and psCpu/psMem derive from the
// one full table.
const table = Model.parsePs([
  "  10 alice  50.0  1.0  4 zen-bin",
  "  20 bob     5.0 30.0  2 postgres",
  "  30 alice   1.0  2.0  1 bash",
  "  40 root    9.0  0.5  8 Xorg"
])
assert.strictEqual(Model.filterProcs(table, "alice").length, 2, "filter by user")
assert.strictEqual(Model.filterProcs(table, "POSTG").length, 1, "filter is case-insensitive")
assert.strictEqual(Model.filterProcs(table, "40")[0].comm, "Xorg", "filter by pid")
assert.strictEqual(Model.sortProcs(table, "cpu", false)[0].comm, "zen-bin")
assert.strictEqual(Model.sortProcs(table, "mem", false)[0].comm, "postgres")
assert.strictEqual(Model.sortProcs(table, "pid", true)[0].pid, "10")
assert.strictEqual(Model.sortProcs(table, "name", true)[0].comm, "bash", "name sort uses the display name")
const cappedProcs = Model.visibleProcs(table, "", "cpu", false, 2)
assert.strictEqual(cappedProcs.rows.length, 2)
assert.strictEqual(cappedProcs.hidden, 2)
assert.strictEqual(Model.visibleProcs(table, "alice", "cpu", false, 40).hidden, 0)
assert.strictEqual(Model.topProcs(table, "mem", 1)[0].comm, "postgres")
const psSample = Model.parseSample("###PS\n  10 alice  50.0  1.0  4 zen-bin\n  20 bob     5.0 30.0  2 postgres")
assert.strictEqual(psSample.psAll.length, 2)
assert.strictEqual(psSample.psCpu[0].comm, "zen-bin", "psCpu derives from the full table")
assert.strictEqual(psSample.psMem[0].comm, "postgres")

// Memory breakdown: free(1)'s used/cache/free accounting sums to total.
const memFx = Model.parseSample(
  "###MEM\nMemTotal: 1000 kB\nMemFree: 300 kB\nMemAvailable: 600 kB\nBuffers: 50 kB\nCached: 250 kB\nSReclaimable: 100 kB\nDirty: 8 kB\nSwapTotal: 500 kB\nSwapFree: 500 kB").mem
const split = Model.memBreakdown(memFx)
assert.strictEqual(split.cache, 400 * 1024)
assert.strictEqual(split.used, 300 * 1024)
assert.strictEqual(split.used + split.cache + split.free, split.total)
assert.strictEqual(memFx.dirty, 8 * 1024)

// Swap kinds: zram flagged so compressed-RAM swap reads as such.
assert.strictEqual(Model.swapNote(Model.parseSwaps(["/dev/zram0 partition 32010236 0 100"])), "zram (compressed RAM)")
assert.strictEqual(Model.swapNote(Model.parseSwaps(["/dev/zram0 partition 1 0 100", "/swap/swapfile file 1 0 -2"])), "zram + disk")
assert.strictEqual(Model.swapNote(Model.parseSwaps(["/dev/sda2 partition 1 0 -2"])), "")
assert.strictEqual(Model.swapNote([]), "")

// NET identity: kind/IP/SSID per interface; a "|" in an SSID can't shift
// fields because SSID is the tail.
const netInfo = Model.parseNetInfo(["eno1|eth|192.168.0.10/24|", "wlp1s0|wifi|10.0.0.5/16|My|Cafe Wi-Fi", "tun0|virtual||"])
assert.strictEqual(netInfo.eno1.kind, "eth")
assert.strictEqual(netInfo.eno1.addr, "192.168.0.10", "prefix length stripped")
assert.strictEqual(netInfo.wlp1s0.ssid, "My|Cafe Wi-Fi")
assert.strictEqual(Model.netIfaceDetail(netInfo.wlp1s0), "My|Cafe Wi-Fi · 10.0.0.5")
assert.strictEqual(Model.netIfaceDetail(netInfo.eno1), "192.168.0.10")
assert.strictEqual(Model.netIfaceDetail(netInfo.tun0), "")
assert.strictEqual(Model.netIfaceDetail(undefined), "")

// CPU topology: SMT siblings fuse into cores, L3 domains become groups
// (labeled CCDs when there are several), and a hybrid chip's slow cores
// are flagged via rated-ceiling spread.
const topo = Model.parseCpuTopo([
  "0|0|0-7|5000000", "4|0|0-7|5000000",
  "1|1|0-7|5000000", "5|1|0-7|5000000",
  "2|2|8-15|5000000", "6|2|8-15|5000000",
  "3|3|8-15|5000000", "7|3|8-15|5000000"
])
assert.strictEqual(topo.length, 8)
assert.strictEqual(topo[0].cpu, 0, "sorted numerically")
const dualCcd = Model.cpuTopoGroups(topo)
assert.strictEqual(dualCcd.groups.length, 2)
assert.strictEqual(dualCcd.groups[0].label, "CCD 0")
assert.strictEqual(dualCcd.groups[0].cores.length, 2)
assert.deepStrictEqual(dualCcd.groups[0].cores[0].cpus, [0, 4], "SMT siblings share a core cell")
assert.strictEqual(dualCcd.smt, true)
assert.strictEqual(dualCcd.hybrid, false)
const hybridTopo = Model.cpuTopoGroups(Model.parseCpuTopo([
  "0|0|0-9|5500000", "1|0|0-9|5500000", "2|1|0-9|5500000", "3|1|0-9|5500000",
  "4|2|0-9|4000000", "5|3|0-9|4000000"
]))
assert.strictEqual(hybridTopo.groups.length, 1)
assert.strictEqual(hybridTopo.groups[0].label, "", "single domain stays unlabeled")
assert.strictEqual(hybridTopo.hybrid, true)
assert.strictEqual(hybridTopo.groups[0].cores[2].eff, true, "4.0 GHz core under a 5.5 GHz peak is an E-core")
assert.strictEqual(hybridTopo.groups[0].cores[0].eff, false)
assert.strictEqual(Model.cpuTopoGroups([]).groups.length, 0, "no topology, no groups")
assert.strictEqual(Model.groupFreqText(dualCcd.groups[0], Model.parseCpuFreq(["0|4400000", "4|4600000", "1|4500000", "5|4500000"])), "4.50 GHz")
assert.strictEqual(Model.groupFreqText(dualCcd.groups[0], {}), "")
if (!CI) {
  assert.ok(sample.cpuTopo.length > 1, "live topology parsed")
  assert.ok(Model.cpuTopoGroups(sample.cpuTopo).groups.length > 0)
  assert.ok(sample.psAll.length > 20, "live full process table")
  assert.ok(Object.keys(sample.cpuFreq).length > 1, "live frequencies")
  assert.ok(sample.swaps.length >= 0)
}

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
assert.strictEqual(intel[1].name, "Intel Integrated Graphics", "nameless Intel card gets a plain name")
assert.strictEqual(Model.parseIntelGpus(["3|1000|"], { "3": "Intel Corporation Raptor Lake-P (rev 4)" })[0].name,
  "Intel Integrated Graphics", "codename-only lspci gets the plain name")
assert.strictEqual(Model.parseIntelGpus(["4|1000|"], { "4": "Intel Corporation [UHD Graphics 770]" })[0].name,
  "UHD Graphics 770", "real product names pass through")
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

// The day ring is the same machinery at a wider slot; spans cycle and
// resolve to their slot widths.
let day = Model.emptyHourHist()
day = Model.pushHourHist(day, { cpu: 40, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 }, t0, Model.DAY_SLOT_SEC)
day = Model.pushHourHist(day, { cpu: 10, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + 120000, Model.DAY_SLOT_SEC)
assert.deepStrictEqual(day.cpu.values, [], "2 minutes doesn't close a 24-minute slot")
assert.strictEqual(day.cpu.acc, 40)
day = Model.pushHourHist(day, { cpu: 5, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 }, t0 + Model.DAY_SLOT_SEC * 1000 + 1000, Model.DAY_SLOT_SEC)
assert.deepStrictEqual(day.cpu.values, [40], "slot closed with its peak")
assert.strictEqual(Model.DAY_SLOT_SEC * Model.HISTORY_LEN, 86400, "60 day slots span 24h")
assert.strictEqual(Model.nextSpan("2m"), "1h")
assert.strictEqual(Model.nextSpan("24h"), "2m", "span cycle wraps")
assert.strictEqual(Model.spanSlotSec("1h", 2), Model.HOUR_SLOT_SEC)
assert.strictEqual(Model.spanSlotSec("24h", 2), Model.DAY_SLOT_SEC)
assert.strictEqual(Model.spanSlotSec("2m", 2), 2)

// The flight recorder: serialize → restore round-trips the rings and
// alert log, renders downtime as empty slots, and refuses malformed or
// wrong-version files.
{
  const tick = c => ({ cpu: c, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0 })
  let ring = Model.emptyHourHist()
  ring = Model.pushHourHist(ring, tick(70), t0)          // opens the first slot
  ring = Model.pushHourHist(ring, tick(20), t0 + 61000)  // closes it (peak 70)
  ring = Model.pushHourHist(ring, tick(33), t0 + 62000)  // partial slot, acc 33
  const alerts = [{ at: t0, key: "cpu", text: "CPU usage at 99% (threshold 90%)", ctx: { cpu: 99, mem: 40, cpuTemp: 80, gpu: null, gpuTemp: null, procs: [{ pid: "1", n: "zen-bin", c: 61, m: 3.2 }] } }]
  const json = Model.serializeHistory(ring, day, alerts, t0 + 62000)
  // Restored three hour-slots after the last slot opened: the saved
  // partial closes as its own slot, the rest of the gap renders empty.
  const back = Model.restoreHistory(json, t0 + 61000 + 3 * Model.HOUR_SLOT_SEC * 1000 + 1000)
  assert.deepStrictEqual(back.hour.cpu.values, [70, 33, 0, 0, 0], "closed slot + saved partial + gap slots")
  assert.ok(Number.isNaN(back.hour.cpu.acc), "resumed ring starts a fresh slot")
  assert.strictEqual(back.alerts.length, 1)
  assert.strictEqual(back.alerts[0].ctx.procs[0].n, "zen-bin", "alert context round-trips")
  assert.deepStrictEqual(Model.restoreHistory("not json", 0).alerts, [], "garbage falls back to empty")
  // Power and temperature ride the same rings; files from before those
  // keys existed load with the new series simply empty.
  assert.ok(Model.HOUR_KEYS.includes("cpuPower") && Model.HOUR_KEYS.includes("gpuPower") && Model.HOUR_KEYS.includes("cpuTemp"))
  let pring = Model.emptyHourHist()
  pring = Model.pushHourHist(pring, { cpu: 1, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0, cpuPower: 45, gpuPower: 220, cpuTemp: 71 }, t0)
  pring = Model.pushHourHist(pring, { cpu: 1, mem: 0, gpu: 0, netDown: 0, netUp: 0, ioRead: 0, ioWrite: 0, cpuPower: 30, gpuPower: 40, cpuTemp: 60 }, t0 + 61000)
  assert.deepStrictEqual(pring.gpuPower.values, [220], "gpu watts keep their slot peak")
  assert.deepStrictEqual(pring.cpuTemp.values, [71])
  const oldFile = JSON.stringify({ v: 1, savedAt: t0, hour: { since: t0, cpu: { values: [5], acc: null } }, day: { since: t0 }, alerts: [] })
  const oldBack = Model.restoreHistory(oldFile, t0 + 61000)
  assert.deepStrictEqual(oldBack.hour.cpu.values, [5, 0], "pre-power file loads")
  assert.ok(Model.hourValues(oldBack.hour, "cpuPower").every(v => v === 0), "new series starts with only empty slots")
  assert.deepStrictEqual(Model.restoreHistory(JSON.stringify({ v: 99 }), 0).day.cpu.values, [], "future version ignored")
  // A gap longer than the whole ring flushes it to empty slots.
  const flushed = Model.restoreHistory(json, t0 + 10 * 86400000)
  assert.ok(flushed.hour.cpu.values.length > 0 && flushed.hour.cpu.values.every(v => v === 0), "week-long gap empties the hour ring")
}

// Alert context snapshots: dedup by pid, short names, rounded values.
const ctx = Model.alertContext(
  { cpuPct: 97.4, memPct: 45.2, cpuTemp: 82.6, gpu: { busy: 3, celsius: 46 } },
  Model.parsePs([" 10 u 61.0  3.2  9 /usr/lib/chromium/chromium --type=x", " 11 u 20.0  1.0  2 make"]),
  Model.parsePs([" 12 u  1.0 12.5  3 /usr/lib/zen/zen-bin", " 10 u 61.0  3.2  9 /usr/lib/chromium/chromium --type=x"]))
assert.strictEqual(ctx.cpu, 97)
assert.strictEqual(ctx.cpuTemp, 83)
assert.strictEqual(ctx.procs.length, 3, "pid 10 deduped across the two lists")
assert.strictEqual(ctx.procs[0].n, "chromium")
assert.strictEqual(Model.fmtAlertContext(ctx), "CPU 97% · RAM 45% · 83° · GPU 3% 46°")
assert.strictEqual(Model.fmtAlertContext({ cpu: 50, mem: 20, cpuTemp: null, gpu: null }), "CPU 50% · RAM 20%")
assert.strictEqual(Model.fmtAlertContext(null), "")
assert.strictEqual(Model.fmtAlertProc({ n: "zen-bin", c: 61, m: 10 }, 32 * 1073741824), "zen-bin · 61% · 3.2 GB")

// RAPL: readable domains parse, restricted kernels are flagged, watts
// come from µJ deltas and survive counter wrap.
const rapl = Model.parseRapl(["rapl|package-0|1000000|262143328850", "rapl|core|500000|262143328850"])
assert.strictEqual(rapl.domains.length, 2)
assert.strictEqual(rapl.restricted, false)
const locked = Model.parseRapl(["rapl-restricted|package-0", "rapl-restricted|core"])
assert.strictEqual(locked.domains.length, 0)
assert.strictEqual(locked.restricted, true)
const raplNow = [{ name: "package-0", energyUj: 1000000 + 45e6, maxUj: 262143328850 }]
const watts = Model.raplRates(rapl.domains, raplNow, 2)
assert.ok(Math.abs(watts[0].watts - 22.5) < 0.01, "45 J over 2 s = 22.5 W")
const wrapped = Model.raplRates(
  [{ name: "package-0", energyUj: 262143328850 - 1e6, maxUj: 262143328850 }],
  [{ name: "package-0", energyUj: 1e6, maxUj: 262143328850 }], 1)
assert.ok(Math.abs(wrapped[0].watts - 2) < 0.01, "wrap-around delta")
assert.ok(Number.isNaN(Model.raplRates(null, raplNow, 2)[0].watts), "no prev, no rate")
assert.strictEqual(Model.raplLabel("package-0"), "CPU package")
assert.strictEqual(Model.raplLabel("dram"), "Memory (DRAM)")
assert.strictEqual(Model.fmtWh(3.14), "3.1 Wh")
assert.strictEqual(Model.fmtWh(0), "")

// Temperature unit is display-only: storage and thresholds stay °C, and
// Fahrenheit says so with an explicit °F suffix.
Model.setTempUnit("F")
assert.strictEqual(Model.fmtTemp(100), "212°F")
assert.strictEqual(Model.displayTemp(85), 185)
assert.strictEqual(Model.tempSuffix(), "°F")
assert.strictEqual(Model.alertLimitText(Model.alertSettingByKey("cputemp"), Model.thresholdsFrom({})), "≥ 185°F")
assert.strictEqual(Model.alertLimitText(Model.alertSettingByKey("cpu"), Model.thresholdsFrom({})), "≥ 90%", "percent limits untouched")
Model.setTempUnit("bogus")
assert.strictEqual(Model.fmtTemp(50), "50°", "unknown unit falls back to Celsius")
assert.strictEqual(Model.tempSuffix(), "°")
if (!CI) {
  const livePower = Model.parseSample(execSync("bash " + script + " dynamic").toString()).power
  assert.ok(livePower.domains.length > 0 || livePower.restricted, "live RAPL present or honestly restricted")
}

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
  // A bare vendor tag is never a GPU name — a fixture landing here means
  // prettyGpuName missed that machine's lspci shape.
  assert.ok(fx.gpus.every(g => !/^(AMD\/ATI|NVIDIA|Intel)$/i.test(g.name)), tag + "gpu names resolve past the vendor tag")
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
