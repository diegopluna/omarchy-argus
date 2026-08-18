// Parsing and formatting for the Argus widget. Pure functions only, so the
// whole file is testable with `node tests/model.test.js`.

// Metrics the bar can show, in display order. `key` is what shell.json's
// `show` array stores.
var METRICS = [
  { key: "cpu",     label: "CPU usage",       icon: "\u{f0ee0}" }, // 󰻠
  { key: "cputemp", label: "CPU temperature", icon: "\u{f050f}" }, // 󰔏
  { key: "ram",     label: "RAM usage",       icon: "\u{f035b}" }, // 󰍛
  { key: "gpu",     label: "GPU usage",       icon: "\u{f08ae}" }, // 󰢮
  { key: "gputemp", label: "GPU temperature", icon: "\u{f08ae}" },
  { key: "vram",    label: "VRAM usage",      icon: "\u{f061a}" }, // 󰘚
  { key: "disk",    label: "Disk usage",      icon: "\u{f02ca}" }, // 󰋊
  { key: "net",     label: "Network traffic", icon: "" },
  { key: "load",    label: "Load average",    icon: "\u{f04c5}" }  // 󰓅
]

var DEFAULT_SHOW = ["cpu", "ram", "cputemp"]

var ICON_DOWN = "\u{f0045}" // 󰁅
var ICON_UP = "\u{f005d}"   // 󰁝

function metricByKey(key) {
  for (var i = 0; i < METRICS.length; i++) if (METRICS[i].key === key) return METRICS[i]
  return null
}

// Normalize a stored `show` value into an ordered list of known keys.
function normalizeShow(value) {
  var list = value instanceof Array ? value : DEFAULT_SHOW
  var result = []
  for (var i = 0; i < METRICS.length; i++) {
    if (list.indexOf(METRICS[i].key) !== -1) result.push(METRICS[i].key)
  }
  return result
}

function toggleShow(current, key) {
  var list = normalizeShow(current)
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else list.push(key)
  return normalizeShow(list)
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
  return {
    host: (sections.HOST || [""])[0].trim(),
    cpuName: (sections.CPUNAME || [""])[0].trim(),
    cpus: parseStat(sections.STAT || []),
    mem: parseMem(sections.MEM || []),
    load: parseLoad(sections.LOAD || []),
    net: parseNet(sections.NET || []),
    disks: attachDiskModels(parseDf(sections.DF || []), diskModels, diskLinks),
    temps: parseTemps(sections.TEMP || []),
    gpus: parseGpus(sections.GPU || []).concat(parseNvidia(sections.NVIDIA || []))
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

function parseTemps(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 3) continue
    var value = Number(parts[2])
    if (!isFinite(value) || value === 0) continue
    result.push({ chip: parts[0], label: parts[1], celsius: value / 1000, device: (parts[3] || "").trim() })
  }
  return result
}

// Friendly chip names for the temperatures list.
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

// "NVMe · KINGSTON SNV3S1000G · Composite" style display name.
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

function parseGpus(lines) {
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
      name: prettyGpuName(parts[5])
    })
  }
  return result
}

// nvidia-smi --format=csv,noheader,nounits lines:
//   "0, NVIDIA GeForce RTX 3080, 5, 45, 1024, 10240"
// (index, name, util %, temp °C, memory used MiB, memory total MiB).
// Fields can read "[N/A]" or "[Not Supported]"; a comma inside the name is
// handled by taking the trailing four numeric fields from the end.
function parseNvidia(lines) {
  function num(s) {
    var v = Number(String(s).trim())
    return isFinite(v) ? v : NaN
  }
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var f = lines[i].split(",")
    var n = f.length
    if (n < 6) continue
    var index = String(f[0]).trim()
    result.push({
      card: "nv" + index,
      label: "GPU " + index + " (NVIDIA)",
      busy: num(f[n - 4]),
      celsius: num(f[n - 3]),
      vramUsed: (num(f[n - 2]) || 0) * 1048576,
      vramTotal: (num(f[n - 1]) || 0) * 1048576,
      name: f.slice(1, n - 4).join(",").trim()
    })
  }
  return result
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

// The short value a metric shows in the bar, or "" to hide the segment
// (e.g. GPU metrics on a machine without a supported GPU).
function metricValue(key, data) {
  switch (key) {
    case "cpu": return fmtPct(data.cpuPct)
    case "cputemp": return isFinite(data.cpuTemp) ? fmtTemp(data.cpuTemp) : ""
    case "ram": return fmtPct(data.memPct)
    case "gpu": return data.gpu && isFinite(data.gpu.busy) ? fmtPct(data.gpu.busy) : ""
    case "gputemp": return data.gpu && isFinite(data.gpu.celsius) ? fmtTemp(data.gpu.celsius) : ""
    case "vram": return data.gpu && data.gpu.vramTotal > 0 ? fmtPct(100 * data.gpu.vramUsed / data.gpu.vramTotal) : ""
    case "disk": return data.disk ? fmtPct(100 * data.disk.used / data.disk.size) : ""
    case "net": return ICON_DOWN + fmtRateShort(data.netDown) + " " + ICON_UP + fmtRateShort(data.netUp)
    case "load": return data.load1.toFixed(2)
    default: return ""
  }
}

// Shown when no metric renders a segment (all deselected, or none of the
// selected ones has data). Without it the widget would collapse to zero
// width and the panel — the only place to re-enable metrics — would become
// unreachable from the bar.
var PLACEHOLDER_ICON = "\u{f04c5}" // 󰓅

// Horizontal bar label: "󰻠 12%  󰍛 61%  󰔏 56°".
function barText(showKeys, data) {
  var segments = []
  for (var i = 0; i < showKeys.length; i++) {
    var metric = metricByKey(showKeys[i])
    if (!metric) continue
    var value = metricValue(metric.key, data)
    if (value === "") continue
    segments.push(metric.icon === "" ? value : metric.icon + " " + value)
  }
  return segments.length > 0 ? segments.join("  ") : PLACEHOLDER_ICON
}

// Vertical bar lines: icon line then value line per metric.
function barLines(showKeys, data) {
  var lines = []
  for (var i = 0; i < showKeys.length; i++) {
    var metric = metricByKey(showKeys[i])
    if (!metric || metric.key === "net") continue
    var value = metricValue(metric.key, data)
    if (value === "") continue
    if (metric.icon !== "") lines.push(metric.icon)
    lines.push(value)
  }
  return lines.length > 0 ? lines : [PLACEHOLDER_ICON]
}

if (typeof module !== "undefined") {
  module.exports = {
    METRICS: METRICS,
    DEFAULT_SHOW: DEFAULT_SHOW,
    normalizeShow: normalizeShow,
    toggleShow: toggleShow,
    parseSample: parseSample,
    cpuUsage: cpuUsage,
    netRates: netRates,
    cpuTemp: cpuTemp,
    tempName: tempName,
    prettyGpuName: prettyGpuName,
    parseNvidia: parseNvidia,
    primaryGpu: primaryGpu,
    diskFor: diskFor,
    fmtBytes: fmtBytes,
    fmtRateShort: fmtRateShort,
    fmtUptime: fmtUptime,
    fmtPct: fmtPct,
    fmtTemp: fmtTemp,
    metricValue: metricValue,
    barText: barText,
    barLines: barLines,
    PLACEHOLDER_ICON: PLACEHOLDER_ICON
  }
}
