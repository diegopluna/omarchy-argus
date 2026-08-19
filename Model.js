// Parsing and formatting for the Argus widget. Pure functions only, so the
// whole file is testable with `node tests/model.test.js`.

// Metrics the bar can show. `key` is what shell.json's `show` array stores;
// the user's stored order is the display order.
var METRICS = [
  { key: "cpu",     label: "CPU usage",       icon: "\u{f0ee0}" }, // 󰻠
  { key: "cputemp", label: "CPU temperature", icon: "\u{f050f}" }, // 󰔏
  { key: "ram",     label: "RAM usage",       icon: "\u{f035b}" }, // 󰍛
  { key: "gpu",     label: "GPU usage",       icon: "\u{f08ae}" }, // 󰢮
  { key: "gputemp", label: "GPU temperature", icon: "\u{f08ae}" },
  { key: "vram",    label: "VRAM usage",      icon: "\u{f061a}" }, // 󰘚
  { key: "disk",    label: "Disk usage",      icon: "\u{f02ca}" }, // 󰋊
  { key: "io",      label: "Disk I/O",        icon: "\u{f02ca}" },
  { key: "net",     label: "Network traffic", icon: "" },
  { key: "load",    label: "Load average",    icon: "\u{f04c5}" }, // 󰓅
  { key: "bat",     label: "Battery",         icon: "" }           // icon tracks charge
]

var DEFAULT_SHOW = ["cpu", "ram", "cputemp"]

// Bar segments turn urgent-colored at these values; each is overridable via
// the widget's inline settings (urgentCpuPct, urgentMemPct, urgentTempC,
// urgentDiskPct).
var DEFAULT_THRESHOLDS = { cpuPct: 90, memPct: 90, tempC: 85, diskPct: 90 }

var ICON_DOWN = "\u{f0045}" // 󰁅
var ICON_UP = "\u{f005d}"   // 󰁝

function metricByKey(key) {
  for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i]
  return null
}

// Normalize a stored `show` value into a deduplicated list of known keys,
// preserving the stored order — it is the bar's display order.
function normalizeShow(value) {
  var list = value instanceof Array ? value : DEFAULT_SHOW
  var result = []
  for (var i = 0; i < list.length; i++) {
    if (metricByKey(list[i]) !== null && result.indexOf(list[i]) === -1) result.push(list[i])
  }
  return result
}

function toggleShow(current, key) {
  var list = normalizeShow(current)
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else if (metricByKey(key) !== null) list.push(key)
  return list
}

// Move `key` by `delta` positions within the shown list (-1 up, +1 down).
function moveShow(current, key, delta) {
  var list = normalizeShow(current)
  var from = list.indexOf(key)
  var to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return list
  list.splice(from, 1)
  list.splice(to, 0, key)
  return list
}

function thresholdsFrom(settings) {
  function num(value, fallback) {
    var n = Number(value)
    return isFinite(n) && n > 0 ? n : fallback
  }
  settings = settings || {}
  return {
    cpuPct: num(settings.urgentCpuPct, DEFAULT_THRESHOLDS.cpuPct),
    memPct: num(settings.urgentMemPct, DEFAULT_THRESHOLDS.memPct),
    tempC: num(settings.urgentTempC, DEFAULT_THRESHOLDS.tempC),
    diskPct: num(settings.urgentDiskPct, DEFAULT_THRESHOLDS.diskPct)
  }
}

// ---- Sample parsing ------------------------------------------------------

function parseSample(text) {
  var sections = {}
  var current = null
  var lines = String(text || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line.indexOf("###") === 0) {
      current = line.slice(3).trim()
      sections[current] = []
    } else if (current !== null && line.trim() !== "") {
      sections[current].push(line)
    }
  }
  var diskModels = parseDiskNames(sections.DISKNAMES || [])
  var diskLinks = parseDiskLinks(sections.DISKLINKS || [])
  var gpuNames = parseGpuNames(sections.GPUNAMES || [])
  var nvidiaLines = sections.NVIDIA || []
  var nvidiaSuspended = nvidiaLines.length > 0 && nvidiaLines[0].trim() === "suspended"
  return {
    host: (sections.HOST || [""])[0].trim(),
    cpuName: (sections.CPUNAME || [""])[0].trim(),
    cpus: parseStat(sections.STAT || []),
    mem: parseMem(sections.MEM || []),
    load: parseLoad(sections.LOAD || []),
    net: parseNet(sections.NET || []),
    disks: attachDiskModels(parseDf(sections.DF || []), diskModels, diskLinks),
    diskModels: diskModels,
    diskLinks: diskLinks,
    io: parseDiskstats(sections.DISKSTATS || []),
    temps: parseTemps(sections.TEMP || []),
    fans: parseFans(sections.FAN || []),
    gpus: parseGpus(sections.GPU || [], gpuNames).concat(nvidiaSuspended ? [] : parseNvidia(nvidiaLines)),
    nvidiaSuspended: nvidiaSuspended,
    psCpu: parsePs(sections.PSCPU || []),
    psMem: parsePs(sections.PSMEM || []),
    batteries: parseBattery(sections.BAT || [])
  }
}

// lsblk -dno NAME,MODEL lines → { nvme0n1: "KINGSTON ...", ... }
function parseDiskNames(lines) {
  var models = {}
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].trim().match(/^(\S+)\s+(.+)$/)
    if (match) models[match[1]] = match[2].trim()
  }
  return models
}

// lsblk -rno NAME,PKNAME lines → { child: parent } (partition → disk,
// dm device → partition).
function parseDiskLinks(lines) {
  var links = {}
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length === 2) links[parts[0]] = parts[1]
  }
  return links
}

// GPUNAMES lines: "card|lspci name" → { "0": "…[Radeon RX 9070/…]…" }
function parseGpuNames(lines) {
  var names = {}
  for (var i = 0; i < lines.length; i++) {
    var idx = lines[i].indexOf("|")
    if (idx > 0) names[lines[i].slice(0, idx)] = lines[i].slice(idx + 1).trim()
  }
  return names
}

// Match a df source like /dev/nvme0n1p2 or /dev/mapper/root to its physical
// disk model: walk the lsblk parent chain until we land on a device with a
// model, falling back to a name-prefix match.
function attachDiskModels(disks, models, links) {
  links = links || {}
  for (var i = 0; i < disks.length; i++) {
    var raw = disks[i].source.replace(/^\/dev\//, "")
    var dev = raw.split("/").pop()
    var hops = 0
    while (!(dev in models) && links[dev] && hops < 8) {
      dev = links[dev]
      hops++
    }
    if (!(dev in models)) {
      var best = ""
      for (var name in models) {
        if (dev.indexOf(name) === 0 && name.length > best.length) best = name
      }
      if (best !== "") dev = best
    }
    disks[i].model = dev in models ? models[dev] : ""
    disks[i].device = dev
  }
  return disks
}

function parseStat(lines) {
  var cpus = []
  for (var i = 0; i < lines.length; i++) {
    var fields = lines[i].trim().split(/\s+/)
    if (fields[0].indexOf("cpu") !== 0) continue
    var total = 0
    for (var j = 1; j < Math.min(fields.length, 9); j++) total += Number(fields[j]) || 0
    var idle = (Number(fields[4]) || 0) + (Number(fields[5]) || 0)
    cpus.push({ id: fields[0], total: total, idle: idle })
  }
  return cpus
}

function parseMem(lines) {
  var values = {}
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^(\w+):\s+(\d+)/)
    if (match) values[match[1]] = Number(match[2]) * 1024
  }
  return {
    total: values.MemTotal || 0,
    avail: values.MemAvailable || 0,
    swapTotal: values.SwapTotal || 0,
    swapFree: values.SwapFree || 0
  }
}

function parseLoad(lines) {
  var load = (lines[0] || "").trim().split(/\s+/)
  var uptime = Number((lines[1] || "0").trim().split(/\s+/)[0]) || 0
  return {
    load1: Number(load[0]) || 0,
    load5: Number(load[1]) || 0,
    load15: Number(load[2]) || 0,
    uptimeSec: uptime,
    cpuMhz: Number((lines[2] || "0").trim()) || 0
  }
}

function parseNet(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 10) continue
    var iface = parts[0].replace(/:$/, "")
    if (iface === "lo") continue
    result.push({ iface: iface, rx: Number(parts[1]) || 0, tx: Number(parts[9]) || 0 })
  }
  return result
}

// One row per underlying device, keyed by source; the shortest mount point
// wins so btrfs subvolume mounts collapse into "/".
function parseDf(lines) {
  var bySource = {}
  var order = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 4) continue
    var entry = {
      source: parts[0],
      size: Number(parts[1]) || 0,
      used: Number(parts[2]) || 0,
      mount: parts.slice(3).join(" ")
    }
    if (entry.size <= 0) continue
    var existing = bySource[entry.source]
    if (!existing) {
      bySource[entry.source] = entry
      order.push(entry.source)
    } else if (entry.mount.length < existing.mount.length) {
      bySource[entry.source] = entry
    }
  }
  var result = []
  for (var k = 0; k < order.length; k++) result.push(bySource[order[k]])
  return result
}

// /proc/diskstats: major minor name reads merged sectors_read ms_reading
// writes merged sectors_written … — sectors are always 512 bytes here.
function parseDiskstats(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].trim().split(/\s+/)
    if (f.length < 10) continue
    result.push({
      dev: f[2],
      readBytes: (Number(f[5]) || 0) * 512,
      writeBytes: (Number(f[9]) || 0) * 512
    })
  }
  return result
}

// A diskstats device is a whole physical disk when lsblk knows its model,
// or when it appears in the parent chain only as a parent (dm/zram noise
// appears as neither).
function isWholeDisk(dev, models, links) {
  if (dev in models) return true
  if (dev in links) return false
  for (var child in links) if (links[child] === dev) return true
  return false
}

function parseTemps(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 3) continue
    var value = Number(parts[2])
    if (!isFinite(value) || value === 0) continue
    var celsius = value / 1000
    // Super I/O chips report garbage on unconnected inputs (large
    // negatives, 255°); drop the physically implausible.
    if (celsius < -40 || celsius > 250) continue
    result.push({ chip: parts[0], label: parts[1], celsius: celsius, device: (parts[3] || "").trim() })
  }
  return result
}

// FAN lines share the TEMP shape: chip|label|rpm|device. Zero RPM is kept —
// a stopped fan is information.
function parseFans(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 3) continue
    var rpm = Number(parts[2])
    if (!isFinite(rpm) || rpm < 0) continue
    result.push({ chip: parts[0], label: parts[1], rpm: rpm, device: (parts[3] || "").trim() })
  }
  return result
}

// ps axo pid=,pcpu=,pmem=,comm= lines; comm is last so its spaces survive.
function parsePs(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/)
    if (!match) continue
    result.push({ pid: match[1], cpu: Number(match[2]), mem: Number(match[3]), comm: match[4] })
  }
  return result
}

// BAT lines: name|status|capacity|energy_now|energy_full|energy_design|
// power_now|model — energies in µWh, power in µW (sample.sh converts
// charge_*-only batteries).
function parseBattery(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var p = lines[i].split("|")
    if (p.length < 8) continue
    var cap = Number(p[2])
    result.push({
      name: p[0].trim(),
      status: p[1].trim(),
      capacity: p[2].trim() !== "" && isFinite(cap) ? cap : NaN,
      energyNowWh: (Number(p[3]) || 0) / 1e6,
      energyFullWh: (Number(p[4]) || 0) / 1e6,
      energyDesignWh: (Number(p[5]) || 0) / 1e6,
      powerW: (Number(p[6]) || 0) / 1e6,
      model: p.slice(7).join("|").trim()
    })
  }
  return result
}

// Friendly chip names for the temperatures and fans lists.
var CHIP_NAMES = [
  [/^k10temp$|^zenpower$|^coretemp$/, "CPU"],
  [/^amdgpu$|^nouveau$|^radeon$/, "GPU"],
  [/^nvme$/, "NVMe"],
  [/^spd5118$|^jc42$/, "RAM"],
  [/^mt79|^iwlwifi|^ath\d|_phy\d+$/, "Wi-Fi"],
  [/^r8169|^e1000|^igc|^enp|^eno/, "Ethernet"],
  [/^asus$|^nct\d+|^it\d+/, "Motherboard"],
  [/^acpitz$/, "ACPI"],
  [/battery/, "Battery"]
]

// "NVMe · KINGSTON SNV3S1000G · Composite" style display name; fans share
// the shape so they reuse this.
function tempName(temp) {
  var friendly = temp.chip
  for (var i = 0; i < CHIP_NAMES.length; i++) {
    if (CHIP_NAMES[i][0].test(temp.chip)) { friendly = CHIP_NAMES[i][1]; break }
  }
  var parts = [friendly]
  if (temp.device && temp.device !== "") parts.push(temp.device)
  else if (friendly !== temp.chip) parts.push(temp.chip)
  if (temp.label && temp.label !== "") parts.push(temp.label)
  return parts.join(" · ")
}

// "Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070/...] (rev c0)"
// → "Radeon RX 9070/9070 XT/9070 GRE"
function prettyGpuName(raw) {
  var name = String(raw || "").replace(/\s*\(rev [^)]*\)\s*$/, "").trim()
  if (name === "") return ""
  var brackets = name.match(/\[([^\]]+)\]/g)
  if (brackets && brackets.length > 0) {
    var last = brackets[brackets.length - 1].slice(1, -1)
    if (!/AMD\/ATI|NVIDIA|Intel/i.test(last) || brackets.length === 1) return last
  }
  return name.replace(/^[^\[]*\[[^\]]*\]\s*/, "") || name
}

// GPU lines (amdgpu sysfs): card|busy|vram_used|vram_total|temp|power (µW);
// the lspci name arrives separately in the static GPUNAMES section.
function parseGpus(lines, names) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 5) continue
    result.push({
      card: parts[0],
      label: "GPU " + parts[0],
      busy: Number(parts[1]) || 0,
      vramUsed: Number(parts[2]) || 0,
      vramTotal: Number(parts[3]) || 0,
      celsius: parts[4] !== "" ? Number(parts[4]) / 1000 : NaN,
      powerW: parts.length > 5 && parts[5] !== "" ? Number(parts[5]) / 1e6 : NaN,
      name: prettyGpuName(names && parts[0] in names ? names[parts[0]] : "")
    })
  }
  return result
}

// nvidia-smi --format=csv,noheader,nounits lines:
//   "0, NVIDIA GeForce RTX 3080, 5, 45, 1024, 10240, 98.5"
// (index, name, util %, temp °C, memory used MiB, memory total MiB,
// power draw W). Fields can read "[N/A]" or "[Not Supported]"; a comma
// inside the name is handled by taking the trailing five numeric fields
// from the end.
function parseNvidia(lines) {
  function num(s) {
    var v = Number(String(s).trim())
    return isFinite(v) ? v : NaN
  }
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split(",")
    var n = f.length
    if (n < 7) continue
    var index = String(f[0]).trim()
    result.push({
      card: "nv" + index,
      label: "GPU " + index + " (NVIDIA)",
      busy: num(f[n - 5]),
      celsius: num(f[n - 4]),
      vramUsed: (num(f[n - 3]) || 0) * 1048576,
      vramTotal: (num(f[n - 2]) || 0) * 1048576,
      powerW: num(f[n - 1]),
      name: f.slice(1, n - 5).join(",").trim()
    })
  }
  return result
}

// A runtime-suspended NVIDIA card, remembered from its last awake sample:
// identity kept (name, VRAM size, so it stays the primary GPU), live
// readings cleared so nothing stale renders.
function markGpuAsleep(gpu) {
  return {
    card: gpu.card,
    label: gpu.label,
    name: gpu.name,
    busy: NaN,
    celsius: NaN,
    powerW: NaN,
    vramUsed: 0,
    vramTotal: gpu.vramTotal || 0,
    asleep: true
  }
}

// ---- Derived values ------------------------------------------------------

// Usage per /proc/stat entry between two samples; prev may be null on the
// first tick.
function cpuUsage(prevCpus, cpus) {
  var byId = {}
  if (prevCpus) for (var i = 0; i < prevCpus.length; i++) byId[prevCpus[i].id] = prevCpus[i]
  var result = []
  for (var j = 0; j < cpus.length; j++) {
    var cur = cpus[j]
    var prev = byId[cur.id]
    var pct = 0
    if (prev && cur.total > prev.total) {
      pct = 100 * (1 - (cur.idle - prev.idle) / (cur.total - prev.total))
    }
    result.push({ id: cur.id, pct: Math.max(0, Math.min(100, pct)) })
  }
  return result
}

// Total rx/tx bytes-per-second across interfaces between two samples.
function netRates(prevNet, net, elapsedSec) {
  var byIface = {}
  if (prevNet) for (var i = 0; i < prevNet.length; i++) byIface[prevNet[i].iface] = prevNet[i]
  var down = 0, up = 0
  var perIface = []
  for (var j = 0; j < net.length; j++) {
    var cur = net[j]
    var prev = byIface[cur.iface]
    var rx = 0, tx = 0
    if (prev && elapsedSec > 0) {
      rx = Math.max(0, (cur.rx - prev.rx) / elapsedSec)
      tx = Math.max(0, (cur.tx - prev.tx) / elapsedSec)
    }
    down += rx
    up += tx
    perIface.push({ iface: cur.iface, down: rx, up: tx, total: cur.rx + cur.tx })
  }
  return { down: down, up: up, perIface: perIface }
}

// Read/write bytes-per-second per whole physical disk between two samples.
// `prevIo`/`io` are raw parseDiskstats lists; models/links (from lsblk)
// pick the whole-disk rows out of the partition noise.
function ioRates(prevIo, io, elapsedSec, models, links) {
  var byDev = {}
  if (prevIo) for (var i = 0; i < prevIo.length; i++) byDev[prevIo[i].dev] = prevIo[i]
  var read = 0, write = 0
  var perDisk = []
  for (var j = 0; j < io.length; j++) {
    var cur = io[j]
    if (!isWholeDisk(cur.dev, models || {}, links || {})) continue
    var prev = byDev[cur.dev]
    var r = 0, w = 0
    if (prev && elapsedSec > 0) {
      r = Math.max(0, (cur.readBytes - prev.readBytes) / elapsedSec)
      w = Math.max(0, (cur.writeBytes - prev.writeBytes) / elapsedSec)
    }
    read += r
    write += w
    perDisk.push({ dev: cur.dev, model: models && cur.dev in models ? models[cur.dev] : "", read: r, write: w })
  }
  return { read: read, write: write, perDisk: perDisk }
}

// The CPU package temperature: k10temp Tctl (AMD), coretemp package
// (Intel), or the first CPU-ish chip we can find.
function cpuTemp(temps) {
  var fallback = NaN
  for (var i = 0; i < temps.length; i++) {
    var t = temps[i]
    if (t.chip === "k10temp" && t.label === "Tctl") return t.celsius
    if (t.chip === "zenpower" && t.label === "Tdie") return t.celsius
    if (t.chip === "coretemp" && /Package/.test(t.label)) return t.celsius
    if (!isFinite(fallback) && (t.chip === "k10temp" || t.chip === "zenpower" || t.chip === "coretemp")) {
      fallback = t.celsius
    }
  }
  return fallback
}

// The discrete GPU when there is one: the card with the most VRAM.
function primaryGpu(gpus) {
  var best = null
  for (var i = 0; i < gpus.length; i++) {
    if (!best || gpus[i].vramTotal > best.vramTotal) best = gpus[i]
  }
  return best
}

function diskFor(disks, mount) {
  for (var i = 0; i < disks.length; i++) if (disks[i].mount === mount) return disks[i]
  return disks.length > 0 ? disks[0] : null
}

// Combined view over every system battery (usually one; some laptops carry
// two). Null when the machine has none — a desktop.
function batterySummary(batteries) {
  if (!batteries || batteries.length === 0) return null
  var now = 0, full = 0, design = 0, watts = 0
  var capSum = 0, capCount = 0
  var charging = false, discharging = false
  for (var i = 0; i < batteries.length; i++) {
    var b = batteries[i]
    now += b.energyNowWh || 0
    full += b.energyFullWh || 0
    design += b.energyDesignWh || 0
    watts += b.powerW || 0
    if (isFinite(b.capacity)) { capSum += b.capacity; capCount++ }
    if (b.status === "Charging") charging = true
    if (b.status === "Discharging") discharging = true
  }
  var pct = full > 0 ? 100 * now / full : (capCount > 0 ? capSum / capCount : NaN)
  var timeSec = NaN
  if (watts > 0.5) {
    if (charging) timeSec = Math.max(0, full - now) / watts * 3600
    else if (discharging) timeSec = now / watts * 3600
  }
  return {
    count: batteries.length,
    pct: pct,
    status: charging ? "Charging" : (discharging ? "Discharging" : batteries[0].status),
    charging: charging,
    discharging: discharging,
    watts: watts,
    timeSec: timeSec,
    healthPct: design > 0 && full > 0 ? 100 * full / design : NaN
  }
}

// Fixed-length rolling history for the panel sparklines. Returns a new
// array so QML property reassignment triggers rebinds.
var HISTORY_LEN = 60

function pushHistory(list, value, max) {
  var result = (list || []).slice()
  result.push(isFinite(value) ? value : 0)
  var cap = max || HISTORY_LEN
  while (result.length > cap) result.shift()
  return result
}

// ---- Formatting ----------------------------------------------------------

function fmtBytes(bytes) {
  var units = ["B", "KB", "MB", "GB", "TB"]
  var value = Number(bytes) || 0
  var unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return (value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)) + " " + units[unit]
}

// Compact form for the bar: "1.2M", "56K", "0".
function fmtRateShort(bytesPerSec) {
  var value = Number(bytesPerSec) || 0
  if (value < 1024) return "0"
  var units = ["K", "M", "G"]
  var unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return (value >= 10 ? Math.round(value) : value.toFixed(1)) + units[unit]
}

function fmtUptime(seconds) {
  var s = Math.floor(Number(seconds) || 0)
  var days = Math.floor(s / 86400)
  var hours = Math.floor((s % 86400) / 3600)
  var minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return days + "d " + hours + "h"
  if (hours > 0) return hours + "h " + minutes + "m"
  return minutes + "m"
}

function fmtPct(pct) {
  return isFinite(pct) ? Math.round(pct) + "%" : "—"
}

function fmtTemp(celsius) {
  return isFinite(celsius) ? Math.round(celsius) + "°" : "—"
}

function fmtWatts(watts) {
  if (!isFinite(watts) || watts <= 0) return "—"
  return (watts >= 10 ? Math.round(watts) : watts.toFixed(1)) + " W"
}

// Battery glyph by charge level; the bolt variant while charging.
function batteryIcon(pct, charging) {
  if (charging) return "\u{f0084}" // 󰂄
  if (!isFinite(pct) || pct >= 95) return "\u{f0079}" // 󰁹
  var tier = Math.max(1, Math.min(9, Math.round(pct / 10)))
  return String.fromCodePoint(0xf007a + tier - 1) // 󰁺 (10%) … 󰂂 (90%)
}

// The short value a metric shows in the bar, or "" to hide the segment
// (e.g. GPU metrics on a machine without a supported GPU, battery on a
// desktop, an asleep NVIDIA card).
function metricValue(key, data) {
  switch (key) {
    case "cpu": return fmtPct(data.cpuPct)
    case "cputemp": return isFinite(data.cpuTemp) ? fmtTemp(data.cpuTemp) : ""
    case "ram": return fmtPct(data.memPct)
    case "gpu": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.busy) ? fmtPct(data.gpu.busy) : ""
    case "gputemp": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.celsius) ? fmtTemp(data.gpu.celsius) : ""
    case "vram": return data.gpu && !data.gpu.asleep && data.gpu.vramTotal > 0 ? fmtPct(100 * data.gpu.vramUsed / data.gpu.vramTotal) : ""
    case "disk": return data.disk ? fmtPct(100 * data.disk.used / data.disk.size) : ""
    case "io": return data.io ? "R" + fmtRateShort(data.io.read) + " W" + fmtRateShort(data.io.write) : ""
    case "net": return ICON_DOWN + fmtRateShort(data.netDown) + " " + ICON_UP + fmtRateShort(data.netUp)
    case "load": return data.load1.toFixed(2)
    case "bat": return data.battery && isFinite(data.battery.pct)
      ? batteryIcon(data.battery.pct, data.battery.charging) + " " + fmtPct(data.battery.pct)
      : ""
    default: return ""
  }
}

// Whether a metric's bar segment should render in the urgent color.
function metricUrgent(key, data, th) {
  th = th || DEFAULT_THRESHOLDS
  switch (key) {
    case "cpu": return data.cpuPct >= th.cpuPct
    case "cputemp": return isFinite(data.cpuTemp) && data.cpuTemp >= th.tempC
    case "ram": return data.memPct >= th.memPct
    case "gpu": return !!(data.gpu && !data.gpu.asleep && isFinite(data.gpu.busy) && data.gpu.busy >= th.cpuPct)
    case "gputemp": return !!(data.gpu && !data.gpu.asleep && isFinite(data.gpu.celsius) && data.gpu.celsius >= th.tempC)
    case "vram": return !!(data.gpu && !data.gpu.asleep && data.gpu.vramTotal > 0 && 100 * data.gpu.vramUsed / data.gpu.vramTotal >= th.memPct)
    case "disk": return !!(data.disk && data.disk.size > 0 && 100 * data.disk.used / data.disk.size >= th.diskPct)
    case "load": return (Number(data.cores) || 0) > 0 && data.load1 >= data.cores
    case "bat": return !!(data.battery && !data.battery.charging && isFinite(data.battery.pct) && data.battery.pct <= 15)
    default: return false
  }
}

// Metrics the alert watchdog evaluates every tick, regardless of which
// segments the bar shows. Load is deliberately absent — it flaps.
var ALERT_KEYS = ["cpu", "cputemp", "ram", "gpu", "gputemp", "vram", "disk", "bat"]

// One-line notification body for a metric that crossed its threshold, e.g.
// "CPU temperature at 92° (threshold 85°)".
function alertText(key, data, th) {
  th = th || DEFAULT_THRESHOLDS
  var metric = metricByKey(key)
  var label = metric ? metric.label : key
  var value
  var limit
  switch (key) {
    case "cpu": value = fmtPct(data.cpuPct); limit = th.cpuPct + "%"; break
    case "cputemp": value = fmtTemp(data.cpuTemp); limit = th.tempC + "°"; break
    case "ram": value = fmtPct(data.memPct); limit = th.memPct + "%"; break
    case "gpu": value = data.gpu ? fmtPct(data.gpu.busy) : "—"; limit = th.cpuPct + "%"; break
    case "gputemp": value = data.gpu ? fmtTemp(data.gpu.celsius) : "—"; limit = th.tempC + "°"; break
    case "vram": value = data.gpu && data.gpu.vramTotal > 0 ? fmtPct(100 * data.gpu.vramUsed / data.gpu.vramTotal) : "—"; limit = th.memPct + "%"; break
    case "disk": value = data.disk ? fmtPct(100 * data.disk.used / data.disk.size) : "—"; limit = th.diskPct + "%"; break
    case "bat": value = data.battery ? fmtPct(data.battery.pct) : "—"; limit = "15%"; break
    default: value = "—"; limit = ""
  }
  return label + " at " + value + (limit !== "" ? " (threshold " + limit + ")" : "")
}

// Shown when no metric renders a segment (all deselected, or none of the
// selected ones has data). Without it the widget would collapse to zero
// width and the panel — the only place to re-enable metrics — would become
// unreachable from the bar. The eye of Argus, naturally.
var PLACEHOLDER_ICON = "\u{f0208}" // 󰈈

// Renderable bar segments, in the user's order: { key, text, urgent }.
function barSegments(showKeys, data, th) {
  var segments = []
  for (var i = 0; i < showKeys.length; i++) {
    var metric = metricByKey(showKeys[i])
    if (!metric) continue
    var value = metricValue(metric.key, data)
    if (value === "") continue
    segments.push({
      key: metric.key,
      text: metric.icon === "" ? value : metric.icon + " " + value,
      urgent: metricUrgent(metric.key, data, th)
    })
  }
  return segments
}

// Horizontal bar label without urgency coloring: "󰻠 12%  󰍛 61%  󰔏 56°".
function barText(showKeys, data) {
  var segments = barSegments(showKeys, data, null)
  var parts = []
  for (var i = 0; i < segments.length; i++) parts.push(segments[i].text)
  return parts.length > 0 ? parts.join("  ") : PLACEHOLDER_ICON
}

// Vertical bar lines: { text, urgent } per line, icon line then value line
// per metric. Rate metrics (net, io) are too wide sideways and are skipped.
function barLines(showKeys, data, th) {
  var lines = []
  for (var i = 0; i < showKeys.length; i++) {
    var metric = metricByKey(showKeys[i])
    if (!metric || metric.key === "net" || metric.key === "io") continue
    var value = metricValue(metric.key, data)
    if (value === "") continue
    var urgent = metricUrgent(metric.key, data, th)
    if (metric.key === "bat") {
      lines.push({ text: batteryIcon(data.battery.pct, data.battery.charging), urgent: urgent })
      lines.push({ text: fmtPct(data.battery.pct), urgent: urgent })
      continue
    }
    if (metric.icon !== "") lines.push({ text: metric.icon, urgent: urgent })
    lines.push({ text: value, urgent: urgent })
  }
  return lines.length > 0 ? lines : [{ text: PLACEHOLDER_ICON, urgent: false }]
}

if (typeof module !== "undefined") {
  module.exports = {
    METRICS: METRICS,
    DEFAULT_SHOW: DEFAULT_SHOW,
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS,
    HISTORY_LEN: HISTORY_LEN,
    normalizeShow: normalizeShow,
    toggleShow: toggleShow,
    moveShow: moveShow,
    thresholdsFrom: thresholdsFrom,
    parseSample: parseSample,
    parseDiskstats: parseDiskstats,
    parseFans: parseFans,
    parsePs: parsePs,
    parseBattery: parseBattery,
    cpuUsage: cpuUsage,
    netRates: netRates,
    ioRates: ioRates,
    cpuTemp: cpuTemp,
    tempName: tempName,
    prettyGpuName: prettyGpuName,
    parseNvidia: parseNvidia,
    markGpuAsleep: markGpuAsleep,
    primaryGpu: primaryGpu,
    diskFor: diskFor,
    batterySummary: batterySummary,
    batteryIcon: batteryIcon,
    pushHistory: pushHistory,
    fmtBytes: fmtBytes,
    fmtRateShort: fmtRateShort,
    fmtUptime: fmtUptime,
    fmtPct: fmtPct,
    fmtTemp: fmtTemp,
    fmtWatts: fmtWatts,
    metricValue: metricValue,
    metricUrgent: metricUrgent,
    ALERT_KEYS: ALERT_KEYS,
    alertText: alertText,
    barSegments: barSegments,
    barText: barText,
    barLines: barLines,
    PLACEHOLDER_ICON: PLACEHOLDER_ICON
  }
}
