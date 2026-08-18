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

const toggled = Model.toggleShow(["cpu", "ram"], "disk")
assert.deepStrictEqual(toggled, ["cpu", "ram", "disk"])
assert.deepStrictEqual(Model.toggleShow(toggled, "ram"), ["cpu", "disk"])
assert.deepStrictEqual(Model.normalizeShow(["disk", "cpu", "bogus"]), ["cpu", "disk"])

console.log("bar text:", barText)
console.log("cpu temp:", Model.fmtTemp(barData.cpuTemp), "gpus:", sample.gpus.length, "disks:", sample.disks.map(d => d.mount).join(" "))
console.log("all tests passed")
