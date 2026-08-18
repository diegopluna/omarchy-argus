// Run with: node tests/model.test.js < sample-output
// Or with no stdin, uses a built-in fixture.
const { execSync } = require("child_process")
const path = require("path")
const Model = require(path.join(__dirname, "..", "Model.js"))

const assert = require("assert")

const text = execSync("bash " + path.join(__dirname, "..", "sample.sh")).toString()
const sample = Model.parseSample(text)

assert.ok(sample.host.length > 0, "host parsed")
assert.ok(sample.cpus.length > 1, "aggregate + per-core cpu lines")
assert.strictEqual(sample.cpus[0].id, "cpu")
assert.ok(sample.mem.total > 0, "MemTotal parsed")
assert.ok(sample.load.uptimeSec > 0, "uptime parsed")
assert.ok(sample.disks.length > 0, "disks parsed")
assert.ok(sample.disks.every(d => d.size > 0))
assert.ok(sample.temps.length > 0, "temps parsed")

// Second sample for deltas.
const text2 = execSync("bash " + path.join(__dirname, "..", "sample.sh")).toString()
const sample2 = Model.parseSample(text2)
const usage = Model.cpuUsage(sample.cpus, sample2.cpus)
assert.strictEqual(usage.length, sample2.cpus.length)
assert.ok(usage.every(u => u.pct >= 0 && u.pct <= 100), "cpu pct in range")

const rates = Model.netRates(sample.net, sample2.net, 1)
assert.ok(rates.down >= 0 && rates.up >= 0)

const gpu = Model.primaryGpu(sample.gpus)
if (sample.gpus.length > 0) assert.ok(gpu.vramTotal >= 0)

const barData = {
  cpuPct: 12.4,
  cpuTemp: Model.cpuTemp(sample.temps),
  memPct: 61.2,
  gpu: gpu,
  disk: Model.diskFor(sample.disks, "/"),
  netDown: 1234567,
  netUp: 4321,
  load1: 1.86
}

assert.strictEqual(Model.fmtPct(12.4), "12%")
assert.strictEqual(Model.fmtBytes(1536), "1.5 KB")
assert.strictEqual(Model.fmtUptime(90061), "1d 1h")
assert.strictEqual(Model.fmtRateShort(1234567), "1.2M")

const barText = Model.barText(["cpu", "ram", "cputemp", "net", "load"], barData)
assert.ok(barText.includes("12%"), "bar shows cpu")
assert.ok(barText.includes("61%"), "bar shows ram")
assert.ok(barText.includes("1.86"), "bar shows load")

// NVIDIA parsing (fixture-based: nvidia-smi csv,noheader,nounits output).
const nv = Model.parseNvidia([
  "0, NVIDIA GeForce RTX 3080, 5, 45, 1024, 10240",
  "1, NVIDIA RTX A6000, [N/A], 38, 512, 49140"
])
assert.strictEqual(nv.length, 2)
assert.strictEqual(nv[0].card, "nv0")
assert.strictEqual(nv[0].name, "NVIDIA GeForce RTX 3080")
assert.strictEqual(nv[0].busy, 5)
assert.strictEqual(nv[0].celsius, 45)
assert.strictEqual(nv[0].vramUsed, 1024 * 1048576)
assert.strictEqual(nv[0].vramTotal, 10240 * 1048576)
assert.ok(Number.isNaN(nv[1].busy), "[N/A] utilization -> NaN")
assert.strictEqual(nv[1].celsius, 38)
// Bar hides the gpu segment when utilization is unsupported.
assert.strictEqual(Model.metricValue("gpu", { gpu: nv[1] }), "")
assert.strictEqual(Model.metricValue("gpu", { gpu: nv[0] }), "5%")
assert.strictEqual(Model.metricValue("gputemp", { gpu: nv[0] }), "45°")
assert.strictEqual(Model.metricValue("vram", { gpu: nv[0] }), "10%")
// nvidia-smi dGPU outranks an amdgpu iGPU by VRAM size.
const hybrid = Model.primaryGpu([{ card: "0", vramTotal: 512 * 1048576 }, nv[0]])
assert.strictEqual(hybrid.card, "nv0")
// Sample section merges even when the NVIDIA section is empty (this machine).
const nvSample = Model.parseSample("###GPU\n0|25|100|200|48000|Vendor [X] Foo [Radeon RX]\n###NVIDIA\n0, NVIDIA GeForce RTX 4070, 12, 51, 2048, 12282")
assert.strictEqual(nvSample.gpus.length, 2)
assert.strictEqual(nvSample.gpus[0].label, "GPU 0")
assert.strictEqual(nvSample.gpus[1].label, "GPU 0 (NVIDIA)")

const toggled = Model.toggleShow(["cpu", "ram"], "disk")
assert.deepStrictEqual(toggled, ["cpu", "ram", "disk"])
assert.deepStrictEqual(Model.toggleShow(toggled, "ram"), ["cpu", "disk"])
assert.deepStrictEqual(Model.normalizeShow(["disk", "cpu", "bogus"]), ["cpu", "disk"])

console.log("bar text:", barText)
console.log("cpu temp:", Model.fmtTemp(barData.cpuTemp), "gpus:", sample.gpus.length, "disks:", sample.disks.map(d => d.mount).join(" "))
console.log("all tests passed")
