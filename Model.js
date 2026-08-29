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
  // net and bat compose their own bar glyphs (↓/↑ arrows, charge-level
  // battery), so `icon` stays empty; `listIcon` gives the BAR tab's
  // toggle list a static icon anyway.
  { key: "net",     label: "Network traffic", icon: "", listIcon: "\u{f06f3}" }, // 󰛳
  { key: "load",    label: "Load average",    icon: "\u{f04c5}" }, // 󰓅
  { key: "bat",     label: "Battery",         icon: "", listIcon: "\u{f0079}" } // 󰁹; bar icon tracks charge
]

var DEFAULT_SHOW = ["cpu", "ram", "cputemp"]

// Bar segments turn urgent-colored at these values; each is overridable via
// the widget's inline settings (urgent*), edited from the panel's BAR tab.
// Different silicon has different comfort zones: GPUs run hot by design,
// SSDs throttle early. batPct is a floor (urgent below), wearPct is the
// drive-health wear alarm.
var DEFAULT_THRESHOLDS = {
  cpuPct: 90, memPct: 90, gpuPct: 90, vramPct: 90,
  cpuTempC: 85, gpuTempC: 90, driveTempC: 70,
  diskPct: 90, batPct: 15, wearPct: 90
}

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
  // The pre-0.5.0 single urgentTempC still works as a fallback for the
  // per-component CPU/GPU thresholds, and the pre-0.9.0 shared CPU/RAM
  // values still cover GPU/VRAM until their own are set.
  var legacy = num(settings.urgentTempC, NaN)
  var cpuPct = num(settings.urgentCpuPct, DEFAULT_THRESHOLDS.cpuPct)
  var memPct = num(settings.urgentMemPct, DEFAULT_THRESHOLDS.memPct)
  return {
    cpuPct: cpuPct,
    memPct: memPct,
    gpuPct: num(settings.urgentGpuPct, cpuPct),
    vramPct: num(settings.urgentVramPct, memPct),
    cpuTempC: num(settings.urgentCpuTempC, isFinite(legacy) ? legacy : DEFAULT_THRESHOLDS.cpuTempC),
    gpuTempC: num(settings.urgentGpuTempC, isFinite(legacy) ? legacy : DEFAULT_THRESHOLDS.gpuTempC),
    driveTempC: num(settings.urgentDriveTempC, DEFAULT_THRESHOLDS.driveTempC),
    diskPct: num(settings.urgentDiskPct, DEFAULT_THRESHOLDS.diskPct),
    batPct: num(settings.urgentBatPct, DEFAULT_THRESHOLDS.batPct),
    wearPct: num(settings.urgentWearPct, DEFAULT_THRESHOLDS.wearPct)
  }
}

// ---- Sample parsing ------------------------------------------------------

// Parse one sampler emission. `staticCtx` — a previously parsed static
// sample — supplies the identity fields (host, models, GPU names,
// topology) so the per-tick dynamic text is parsed alone instead of
// re-parsing the concatenated static half every tick; without it,
// identity comes from the text itself (tests, fixtures, one-shots).
function parseSample(text, staticCtx) {
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
  var diskModels = staticCtx ? staticCtx.diskModels : parseDiskNames(sections.DISKNAMES || [])
  var diskLinks = staticCtx ? staticCtx.diskLinks : parseDiskLinks(sections.DISKLINKS || [])
  var gpuNames = staticCtx ? staticCtx.gpuNames : parseGpuNames(sections.GPUNAMES || [])
  var gpuPdev = staticCtx ? staticCtx.gpuPdev : parseGpuPdev(sections.GPUPDEV || [])
  var nvidiaLines = sections.NVIDIA || []
  var nvidiaSuspended = nvidiaLines.length > 0 && nvidiaLines[0].trim() === "suspended"
  // 0.10 samples one full PS table; pre-0.10 captures carry the two
  // top-10 sections instead — accept either.
  var psAll = parsePs(sections.PS || [])
  return {
    host: staticCtx ? staticCtx.host : (sections.HOST || [""])[0].trim(),
    cpuName: staticCtx ? staticCtx.cpuName : (sections.CPUNAME || [""])[0].trim(),
    kernel: staticCtx ? staticCtx.kernel : (sections.KERNEL || [""])[0].trim(),
    chassisType: staticCtx ? staticCtx.chassisType : Number((sections.CHASSIS || [""])[0]) || 0,
    cpus: parseStat(sections.STAT || []),
    mem: parseMem(sections.MEM || []),
    load: parseLoad(sections.LOAD || []),
    net: parseNet(sections.NET || []),
    netPhys: parseNetPhys(sections.NETPHYS || []),
    disks: attachDiskModels(parseDf(sections.DF || []), diskModels, diskLinks),
    diskModels: diskModels,
    diskLinks: diskLinks,
    io: parseDiskstats(sections.DISKSTATS || []),
    psi: parsePsi(sections.PSI || []),
    temps: parseTemps(sections.TEMP || []),
    fans: parseFans(sections.FAN || []),
    gpus: parseGpus(sections.GPU || [], gpuNames)
      .concat(parseIntelGpus(sections.GPUINTEL || [], gpuNames))
      .concat(nvidiaSuspended ? [] : parseNvidia(nvidiaLines)),
    nvidiaSuspended: nvidiaSuspended,
    psAll: psAll,
    psCpu: psAll.length > 0 ? topProcs(psAll, "cpu") : parsePs(sections.PSCPU || []),
    psMem: psAll.length > 0 ? topProcs(psAll, "mem") : parsePs(sections.PSMEM || []),
    swaps: parseSwaps(sections.SWAPS || []),
    power: parseRapl(sections.POWER || []),
    netInfo: parseNetInfo(sections.NETINFO || []),
    cpuTopo: staticCtx ? staticCtx.cpuTopo : parseCpuTopo(sections.CPUTOPO || []),
    cpuFreq: parseCpuFreq(sections.CPUFREQ || []),
    gpuPdev: gpuPdev,
    gpuProcs: parseGpuProc(sections.GPUPROC || []),
    driveHealth: parseDriveHealth(sections.DRIVEHEALTH || []),
    batteries: parseBattery(sections.BAT || [])
  }
}

// NETINFO lines (panel-only): iface|kind|ipv4|ssid — ssid last so a "|"
// in a network name can't shift the other fields.
function parseNetInfo(lines) {
  var map = {}
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 3) continue
    map[parts[0]] = {
      kind: parts[1],
      addr: (parts[2] || "").replace(/\/\d+$/, ""),
      ssid: parts.slice(3).join("|").trim()
    }
  }
  return map
}

var NET_KIND_ICONS = { wifi: "\u{f05a9}", eth: "\u{f0200}", virtual: "\u{f06f3}" } // 󰖩 󰈀 󰛳

// "Wi-Fi · MyNetwork · 192.168.0.5" — the identity half of a NET row.
function netIfaceDetail(info) {
  if (!info) return ""
  var parts = []
  if (info.kind === "wifi") parts.push(info.ssid !== "" ? info.ssid : "Wi-Fi")
  if (info.addr) parts.push(info.addr)
  return parts.join(" · ")
}

// ---- CPU topology --------------------------------------------------------
// CPUTOPO lines (static): cpu|core_id|l3_shared_list|max_khz. The grid
// groups SMT siblings into cores and cores into L3 domains (CCDs on
// multi-die AMD parts). Hybrid chips are detected by rated-ceiling
// spread: threads under 85% of the fastest are efficiency cores.

function parseCpuTopo(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 2) continue
    var cpu = Number(parts[0])
    if (!isFinite(cpu)) continue
    result.push({
      cpu: cpu,
      core: parts[1] !== "" ? Number(parts[1]) : cpu,
      l3: (parts[2] || "").trim(),
      maxKhz: parts.length > 3 ? Number(parts[3]) || 0 : 0
    })
  }
  result.sort(function(a, b) { return a.cpu - b.cpu })
  return result
}

// CPUFREQ lines: cpu|cur_khz → { cpu: khz }.
function parseCpuFreq(lines) {
  var map = {}
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 2) continue
    map[parts[0]] = Number(parts[1]) || 0
  }
  return map
}

// Groups for the CPU tab's core grid: [{ label, cores: [{ cpus, eff }] }].
// One L3 domain renders unlabeled; several get "CCD n" (AMD's name for
// them — the multi-L3 case in practice). Returns { groups, smt, hybrid }.
function cpuTopoGroups(topo) {
  if (!topo || topo.length === 0) return { groups: [], smt: false, hybrid: false }
  var peak = 0
  for (var m = 0; m < topo.length; m++) if (topo[m].maxKhz > peak) peak = topo[m].maxKhz
  var groups = []
  var byL3 = {}
  var smt = false
  for (var i = 0; i < topo.length; i++) {
    var t = topo[i]
    var l3Key = t.l3 !== "" ? t.l3 : "all"
    if (!(l3Key in byL3)) {
      byL3[l3Key] = { label: "", cores: [], _byCore: {} }
      groups.push(byL3[l3Key])
    }
    var g = byL3[l3Key]
    var coreKey = String(t.core)
    if (!(coreKey in g._byCore)) {
      g._byCore[coreKey] = { cpus: [], eff: peak > 0 && t.maxKhz > 0 && t.maxKhz < peak * 0.85 }
      g.cores.push(g._byCore[coreKey])
    }
    g._byCore[coreKey].cpus.push(t.cpu)
    if (g._byCore[coreKey].cpus.length > 1) smt = true
  }
  var hybrid = false
  for (var gi = 0; gi < groups.length; gi++) {
    delete groups[gi]._byCore
    if (groups.length > 1) groups[gi].label = "CCD " + gi
    for (var ci = 0; ci < groups[gi].cores.length; ci++) if (groups[gi].cores[ci].eff) hybrid = true
  }
  return { groups: groups, smt: smt, hybrid: hybrid }
}

// Average current clock of a group's threads, in GHz text ("4.52 GHz").
function groupFreqText(group, freqs) {
  if (!group || !freqs) return ""
  var sum = 0, n = 0
  for (var i = 0; i < group.cores.length; i++) {
    for (var j = 0; j < group.cores[i].cpus.length; j++) {
      var khz = freqs[String(group.cores[i].cpus[j])]
      if (isFinite(khz) && khz > 0) { sum += khz; n++ }
    }
  }
  if (n === 0) return ""
  return (sum / n / 1e6).toFixed(2) + " GHz"
}

// NETPHYS lines are interface names with a backing physical device; used
// to keep virtual interfaces (veth, docker0, tun/wg) out of the bar's
// throughput totals, where VPN traffic would be counted twice.
function parseNetPhys(lines) {
  var phys = {}
  for (var i = 0; i < lines.length; i++) {
    var name = lines[i].trim()
    if (name !== "") phys[name] = true
  }
  return phys
}

// PSI lines: "cpu some avg10=0.26 avg60=0.31 avg300=0.41 total=…" →
// { cpu: { some: 0.26, some60: 0.31, some300: 0.41, full: … }, … }.
// PSI is stall time from contention, not usage — 0 on a healthy machine.
function parsePsi(lines) {
  var psi = {}
  for (var i = 0; i < lines.length; i++) {
    var match = lines[i].match(/^(cpu|memory|io)\s+(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)/)
    if (!match) continue
    if (!psi[match[1]]) psi[match[1]] = { some: NaN, some60: NaN, some300: NaN, full: NaN, full60: NaN, full300: NaN }
    psi[match[1]][match[2]] = Number(match[3])
    psi[match[1]][match[2] + "60"] = Number(match[4])
    psi[match[1]][match[2] + "300"] = Number(match[5])
  }
  return psi
}

// "0.0 / 0.2 / 1.4 %" over the 10s/1m/5m windows, or "" when absent.
function fmtPsi(entry, kind) {
  if (!entry || !isFinite(entry[kind])) return ""
  function one(v) { return isFinite(v) ? v.toFixed(1) : "—" }
  return one(entry[kind]) + " / " + one(entry[kind + "60"]) + " / " + one(entry[kind + "300"]) + " %"
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
    free: values.MemFree || 0,
    avail: values.MemAvailable || 0,
    buffers: values.Buffers || 0,
    cached: values.Cached || 0,
    sreclaimable: values.SReclaimable || 0,
    shmem: values.Shmem || 0,
    dirty: values.Dirty || 0,
    swapTotal: values.SwapTotal || 0,
    swapFree: values.SwapFree || 0
  }
}

// The classic used / cache / free split (free(1)'s accounting): cache is
// page cache + buffers + reclaimable slab — memory the kernel hands back
// under pressure — and used is what remains after free and cache.
function memBreakdown(mem) {
  var cache = (mem.buffers || 0) + (mem.cached || 0) + (mem.sreclaimable || 0)
  var used = Math.max(0, (mem.total || 0) - (mem.free || 0) - cache)
  return { used: used, cache: cache, free: mem.free || 0, total: mem.total || 0 }
}

// /proc/swaps body lines: "/dev/zram0 partition size used prio".
function parseSwaps(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].trim().split(/\s+/)
    if (parts.length < 2) continue
    result.push({ name: parts[0], kind: parts[1] })
  }
  return result
}

// "zram (compressed RAM)" / "zram + disk" / "" — the swap row's aside, so
// a zram swap isn't mistaken for disk thrash.
function swapNote(swaps) {
  var zram = false, disk = false
  for (var i = 0; i < (swaps || []).length; i++) {
    if (/zram/.test(swaps[i].name)) zram = true
    else disk = true
  }
  if (zram && disk) return "zram + disk"
  if (zram) return "zram (compressed RAM)"
  return ""
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

// "/usr/lib/zen/zen-bin --flag" → "zen-bin --flag"; kernel threads
// ("[kworker/…]") pass through untouched.
function procDisplay(args) {
  var s = String(args || "")
  if (s.charAt(0) !== "/") return s
  var space = s.indexOf(" ")
  var head = space === -1 ? s : s.slice(0, space)
  var tail = space === -1 ? "" : s.slice(space)
  return head.slice(head.lastIndexOf("/") + 1) + tail
}

// ps axo pid=,user:16=,pcpu=,pmem=,nlwp=,args= lines; args is last so its
// spaces survive. Pre-0.10 four-field lines (pid pcpu pmem args) still
// parse, for older captures.
function parsePs(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim()
    var match = line.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/)
    if (match) {
      result.push({ pid: match[1], user: match[2], cpu: Number(match[3]), mem: Number(match[4]), threads: Number(match[5]), comm: match[6] })
      continue
    }
    var legacy = line.match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/)
    if (legacy) result.push({ pid: legacy[1], user: "", cpu: Number(legacy[2]), mem: Number(legacy[3]), threads: 0, comm: legacy[4] })
  }
  return result
}

// ---- Process table -------------------------------------------------------
// The sampler emits the full table once; sorting, filtering, and the
// display cap are pure functions here so the panel can re-slice without
// resampling.

function topProcs(list, key, count) {
  var sorted = (list || []).slice().sort(function(a, b) { return (b[key] || 0) - (a[key] || 0) })
  return sorted.slice(0, count || 10)
}

function filterProcs(list, query) {
  var q = String(query || "").toLowerCase().trim()
  if (q === "") return (list || []).slice()
  var result = []
  for (var i = 0; i < (list || []).length; i++) {
    var p = list[i]
    if ((p.comm + " " + p.user + " " + p.pid).toLowerCase().indexOf(q) !== -1) result.push(p)
  }
  return result
}

var PROC_SORT_KEYS = ["cpu", "mem", "pid", "name"]

function sortProcs(list, key, asc) {
  var result = (list || []).slice()
  function val(p) {
    if (key === "pid") return Number(p.pid)
    if (key === "name") return procDisplay(p.comm).toLowerCase()
    return p[key] || 0
  }
  result.sort(function(a, b) {
    var va = val(a), vb = val(b)
    var cmp = va < vb ? -1 : (va > vb ? 1 : 0)
    return asc ? cmp : -cmp
  })
  return result
}

// The rows the PROC tab renders: filtered, sorted, capped (a Repeater
// over the full table would put thousands of items in the scene).
function visibleProcs(list, query, key, asc, cap) {
  var rows = sortProcs(filterProcs(list, query), key, asc)
  var limit = cap || 40
  return { rows: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) }
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
    var limit = p.length > 8 ? Number(p[8]) : NaN
    result.push({
      name: p[0].trim(),
      status: p[1].trim(),
      capacity: p[2].trim() !== "" && isFinite(cap) ? cap : NaN,
      energyNowWh: (Number(p[3]) || 0) / 1e6,
      energyFullWh: (Number(p[4]) || 0) / 1e6,
      energyDesignWh: (Number(p[5]) || 0) / 1e6,
      powerW: (Number(p[6]) || 0) / 1e6,
      model: p[7].trim(),
      // A configured charge cap (e.g. 80%) — without surfacing it, a
      // battery parked at its limit looks like a charging bug.
      chargeLimit: isFinite(limit) && limit > 0 && limit < 100 ? limit : NaN
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

function friendlyChip(chip) {
  for (var i = 0; i < CHIP_NAMES.length; i++) {
    if (CHIP_NAMES[i][0].test(chip)) return CHIP_NAMES[i][1]
  }
  return chip
}

// The device half of a sensor's display name: "NVMe · KINGSTON SNV3S1000G",
// "Motherboard · nct6799". Doubles as the TEMP-tab group title.
function tempDeviceTitle(temp) {
  var friendly = friendlyChip(temp.chip)
  var parts = [friendly]
  if (temp.device && temp.device !== "") parts.push(temp.device)
  else if (friendly !== temp.chip) parts.push(temp.chip)
  return parts.join(" · ")
}

// "NVMe · KINGSTON SNV3S1000G · Composite" style display name; fans share
// the shape so they reuse this.
function tempName(temp) {
  var name = tempDeviceTitle(temp)
  if (temp.label && temp.label !== "") name += " · " + temp.label
  return name
}

// TEMP-tab groups: sensors sharing a physical device render under one
// device header, with just the sensor label per row.
function groupTemps(temps) {
  var groups = []
  var byTitle = {}
  for (var i = 0; i < temps.length; i++) {
    var title = tempDeviceTitle(temps[i])
    if (!(title in byTitle)) {
      byTitle[title] = { title: title, sensors: [] }
      groups.push(byTitle[title])
    }
    byTitle[title].sensors.push(temps[i])
  }
  return groups
}

// The per-row label inside a group: the sensor's own label; chips that
// expose a single unnamed sensor fall back to a generic one.
function sensorRowLabel(temp) {
  return temp.label && temp.label !== "" ? temp.label : "Temperature"
}

// "Advanced Micro Devices, Inc. [AMD/ATI] Navi 48 [Radeon RX 9070/...] (rev c0)"
// → "Radeon RX 9070/9070 XT/9070 GRE". A lone vendor bracket
// ("... [AMD/ATI] Phoenix1") is never the answer — strip it and keep the
// chip name that follows.
function prettyGpuName(raw) {
  var name = String(raw || "").replace(/\s*\(rev [^)]*\)\s*$/, "").trim()
  if (name === "") return ""
  var brackets = name.match(/\[([^\]]+)\]/g)
  if (brackets && brackets.length > 0) {
    var last = brackets[brackets.length - 1].slice(1, -1)
    if (!/^(AMD\/ATI|NVIDIA|Intel)$/i.test(last)) return last
  }
  return name.replace(/^[^\[]*\[[^\]]*\]\s*/, "").trim() || name
}

// GPU lines (amdgpu sysfs): card|busy|vram_used|vram_total|temp|power (µW)
// |gtt_used|gtt_total|apu; the lspci name arrives separately in the static
// GPUNAMES section. Pre-0.9.0 captures without the GTT fields still parse.
function parseGpus(lines, names) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 5) continue
    var isApu = parts.length > 8 && parts[8].trim() === "1"
    result.push({
      card: parts[0],
      label: "GPU " + parts[0],
      busy: Number(parts[1]) || 0,
      vramUsed: Number(parts[2]) || 0,
      vramTotal: Number(parts[3]) || 0,
      celsius: parts[4] !== "" ? Number(parts[4]) / 1000 : NaN,
      powerW: parts.length > 5 && parts[5] !== "" ? Number(parts[5]) / 1e6 : NaN,
      gttUsed: parts.length > 6 ? Number(parts[6]) || 0 : 0,
      gttTotal: parts.length > 7 ? Number(parts[7]) || 0 : 0,
      apu: isApu,
      // Nobody recognizes iGPU die codenames ("Phoenix1", "Granite
      // Ridge"); say what the card is instead.
      name: isApu ? "AMD Integrated Graphics" : prettyGpuName(names && parts[0] in names ? names[parts[0]] : "")
    })
  }
  return result
}

// The memory pool a GPU can actually allocate from. A dGPU's pool is its
// VRAM. An APU's mem_info_vram_total is only the BIOS carve-out — once
// it's spent the driver allocates from GTT (a window into system RAM), so
// the true ceiling is carve-out + GTT.
function gpuMemUsed(gpu) {
  return gpu.apu ? (gpu.vramUsed || 0) + (gpu.gttUsed || 0) : (gpu.vramUsed || 0)
}

function gpuMemTotal(gpu) {
  return gpu.apu ? (gpu.vramTotal || 0) + (gpu.gttTotal || 0) : (gpu.vramTotal || 0)
}

// GPUINTEL lines: card|temp|power (µW). i915/xe expose no busy counter,
// so usage is NaN and the panel says so instead of showing zeros.
function parseIntelGpus(lines, names) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var parts = lines[i].split("|")
    if (parts.length < 3) continue
    var name = prettyGpuName(names && parts[0] in names ? names[parts[0]] : "")
    // Intel iGPU lspci names sometimes carry only the die codename
    // ("Raptor Lake-P"); say what the card is instead. Real product
    // names (UHD/Iris Xe/Arc) pass through.
    if (!/graphics|iris|arc|xe|uhd|hd/i.test(name)) name = "Intel Integrated Graphics"
    result.push({
      card: parts[0],
      label: "GPU " + parts[0] + " (Intel)",
      busy: NaN,
      noBusyCounter: true,
      vramUsed: 0,
      vramTotal: 0,
      celsius: parts[1] !== "" ? Number(parts[1]) / 1000 : NaN,
      powerW: parts[2] !== "" ? Number(parts[2]) / 1e6 : NaN,
      name: name
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

// GPUPDEV lines: "card|pciaddr" → { "0": "0000:0f:00.0", ... }; joins
// per-process GPU clients (which carry drm-pdev) back to their card.
function parseGpuPdev(lines) {
  var map = {}
  for (var i = 0; i < lines.length; i++) {
    var idx = lines[i].indexOf("|")
    if (idx > 0) map[lines[i].slice(0, idx)] = lines[i].slice(idx + 1).trim()
  }
  return map
}

// GPUPROC lines: pid|comm|pdev|client-id|engine_ns_total|vram_kib — one
// DRM client per line, engine time cumulative since the client opened.
function parseGpuProc(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var p = lines[i].split("|")
    if (p.length < 6) continue
    result.push({
      pid: p[0],
      comm: p[1].trim(),
      pdev: p[2],
      client: p[3],
      engineNs: Number(p[4]) || 0,
      vramKib: Number(p[5]) || 0
    })
  }
  return result
}

// Per-process GPU usage between two client snapshots: engine-time delta
// over elapsed wall clock, aggregated per (pid, card). Engines can run in
// parallel, so the sum is capped at 100. Sorted busiest first.
function gpuProcRates(prev, cur, elapsedSec) {
  var prevByKey = {}
  if (prev) {
    for (var i = 0; i < prev.length; i++) {
      var e = prev[i]
      prevByKey[e.pid + "|" + e.pdev + "|" + e.client] = e
    }
  }
  var byProc = {}
  var order = []
  for (var j = 0; j < (cur || []).length; j++) {
    var c = cur[j]
    var pct = 0
    var p = prevByKey[c.pid + "|" + c.pdev + "|" + c.client]
    if (p && elapsedSec > 0 && c.engineNs >= p.engineNs) {
      pct = 100 * (c.engineNs - p.engineNs) / (elapsedSec * 1e9)
    }
    var key = c.pid + "|" + c.pdev
    if (!byProc[key]) {
      byProc[key] = { pid: c.pid, comm: c.comm, pdev: c.pdev, pct: 0, vramKib: 0 }
      order.push(key)
    }
    byProc[key].pct += pct
    byProc[key].vramKib += c.vramKib
  }
  var result = []
  for (var k = 0; k < order.length; k++) {
    var row = byProc[order[k]]
    row.pct = Math.min(100, row.pct)
    result.push(row)
  }
  result.sort(function(a, b) { return b.pct - a.pct || b.vramKib - a.vramKib })
  return result
}

// DRIVEHEALTH lines (from udisks2, see sample.sh):
//   dev|nvme|model|poweron_h|critwarn|wear_pct|warn_temp_s|crit_temp_s|media_err|unsafe
//   dev|ata|model|poweron_h|failing
function parseDriveHealth(lines) {
  var result = []
  for (var i = 0; i < lines.length; i++) {
    var p = lines[i].split("|")
    if (p.length < 5) continue
    var entry = {
      dev: p[0].trim(),
      kind: p[1].trim(),
      model: p[2].trim(),
      powerOnHours: Number(p[3]) || 0,
      warning: (p[4] || "").trim(),
      wearPct: NaN,
      warnTempSec: NaN,
      critTempSec: NaN,
      mediaErrors: NaN,
      unsafeShutdowns: NaN
    }
    if (entry.kind === "nvme" && p.length >= 10) {
      entry.wearPct = p[5] !== "" ? Number(p[5]) : NaN
      entry.warnTempSec = p[6] !== "" ? Number(p[6]) : NaN
      entry.critTempSec = p[7] !== "" ? Number(p[7]) : NaN
      entry.mediaErrors = p[8] !== "" ? Number(p[8]) : NaN
      entry.unsafeShutdowns = p[9] !== "" ? Number(p[9]) : NaN
    }
    result.push(entry)
  }
  return result
}

// A drive worth worrying about: the controller raised a critical warning
// (or SATA SMART says failing), wear passed the (configurable) alarm
// level, or the media itself has logged errors.
function driveHealthBad(drive, wearLimit) {
  if (!drive) return false
  var limit = isFinite(wearLimit) ? wearLimit : DEFAULT_THRESHOLDS.wearPct
  if (drive.warning !== "") return true
  if (isFinite(drive.wearPct) && drive.wearPct >= limit) return true
  if (isFinite(drive.mediaErrors) && drive.mediaErrors > 0) return true
  return false
}

// One-line health summary: "worn 9% · on 148d · healthy".
function fmtDriveHealth(drive) {
  var parts = []
  if (isFinite(drive.wearPct)) parts.push("worn " + Math.round(drive.wearPct) + "%")
  if (drive.powerOnHours > 0) parts.push("on " + fmtUptime(drive.powerOnHours * 3600))
  if (drive.warning !== "") parts.push(drive.warning)
  else if (isFinite(drive.mediaErrors) && drive.mediaErrors > 0) parts.push(drive.mediaErrors + " media errors")
  else parts.push("healthy")
  return parts.join(" · ")
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
// With a `phys` set, virtual interfaces (veth, bridges, tun/wg) are kept
// out of the totals — VPN traffic would otherwise count twice — but stay
// in perIface, flagged. Without any known physical interface, everything
// counts (containers/VMs see only virtual NICs).
function netRates(prevNet, net, elapsedSec, phys) {
  var byIface = {}
  if (prevNet) for (var i = 0; i < prevNet.length; i++) byIface[prevNet[i].iface] = prevNet[i]
  var anyPhys = false
  if (phys) for (var p = 0; p < net.length; p++) if (net[p].iface in phys) { anyPhys = true; break }
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
    var virtual = anyPhys && !(cur.iface in phys)
    if (!virtual) {
      down += rx
      up += tx
    }
    perIface.push({ iface: cur.iface, down: rx, up: tx, total: cur.rx + cur.tx, virtual: virtual })
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

// The hottest storage-device sensor (NVMe composite, SATA drivetemp), for
// the drive-temperature alert. Null when no drive exposes one.
function hottestDrive(temps) {
  var best = null
  for (var i = 0; i < temps.length; i++) {
    var t = temps[i]
    if (t.chip !== "nvme" && t.chip !== "drivetemp") continue
    if (!best || t.celsius > best.celsius) best = t
  }
  return best
}

// Whether any hwmon chip looks like a motherboard Super I/O / EC sensor.
// Used with the chassis type to hint desktop users at the missing kernel
// driver (nct6775 & friends do not auto-load).
var MOTHERBOARD_CHIP = /^nct|^it8|^w83|^f71|^asus/

function hasMotherboardSensors(temps, fans) {
  var lists = [temps || [], fans || []]
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      if (MOTHERBOARD_CHIP.test(lists[l][i].chip)) return true
    }
  }
  return false
}

// SMBIOS chassis types that mean "a desktop tower with fan headers".
function isDesktopChassis(type) {
  return [3, 4, 5, 6, 7].indexOf(Number(type)) !== -1
}

// ---- Per-sensor thresholds -----------------------------------------------
// Optional user-set alert thresholds for individual temperature sensors,
// persisted as a { key: celsius } map in shell.json. Keyed by
// chip|device|label — stable across reboots, unlike hwmon numbering.
// Independent of (and in addition to) the CPU/GPU/drive defaults.

function sensorKey(temp) {
  return temp.chip + "|" + (temp.device || "") + "|" + (temp.label || "")
}

var SENSOR_THRESHOLD_MIN = 30
var SENSOR_THRESHOLD_MAX = 120

function normalizeSensorThresholds(value) {
  var map = {}
  if (value && typeof value === "object") {
    for (var key in value) {
      var n = Number(value[key])
      if (isFinite(n) && n >= SENSOR_THRESHOLD_MIN && n <= SENSOR_THRESHOLD_MAX) map[key] = n
    }
  }
  return map
}

// Returns a new map with `key` set to `celsius`, or removed when celsius
// is not a finite number (the UI's "off").
function setSensorThreshold(current, key, celsius) {
  var map = normalizeSensorThresholds(current)
  var n = Number(celsius)
  if (isFinite(n)) {
    map[key] = Math.max(SENSOR_THRESHOLD_MIN, Math.min(SENSOR_THRESHOLD_MAX, Math.round(n)))
  } else {
    delete map[key]
  }
  return map
}

function sensorThreshold(map, temp) {
  var key = sensorKey(temp)
  return map && key in map ? map[key] : NaN
}

// A sensible starting threshold when the user first enables one: a bit of
// headroom above the current reading, on a 5° grid.
function suggestedSensorThreshold(celsius) {
  var base = isFinite(celsius) ? celsius + 10 : 70
  return Math.max(SENSOR_THRESHOLD_MIN, Math.min(SENSOR_THRESHOLD_MAX, Math.ceil(base / 5) * 5))
}

// User-hidden sensor rows (Super I/O chips expose junk inputs), persisted
// as a list of sensor keys. Hidden sensors are only hidden — their
// per-sensor thresholds keep alerting.
function normalizeHiddenSensors(value) {
  var list = value instanceof Array ? value : []
  var result = []
  for (var i = 0; i < list.length; i++) {
    if (typeof list[i] === "string" && list[i] !== "" && result.indexOf(list[i]) === -1) result.push(list[i])
  }
  return result
}

function toggleHiddenSensor(current, key) {
  var list = normalizeHiddenSensors(current)
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else list.push(key)
  return list
}

// The ALERTS tab's view of the TEMP-tab per-sensor thresholds: one row
// per armed sensor, resolved against the live sensor list when present
// (a stored threshold for unplugged hardware still shows, by its key).
function sensorAlertRows(thresholds, temps) {
  var byKey = {}
  for (var i = 0; i < (temps || []).length; i++) byKey[sensorKey(temps[i])] = temps[i]
  var rows = []
  for (var key in thresholds) {
    var t = byKey[key]
    rows.push({
      key: key,
      label: t ? tempName(t) : key.split("|").filter(function(p) { return p !== "" }).join(" · "),
      now: t ? t.celsius : NaN,
      limit: thresholds[key]
    })
  }
  rows.sort(function(a, b) { return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0) })
  return rows
}

// ---- Home tab ------------------------------------------------------------
// Overview tiles: one glance, no tab-hopping. The user picks which show
// (persisted as `homeTiles`, same pattern as the bar's `show`); clicking
// a tile opens its tab.
var HOME_TILES = [
  { key: "cpu",  label: "CPU",      icon: "\u{f0ee0}", tab: "CPU" },
  { key: "ram",  label: "Memory",   icon: "\u{f035b}", tab: "MEM" },
  { key: "gpu",  label: "GPU",      icon: "\u{f08ae}", tab: "GPU" },
  { key: "net",  label: "Network",  icon: "\u{f06f3}", tab: "NET" },
  { key: "io",   label: "Disk I/O", icon: "\u{f02ca}", tab: "DISK" },
  { key: "disk", label: "Disk",     icon: "\u{f02ca}", tab: "DISK" },
  { key: "bat",  label: "Battery",  icon: "\u{f0079}", tab: "BAT" }
]

var DEFAULT_HOME = ["cpu", "ram", "gpu", "net", "io", "disk"]

function homeTileByKey(key) {
  for (var i = 0; i < HOME_TILES.length; i++) if (HOME_TILES[i].key === key) return HOME_TILES[i]
  return null
}

function normalizeHomeTiles(value) {
  var list = value instanceof Array ? value : DEFAULT_HOME
  var result = []
  for (var i = 0; i < list.length; i++) {
    if (homeTileByKey(list[i]) !== null && result.indexOf(list[i]) === -1) result.push(list[i])
  }
  return result
}

function toggleHomeTile(current, key) {
  var list = normalizeHomeTiles(current)
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else if (homeTileByKey(key) !== null) list.push(key)
  return list
}

// Element-wise sum of two equal-cadence history rings (disk R+W).
function sumHist(a, b) {
  var result = []
  var n = Math.max((a || []).length, (b || []).length)
  for (var i = 0; i < n; i++) {
    result.push(((a && a[a.length - n + i]) || 0) + ((b && b[b.length - n + i]) || 0))
  }
  return result
}

// The discrete GPU when there is one: the card with the most *dedicated*
// VRAM. Deliberately not the pooled total — an APU's GTT window is sized
// off system RAM and would let a 2-CU iGPU outrank a real dGPU.
function primaryGpu(gpus) {
  var best = null
  for (var i = 0; i < gpus.length; i++) {
    if (!best || gpus[i].vramTotal > best.vramTotal) best = gpus[i]
  }
  return best
}

// GPU-tab display order: the primary card first, the rest in card order —
// the card whose stats the bar follows shouldn't hide below an idle iGPU.
function primaryFirstGpus(gpus) {
  var primary = primaryGpu(gpus)
  if (!primary) return gpus
  var result = [primary]
  for (var i = 0; i < gpus.length; i++) if (gpus[i] !== primary) result.push(gpus[i])
  return result
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

// ---- Tiered history ------------------------------------------------------
// Behind the per-tick ring sit two peak rings: an hour ring (HISTORY_LEN
// slots of HOUR_SLOT_SEC) and a day ring (same slot count, DAY_SLOT_SEC
// each — 60 × 24 min = 24 h). Every slot keeps the *maximum* the series
// hit in its window — history is for finding spikes, and averaging would
// erase exactly what you scrolled back to find. All series roll up in one
// object so QML rebinds once per tick.

var HOUR_SLOT_SEC = 60
var DAY_SLOT_SEC = 1440
// cpuPower/gpuPower/cpuTemp joined in 1.0 so power spikes and thermals
// are answerable over 24h, not just usage; history files from before
// simply load those series empty.
var HOUR_KEYS = ["cpu", "mem", "gpu", "netDown", "netUp", "ioRead", "ioWrite", "cpuPower", "gpuPower", "cpuTemp"]

// The sparkline spans and the slot width behind each.
var SPANS = ["2m", "1h", "24h"]

function nextSpan(span) {
  return SPANS[(SPANS.indexOf(span) + 1) % SPANS.length]
}

function spanSlotSec(span, intervalSec) {
  if (span === "1h") return HOUR_SLOT_SEC
  if (span === "24h") return DAY_SLOT_SEC
  return Math.max(1, Number(intervalSec) || 1)
}

function emptyHourHist() {
  var hour = { since: 0 }
  for (var i = 0; i < HOUR_KEYS.length; i++) hour[HOUR_KEYS[i]] = { values: [], acc: NaN }
  return hour
}

// Fold one tick's values into a peak ring; when the current slot's
// wall-clock window closes, its accumulated peak is pushed and a new slot
// starts. Returns a new object (QML rebind). slotSec defaults to the
// hour ring's minute slots.
function pushHourHist(hour, values, nowMs, slotSec) {
  var slotMs = (slotSec || HOUR_SLOT_SEC) * 1000
  var next = { since: hour && hour.since ? hour.since : nowMs }
  var close = nowMs - next.since >= slotMs
  for (var i = 0; i < HOUR_KEYS.length; i++) {
    var key = HOUR_KEYS[i]
    var prev = (hour && hour[key]) || { values: [], acc: NaN }
    var v = Number(values[key])
    if (!isFinite(v)) v = 0
    var acc = isFinite(prev.acc) ? Math.max(prev.acc, v) : v
    next[key] = close
      ? { values: pushHistory(prev.values, acc), acc: NaN }
      : { values: prev.values, acc: acc }
  }
  if (close) next.since = nowMs
  return next
}

// ---- The flight recorder -------------------------------------------------
// The hour and day rings (and the alert log) persist to disk once a
// minute and are reloaded when the shell starts, so Argus still knows
// what happened before a restart or overnight. Values are rounded on
// save — peaks, not decimals, are what the rings are for.

var HISTORY_FILE_VERSION = 1
var ALERT_LOG_CAP = 20

function serializeHistory(hour, day, alerts, nowMs) {
  function pack(ring) {
    var out = { since: (ring && ring.since) || 0 }
    for (var i = 0; i < HOUR_KEYS.length; i++) {
      var key = HOUR_KEYS[i]
      var entry = (ring && ring[key]) || { values: [], acc: NaN }
      out[key] = {
        values: entry.values.map(function(v) { return Math.round(v) }),
        acc: isFinite(entry.acc) ? Math.round(entry.acc) : null
      }
    }
    return out
  }
  return JSON.stringify({
    v: HISTORY_FILE_VERSION,
    savedAt: nowMs,
    hour: pack(hour),
    day: pack(day),
    alerts: (alerts || []).slice(0, ALERT_LOG_CAP)
  })
}

// Reopen a persisted peak ring after downtime: the saved partial slot
// closes, the gap renders as empty slots, and the ring resumes at now.
function resumeHist(ring, slotSec, nowMs) {
  var next = emptyHourHist()
  if (!ring || !ring.since) return next
  var gapSlots = Math.floor(Math.max(0, nowMs - ring.since) / (slotSec * 1000))
  for (var i = 0; i < HOUR_KEYS.length; i++) {
    var key = HOUR_KEYS[i]
    var prev = ring[key] || { values: [], acc: NaN }
    var values = prev.values.slice()
    if (isFinite(prev.acc)) values = pushHistory(values, prev.acc)
    for (var g = 0; g < Math.min(gapSlots, HISTORY_LEN); g++) values = pushHistory(values, 0)
    next[key] = { values: values, acc: NaN }
  }
  next.since = nowMs
  return next
}

// Parse a persisted history file back into live rings, resumed at nowMs.
// Anything malformed — wrong version, truncated write, hand-edited —
// falls back to empty rings rather than a broken panel.
function restoreHistory(text, nowMs) {
  var empty = { hour: emptyHourHist(), day: emptyHourHist(), alerts: [] }
  var parsed
  try { parsed = JSON.parse(text) } catch (e) { return empty }
  if (!parsed || parsed.v !== HISTORY_FILE_VERSION) return empty
  function unpack(ring) {
    var out = emptyHourHist()
    if (!ring) return out
    out.since = Number(ring.since) || 0
    for (var i = 0; i < HOUR_KEYS.length; i++) {
      var key = HOUR_KEYS[i]
      var entry = ring[key]
      if (!entry || !(entry.values instanceof Array)) continue
      var values = []
      for (var j = 0; j < entry.values.length && j < HISTORY_LEN; j++) values.push(Number(entry.values[j]) || 0)
      var acc = entry.acc === null || entry.acc === undefined ? NaN : Number(entry.acc)
      out[key] = { values: values, acc: isFinite(acc) ? acc : NaN }
    }
    return out
  }
  var alerts = []
  if (parsed.alerts instanceof Array) {
    for (var a = 0; a < parsed.alerts.length && a < ALERT_LOG_CAP; a++) {
      var alert = parsed.alerts[a]
      if (alert && isFinite(Number(alert.at)) && typeof alert.text === "string") alerts.push(alert)
    }
  }
  return {
    hour: resumeHist(unpack(parsed.hour), HOUR_SLOT_SEC, nowMs),
    day: resumeHist(unpack(parsed.day), DAY_SLOT_SEC, nowMs),
    alerts: alerts
  }
}

// The hour series a sparkline renders: completed slots plus the live
// partial slot at the right edge, capped to the chart's slot count.
function hourValues(hour, key) {
  var entry = hour && hour[key]
  if (!entry) return []
  var result = isFinite(entry.acc) ? entry.values.concat([entry.acc]) : entry.values.slice()
  while (result.length > HISTORY_LEN) result.shift()
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

// ---- In-game HUD (MangoHud) ----------------------------------------------
// The GAME tab writes a managed MangoHud config; these are the pure
// pieces — the metric catalog, the settings normalizer, and the config
// renderer. Nothing here talks to MangoHud: the shell writes the file
// and pokes `mangohudctl reload-cfg`, so a running game restyles live.

var MANGO_METRICS = [
  { key: "fps",        label: "FPS",                 params: ["fps"] },
  { key: "frametime",  label: "Frametime + graph",   params: ["frametime", "frame_timing"] },
  { key: "cpu",        label: "CPU load + temp",     params: ["cpu_stats", "cpu_temp"] },
  { key: "cpuextra",   label: "CPU clock + power",   params: ["cpu_mhz", "cpu_power"] },
  { key: "cores",      label: "Per-core loads",      params: ["core_load"] },
  { key: "gpu",        label: "GPU load + temp",     params: ["gpu_stats", "gpu_temp"] },
  { key: "gpuextra",   label: "GPU clocks + power",  params: ["gpu_core_clock", "gpu_mem_clock", "gpu_power"] },
  { key: "vram",       label: "VRAM",                params: ["vram"] },
  { key: "ram",        label: "RAM",                 params: ["ram"] },
  { key: "engine",     label: "Engine + Wine",       params: ["engine_version", "wine"] },
  { key: "gamemode",   label: "GameMode + vkBasalt", params: ["gamemode", "vkbasalt"] },
  { key: "resolution", label: "Resolution",          params: ["resolution"] },
  { key: "throttle",   label: "Throttling status",   params: ["throttling_status"] },
  { key: "histogram",  label: "FPS histogram",       params: ["histogram"] },
  { key: "clock",      label: "Clock",               params: ["time"] },
  { key: "battery",    label: "Battery",             params: ["battery", "battery_watt"] }
]

var MANGO_POSITIONS = ["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]
var DEFAULT_MANGO_METRICS = ["fps", "frametime", "cpu", "gpu"]
// fps_limit choices the stepper walks through; 0 = uncapped.
var MANGO_FPS_LIMITS = [0, 30, 60, 90, 120, 144, 165, 240]

function mangoMetricByKey(key) {
  for (var i = 0; i < MANGO_METRICS.length; i++) if (MANGO_METRICS[i].key === key) return MANGO_METRICS[i]
  return null
}

// Config values land on their own line in a line-and-comma-structured
// file; strip anything that could break out of one.
function cleanMangoValue(value) {
  return String(value || "").replace(/[\r\n,#]/g, " ").replace(/\s+/g, " ").trim().slice(0, 64)
}

// "#aarrggbb" / "#rrggbb" → "RRGGBB", MangoHud's color format.
function mangoColor(color) {
  var hex = String(color || "").replace("#", "")
  return (hex.length === 8 ? hex.slice(2) : hex).toUpperCase()
}

function normalizeMango(value) {
  var m = value && typeof value === "object" ? value : {}
  function num(v, lo, hi, dflt) {
    var n = Number(v)
    return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
  }
  var metrics = []
  var list = m.metrics instanceof Array ? m.metrics : DEFAULT_MANGO_METRICS
  for (var i = 0; i < list.length; i++) {
    if (mangoMetricByKey(list[i]) !== null && metrics.indexOf(list[i]) === -1) metrics.push(list[i])
  }
  return {
    enabled: m.enabled === true,
    metrics: metrics,
    cpuText: cleanMangoValue(m.cpuText),
    gpuText: cleanMangoValue(m.gpuText),
    position: MANGO_POSITIONS.indexOf(m.position) !== -1 ? m.position : "top-left",
    fontSize: Math.round(num(m.fontSize, 12, 48, 22)),
    bgAlpha: Math.round(num(m.bgAlpha, 0, 1, 0.4) * 10) / 10,
    compact: m.compact === true,
    themed: m.themed !== false,
    startHidden: m.startHidden === true,
    hotkey: cleanMangoValue(m.hotkey) || "Shift_R+F12",
    horizontal: m.horizontal === true,
    roundCorners: Math.round(num(m.roundCorners, 0, 20, 0)),
    tableColumns: Math.round(num(m.tableColumns, 1, 6, 3)),
    offsetX: Math.round(num(m.offsetX, 0, 4000, 0)),
    offsetY: Math.round(num(m.offsetY, 0, 4000, 0)),
    fpsLimit: MANGO_FPS_LIMITS.indexOf(Number(m.fpsLimit)) !== -1 ? Number(m.fpsLimit) : 0,
    fpsLow: Math.round(num(m.fpsLow, 10, 495, 30)),
    fpsHigh: Math.round(num(m.fpsHigh, 15, 500, 60))
  }
}

// Walk the fps_limit choices; delta is ±1.
function stepFpsLimit(current, delta) {
  var index = MANGO_FPS_LIMITS.indexOf(Number(current))
  if (index === -1) index = 0
  return MANGO_FPS_LIMITS[Math.max(0, Math.min(MANGO_FPS_LIMITS.length - 1, index + delta))]
}

function toggleMangoMetric(current, key) {
  var list = normalizeMango({ metrics: current }).metrics
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else if (mangoMetricByKey(key) !== null) list.push(key)
  return list
}

// Render the managed config. `colors` (already mangoColor-stripped hex)
// themes the overlay to match the shell; disabled renders a config that
// only hides the HUD, so flipping the master toggle mid-game takes
// effect on reload too.
function mangohudConfig(mango, colors) {
  var lines = ["# Managed by Argus - edits are overwritten; configure in the GAME tab."]
  if (!mango.enabled) {
    lines.push("no_display")
    return lines.join("\n") + "\n"
  }
  lines.push("toggle_hud=" + mango.hotkey)
  lines.push("position=" + mango.position)
  lines.push("font_size=" + mango.fontSize)
  lines.push("background_alpha=" + mango.bgAlpha)
  lines.push("table_columns=" + mango.tableColumns)
  if (mango.compact) lines.push("hud_compact")
  if (mango.startHidden) lines.push("no_display")
  if (mango.horizontal) lines.push("horizontal")
  if (mango.roundCorners > 0) lines.push("round_corners=" + mango.roundCorners)
  if (mango.offsetX > 0) lines.push("offset_x=" + mango.offsetX)
  if (mango.offsetY > 0) lines.push("offset_y=" + mango.offsetY)
  if (mango.fpsLimit > 0) lines.push("fps_limit=" + mango.fpsLimit)
  // Explicit in both directions: several params (fps, frametime,
  // frame_timing, cpu_stats, gpu_stats) are default-ON inside MangoHud,
  // so an absent line doesn't disable them — only `param=0` does.
  for (var i = 0; i < MANGO_METRICS.length; i++) {
    var metric = MANGO_METRICS[i]
    var on = mango.metrics.indexOf(metric.key) !== -1
    for (var p = 0; p < metric.params.length; p++) {
      lines.push(on ? metric.params[p] : metric.params[p] + "=0")
    }
  }
  if (mango.cpuText !== "") lines.push("cpu_text=" + mango.cpuText)
  if (mango.gpuText !== "") lines.push("gpu_text=" + mango.gpuText)
  if (mango.themed && colors) {
    lines.push("text_color=" + colors.text)
    lines.push("background_color=" + colors.background)
    lines.push("cpu_color=" + colors.accent)
    lines.push("gpu_color=" + colors.accent)
    lines.push("engine_color=" + colors.text)
    lines.push("frametime_color=" + colors.accent)
    var low = Math.min(mango.fpsLow, mango.fpsHigh - 5)
    lines.push("fps_value=" + low + "," + mango.fpsHigh)
    lines.push("fps_color=" + colors.urgent + "," + colors.text + "," + colors.accent)
  }
  return lines.join("\n") + "\n"
}

// ---- Temperature unit ----------------------------------------------------
// Display-only: everything is measured, stored, and thresholded in °C;
// this only flips how temperatures render. Each QML importer holds its
// own copy of this module, so every importer sets it (cheap, idempotent).
var tempUnit = "C"

function setTempUnit(unit) {
  tempUnit = unit === "F" ? "F" : "C"
}

// The number a Celsius reading displays as in the chosen unit.
function displayTemp(celsius) {
  return tempUnit === "F" ? Math.round(celsius * 9 / 5 + 32) : Math.round(celsius)
}

// "°" in Celsius (the default needs no flag), "°F" in Fahrenheit — the
// conversion must be visible, not guessed at.
function tempSuffix() {
  return tempUnit === "F" ? "°F" : "°"
}

function fmtTemp(celsius) {
  return isFinite(celsius) ? displayTemp(celsius) + tempSuffix() : "—"
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

// Left-pad a value with no-break spaces (plain spaces collapse in the
// styled-text urgent path) so bar segments keep a stable width as values
// change — "9%" → "10%" would otherwise shift every neighboring widget.
var PAD_SPACE = "\u00A0"

function padValue(text, width) {
  var s = String(text)
  while (s.length < width) s = PAD_SPACE + s
  return s
}

// The short value a metric shows in the bar, or "" to hide the segment
// (e.g. GPU metrics on a machine without a supported GPU, battery on a
// desktop, an asleep NVIDIA card). With `pad`, values are no-break-space
// padded to their common widest form (horizontal bar only — padding would
// off-center the vertical bar's centered lines).
function metricValue(key, data, pad) {
  // Percentages and temperatures are 2 digits nearly always; rates swing
  // between "0" and "9.9M" constantly, so they pad to 4.
  function p3(s) { return pad && s !== "" ? padValue(s, 3) : s }
  function p4(s) { return pad ? padValue(s, 4) : s }
  switch (key) {
    case "cpu": return p3(fmtPct(data.cpuPct))
    case "cputemp": return isFinite(data.cpuTemp) ? p3(fmtTemp(data.cpuTemp)) : ""
    case "ram": return p3(fmtPct(data.memPct))
    case "gpu": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.busy) ? p3(fmtPct(data.gpu.busy)) : ""
    case "gputemp": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.celsius) ? p3(fmtTemp(data.gpu.celsius)) : ""
    case "vram": return data.gpu && !data.gpu.asleep && gpuMemTotal(data.gpu) > 0 ? p3(fmtPct(100 * gpuMemUsed(data.gpu) / gpuMemTotal(data.gpu))) : ""
    case "disk": return data.disk ? p3(fmtPct(100 * data.disk.used / data.disk.size)) : ""
    case "io": return data.io ? "R" + p4(fmtRateShort(data.io.read)) + " W" + p4(fmtRateShort(data.io.write)) : ""
    case "net": return ICON_DOWN + p4(fmtRateShort(data.netDown)) + " " + ICON_UP + p4(fmtRateShort(data.netUp))
    case "load": return data.load1.toFixed(2)
    case "bat": return data.battery && isFinite(data.battery.pct)
      ? batteryIcon(data.battery.pct, data.battery.charging) + " " + p3(fmtPct(data.battery.pct))
      : ""
    default: return ""
  }
}

// Whether a metric's bar segment should render in the urgent color.
function metricUrgent(key, data, th) {
  th = th || DEFAULT_THRESHOLDS
  switch (key) {
    case "cpu": return data.cpuPct >= th.cpuPct
    case "cputemp": return isFinite(data.cpuTemp) && data.cpuTemp >= th.cpuTempC
    case "ram": return data.memPct >= th.memPct
    case "gpu": return !!(data.gpu && !data.gpu.asleep && isFinite(data.gpu.busy) && data.gpu.busy >= th.gpuPct)
    case "gputemp": return !!(data.gpu && !data.gpu.asleep && isFinite(data.gpu.celsius) && data.gpu.celsius >= th.gpuTempC)
    case "drivetemp": return !!(data.driveTemp && isFinite(data.driveTemp.celsius) && data.driveTemp.celsius >= th.driveTempC)
    case "vram": return !!(data.gpu && !data.gpu.asleep && gpuMemTotal(data.gpu) > 0 && 100 * gpuMemUsed(data.gpu) / gpuMemTotal(data.gpu) >= th.vramPct)
    case "disk": return !!(data.disk && data.disk.size > 0 && 100 * data.disk.used / data.disk.size >= th.diskPct)
    case "load": return (Number(data.cores) || 0) > 0 && data.load1 >= data.cores
    case "bat": return !!(data.battery && !data.battery.charging && isFinite(data.battery.pct) && data.battery.pct <= th.batPct)
    default: return false
  }
}

// Metrics the alert watchdog evaluates every tick, regardless of which
// segments the bar shows. Load is deliberately absent — it flaps.
// drivetemp is alert-only: it never renders in the bar.
var ALERT_KEYS = ["cpu", "cputemp", "ram", "gpu", "gputemp", "vram", "disk", "bat", "drivetemp"]

// ---- Per-metric alert opt-in ---------------------------------------------
// Alerts are off by default; the user turns each one on (and tunes its
// threshold) from the BAR tab. The enabled set persists in shell.json as
// an `alertsOn` list of keys. Thresholds keep coloring bar segments and
// panel rows urgent whether or not the alert itself is enabled — the
// toggle gates notifications only.
//
// One row per toggleable alert: which shell.json setting holds its
// threshold, which thresholdsFrom() field carries the resolved value, and
// the stepper's unit/bounds. `low` marks thresholds that alarm downward
// (battery). `group` is the ALERTS-tab section header; entries sharing a
// group must stay contiguous. drivehealth is event-driven (SMART via
// udisks2), not a per-tick ALERT_KEYS metric; its threshold is the wear
// alarm, and a critical warning or media errors trip it at any wear
// level.
var ALERT_SETTINGS = [
  { key: "cpu",         label: "CPU usage",         group: "USAGE",       setting: "urgentCpuPct",     thKey: "cpuPct",     unit: "%",      min: 50, max: 100, step: 5 },
  { key: "ram",         label: "RAM usage",         group: "USAGE",       setting: "urgentMemPct",     thKey: "memPct",     unit: "%",      min: 50, max: 100, step: 5 },
  { key: "gpu",         label: "GPU usage",         group: "USAGE",       setting: "urgentGpuPct",     thKey: "gpuPct",     unit: "%",      min: 50, max: 100, step: 5 },
  { key: "vram",        label: "VRAM usage",        group: "USAGE",       setting: "urgentVramPct",    thKey: "vramPct",    unit: "%",      min: 50, max: 100, step: 5 },
  { key: "disk",        label: "Disk usage",        group: "USAGE",       setting: "urgentDiskPct",    thKey: "diskPct",    unit: "%",      min: 50, max: 100, step: 5 },
  { key: "cputemp",     label: "CPU temperature",   group: "TEMPERATURE", setting: "urgentCpuTempC",   thKey: "cpuTempC",   unit: "°",      min: 50, max: 110, step: 5 },
  { key: "gputemp",     label: "GPU temperature",   group: "TEMPERATURE", setting: "urgentGpuTempC",   thKey: "gpuTempC",   unit: "°",      min: 50, max: 120, step: 5 },
  { key: "drivetemp",   label: "Drive temperature", group: "TEMPERATURE", setting: "urgentDriveTempC", thKey: "driveTempC", unit: "°",      min: 40, max: 100, step: 5 },
  { key: "bat",         label: "Battery low",       group: "HEALTH",      setting: "urgentBatPct",     thKey: "batPct",     unit: "%",      min: 5,  max: 50,  step: 5, low: true },
  { key: "drivehealth", label: "Drive health",      group: "HEALTH",      setting: "urgentWearPct",    thKey: "wearPct",    unit: "% worn", min: 50, max: 100, step: 5 }
]

function alertSettingByKey(key) {
  for (var i = 0; i < ALERT_SETTINGS.length; i++) if (ALERT_SETTINGS[i].key === key) return ALERT_SETTINGS[i]
  return null
}

// Normalize a stored `alertsOn` value into a deduplicated list of known
// alert keys. Anything not listed is off — the default.
function normalizeAlertsOn(value) {
  var list = value instanceof Array ? value : []
  var result = []
  for (var i = 0; i < list.length; i++) {
    if (alertSettingByKey(list[i]) !== null && result.indexOf(list[i]) === -1) result.push(list[i])
  }
  return result
}

function toggleAlertOn(current, key) {
  var list = normalizeAlertsOn(current)
  var index = list.indexOf(key)
  if (index >= 0) list.splice(index, 1)
  else if (alertSettingByKey(key) !== null) list.push(key)
  return list
}

// One stepper move on an alert threshold, clamped to the entry's bounds.
function stepAlertThreshold(entry, current, delta) {
  var base = isFinite(current) ? current : DEFAULT_THRESHOLDS[entry.thKey]
  var next = Math.round(base + delta * entry.step)
  return Math.max(entry.min, Math.min(entry.max, next))
}

// "≥ 90%", "≤ 15%", "≥ 90% worn" — the compact threshold caption on an
// alert row. Temperature limits render in the display unit.
function alertLimitText(entry, th) {
  var value = th && isFinite(th[entry.thKey]) ? th[entry.thKey] : DEFAULT_THRESHOLDS[entry.thKey]
  if (entry.unit === "°") return (entry.low ? "≤ " : "≥ ") + displayTemp(value) + tempSuffix()
  return (entry.low ? "≤ " : "≥ ") + value + entry.unit
}

// The live reading an alert watches, shown beside its threshold so the
// stepper is set against reality instead of blind. "" when the reading
// is unavailable (asleep GPU, no drive sensor).
function alertNowText(entry, data, driveHealth) {
  switch (entry.key) {
    case "cpu": return fmtPct(data.cpuPct)
    case "cputemp": return isFinite(data.cpuTemp) ? fmtTemp(data.cpuTemp) : ""
    case "ram": return fmtPct(data.memPct)
    case "gpu": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.busy) ? fmtPct(data.gpu.busy) : ""
    case "gputemp": return data.gpu && !data.gpu.asleep && isFinite(data.gpu.celsius) ? fmtTemp(data.gpu.celsius) : ""
    case "vram": return data.gpu && !data.gpu.asleep && gpuMemTotal(data.gpu) > 0
      ? fmtPct(100 * gpuMemUsed(data.gpu) / gpuMemTotal(data.gpu)) : ""
    case "disk": return data.disk && data.disk.size > 0 ? fmtPct(100 * data.disk.used / data.disk.size) : ""
    case "drivetemp": return data.driveTemp && isFinite(data.driveTemp.celsius) ? fmtTemp(data.driveTemp.celsius) : ""
    case "bat": return data.battery && isFinite(data.battery.pct) ? fmtPct(data.battery.pct) : ""
    case "drivehealth":
      var worst = NaN
      for (var i = 0; i < (driveHealth || []).length; i++) {
        var wear = driveHealth[i].wearPct
        if (isFinite(wear) && !(wear <= worst)) worst = wear
      }
      return isFinite(worst) ? Math.round(worst) + "%" : ""
    default: return ""
  }
}

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
    case "cputemp": value = fmtTemp(data.cpuTemp); limit = th.cpuTempC + "°"; break
    case "ram": value = fmtPct(data.memPct); limit = th.memPct + "%"; break
    case "gpu": value = data.gpu ? fmtPct(data.gpu.busy) : "—"; limit = th.gpuPct + "%"; break
    case "gputemp": value = data.gpu ? fmtTemp(data.gpu.celsius) : "—"; limit = th.gpuTempC + "°"; break
    case "drivetemp":
      label = "Drive temperature" + (data.driveTemp && data.driveTemp.device ? " (" + data.driveTemp.device + ")" : "")
      value = data.driveTemp ? fmtTemp(data.driveTemp.celsius) : "—"
      limit = th.driveTempC + "°"
      break
    case "vram": value = data.gpu && gpuMemTotal(data.gpu) > 0 ? fmtPct(100 * gpuMemUsed(data.gpu) / gpuMemTotal(data.gpu)) : "—"; limit = th.vramPct + "%"; break
    case "disk": value = data.disk ? fmtPct(100 * data.disk.used / data.disk.size) : "—"; limit = th.diskPct + "%"; break
    case "bat": value = data.battery ? fmtPct(data.battery.pct) : "—"; limit = th.batPct + "%"; break
    default: value = "—"; limit = ""
  }
  return label + " at " + value + (limit !== "" ? " (threshold " + limit + ")" : "")
}

// ---- Alert context snapshots ---------------------------------------------
// What the system looked like the moment an alert fired: headline metric
// values plus the busiest processes. Persisted with the alert log, so
// keep it small — short names, rounded numbers.

function alertContext(data, psCpu, psMem) {
  var procs = []
  function add(p) {
    if (!p) return
    for (var i = 0; i < procs.length; i++) if (procs[i].pid === p.pid) return
    procs.push({
      pid: p.pid,
      n: procDisplay(p.comm).split(" ")[0].slice(0, 24),
      c: Math.round(p.cpu),
      m: Math.round(10 * p.mem) / 10
    })
  }
  for (var i = 0; i < Math.min(3, (psCpu || []).length); i++) add(psCpu[i])
  for (var j = 0; j < Math.min(2, (psMem || []).length); j++) add(psMem[j])
  return {
    cpu: Math.round(data.cpuPct || 0),
    mem: Math.round(data.memPct || 0),
    cpuTemp: isFinite(data.cpuTemp) ? Math.round(data.cpuTemp) : null,
    gpu: data.gpu && isFinite(data.gpu.busy) ? Math.round(data.gpu.busy) : null,
    gpuTemp: data.gpu && isFinite(data.gpu.celsius) ? Math.round(data.gpu.celsius) : null,
    procs: procs
  }
}

// "CPU 97% · RAM 45% · 82° · GPU 3% 46°" — the snapshot's headline.
function fmtAlertContext(ctx) {
  if (!ctx) return ""
  var parts = ["CPU " + ctx.cpu + "%", "RAM " + ctx.mem + "%"]
  if (ctx.cpuTemp !== null && ctx.cpuTemp !== undefined) parts.push(ctx.cpuTemp + "°")
  if (ctx.gpu !== null && ctx.gpu !== undefined) {
    parts.push("GPU " + ctx.gpu + "%" + (ctx.gpuTemp !== null && ctx.gpuTemp !== undefined ? " " + ctx.gpuTemp + "°" : ""))
  }
  return parts.join(" · ")
}

// One snapshot process line: "chromium · 61% · 1.3 GB".
function fmtAlertProc(p, memTotal) {
  return p.n + " · " + p.c + "% · " + fmtBytes((Number(memTotal) || 0) * p.m / 100)
}

// ---- Power (RAPL) --------------------------------------------------------
// POWER lines: "rapl|name|energy_uj|max_uj" for readable domains —
// cumulative µJ counters that wrap at max — or "rapl-restricted|name"
// when the kernel keeps energy_uj root-only (the default since the
// PLATYPUS mitigation; a udev rule opens it, see the README).

function parseRapl(lines) {
  var domains = []
  var restricted = false
  for (var i = 0; i < lines.length; i++) {
    var p = lines[i].split("|")
    if (p[0] === "rapl-restricted") { restricted = true; continue }
    if (p[0] !== "rapl" || p.length < 4) continue
    domains.push({ name: p[1], energyUj: Number(p[2]) || 0, maxUj: Number(p[3]) || 0 })
  }
  return { domains: domains, restricted: restricted }
}

// Watts per RAPL domain between two samples; counters wrap at maxUj.
function raplRates(prev, cur, elapsedSec) {
  var byName = {}
  if (prev) for (var i = 0; i < prev.length; i++) byName[prev[i].name] = prev[i]
  var result = []
  for (var j = 0; j < (cur || []).length; j++) {
    var c = cur[j]
    var p = byName[c.name]
    var watts = NaN
    if (p && elapsedSec > 0) {
      var delta = c.energyUj - p.energyUj
      if (delta < 0 && c.maxUj > 0) delta += c.maxUj
      if (delta >= 0) watts = delta / 1e6 / elapsedSec
    }
    result.push({ name: c.name, watts: watts })
  }
  return result
}

function raplLabel(name) {
  if (/^package/.test(name)) return "CPU package"
  if (name === "core") return "CPU cores"
  if (name === "uncore") return "CPU uncore"
  if (/dram/.test(name)) return "Memory (DRAM)"
  if (/psys/.test(name)) return "Platform"
  return name
}

function fmtWh(wh) {
  if (!isFinite(wh) || wh < 0.05) return ""
  return (wh >= 10 ? Math.round(wh) : wh.toFixed(1)) + " Wh"
}

// ---- Alert attribution and history markers -------------------------------

// Alerts that a top-process snapshot can plausibly explain: CPU-driven
// alerts point at the top CPU process, memory at the top memory process.
// Rates (net, io) and drive temperatures have no per-process answer
// without root, so they stay unattributed.
function attributableAlert(key) {
  return key === "cpu" || key === "cputemp" || key === "ram"
}

// "chromium 61%" / "zen-bin 1.3 GB" — the likely culprit for a fired
// alert, or "" when the alert isn't attributable or the lists are empty.
function attributionFor(key, psCpu, psMem, memTotal) {
  if ((key === "cpu" || key === "cputemp") && psCpu && psCpu.length > 0) {
    var c = psCpu[0]
    return procDisplay(c.comm).split(" ")[0] + " " + Math.round(c.cpu) + "%"
  }
  if (key === "ram" && psMem && psMem.length > 0) {
    var m = psMem[0]
    return procDisplay(m.comm).split(" ")[0] + " " + fmtBytes((Number(memTotal) || 0) * m.mem / 100)
  }
  return ""
}

// Map alert timestamps onto sparkline slots: each result is how many
// samples back from the newest (right) edge the alert fired. Alerts
// outside the visible window are dropped; duplicates collapse.
function markerIndices(times, nowMs, intervalSec, len) {
  var cap = len || HISTORY_LEN
  var step = Math.max(1, Number(intervalSec) || 1) * 1000
  var result = []
  for (var i = 0; i < (times || []).length; i++) {
    var back = Math.round((nowMs - times[i]) / step)
    if (back >= 0 && back < cap && result.indexOf(back) === -1) result.push(back)
  }
  return result
}

// The panel's watch row: the vitals Argus keeps in view on every tab,
// independent of which segments the user put in the bar. Health metrics
// only — rates and load are readings, not vitals.
var VITAL_KEYS = ["cpu", "ram", "cputemp", "gputemp", "disk", "bat"]

// Shown when no metric renders a segment (all deselected, or none of the
// selected ones has data). Without it the widget would collapse to zero
// width and the panel — the only place to re-enable metrics — would become
// unreachable from the bar. The eye of Argus, naturally.
var PLACEHOLDER_ICON = "\u{f0208}" // 󰈈

// Renderable bar segments, in the user's order: { key, text, urgent }.
// Values are width-padded so the bar doesn't shift as numbers change.
function barSegments(showKeys, data, th) {
  var segments = []
  for (var i = 0; i < showKeys.length; i++) {
    var metric = metricByKey(showKeys[i])
    if (!metric) continue
    var value = metricValue(metric.key, data, true)
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
    topProcs: topProcs,
    filterProcs: filterProcs,
    sortProcs: sortProcs,
    visibleProcs: visibleProcs,
    PROC_SORT_KEYS: PROC_SORT_KEYS,
    memBreakdown: memBreakdown,
    parseSwaps: parseSwaps,
    swapNote: swapNote,
    parseNetInfo: parseNetInfo,
    netIfaceDetail: netIfaceDetail,
    NET_KIND_ICONS: NET_KIND_ICONS,
    parseCpuTopo: parseCpuTopo,
    parseCpuFreq: parseCpuFreq,
    cpuTopoGroups: cpuTopoGroups,
    groupFreqText: groupFreqText,
    procDisplay: procDisplay,
    parseBattery: parseBattery,
    parsePsi: parsePsi,
    fmtPsi: fmtPsi,
    parseNetPhys: parseNetPhys,
    parseIntelGpus: parseIntelGpus,
    hottestDrive: hottestDrive,
    hasMotherboardSensors: hasMotherboardSensors,
    isDesktopChassis: isDesktopChassis,
    sensorKey: sensorKey,
    normalizeSensorThresholds: normalizeSensorThresholds,
    setSensorThreshold: setSensorThreshold,
    sensorThreshold: sensorThreshold,
    suggestedSensorThreshold: suggestedSensorThreshold,
    SENSOR_THRESHOLD_MIN: SENSOR_THRESHOLD_MIN,
    SENSOR_THRESHOLD_MAX: SENSOR_THRESHOLD_MAX,
    normalizeHiddenSensors: normalizeHiddenSensors,
    toggleHiddenSensor: toggleHiddenSensor,
    cpuUsage: cpuUsage,
    netRates: netRates,
    ioRates: ioRates,
    cpuTemp: cpuTemp,
    tempName: tempName,
    parseGpuPdev: parseGpuPdev,
    parseGpuProc: parseGpuProc,
    gpuProcRates: gpuProcRates,
    parseDriveHealth: parseDriveHealth,
    driveHealthBad: driveHealthBad,
    gpuMemUsed: gpuMemUsed,
    gpuMemTotal: gpuMemTotal,
    fmtDriveHealth: fmtDriveHealth,
    tempDeviceTitle: tempDeviceTitle,
    groupTemps: groupTemps,
    sensorRowLabel: sensorRowLabel,
    padValue: padValue,
    prettyGpuName: prettyGpuName,
    parseNvidia: parseNvidia,
    markGpuAsleep: markGpuAsleep,
    primaryGpu: primaryGpu,
    primaryFirstGpus: primaryFirstGpus,
    diskFor: diskFor,
    batterySummary: batterySummary,
    batteryIcon: batteryIcon,
    pushHistory: pushHistory,
    HOUR_SLOT_SEC: HOUR_SLOT_SEC,
    DAY_SLOT_SEC: DAY_SLOT_SEC,
    HOUR_KEYS: HOUR_KEYS,
    SPANS: SPANS,
    nextSpan: nextSpan,
    spanSlotSec: spanSlotSec,
    emptyHourHist: emptyHourHist,
    pushHourHist: pushHourHist,
    hourValues: hourValues,
    HISTORY_FILE_VERSION: HISTORY_FILE_VERSION,
    ALERT_LOG_CAP: ALERT_LOG_CAP,
    serializeHistory: serializeHistory,
    resumeHist: resumeHist,
    restoreHistory: restoreHistory,
    alertContext: alertContext,
    fmtAlertContext: fmtAlertContext,
    sensorAlertRows: sensorAlertRows,
    HOME_TILES: HOME_TILES,
    DEFAULT_HOME: DEFAULT_HOME,
    homeTileByKey: homeTileByKey,
    normalizeHomeTiles: normalizeHomeTiles,
    toggleHomeTile: toggleHomeTile,
    sumHist: sumHist,
    fmtAlertProc: fmtAlertProc,
    parseRapl: parseRapl,
    raplRates: raplRates,
    raplLabel: raplLabel,
    fmtWh: fmtWh,
    fmtBytes: fmtBytes,
    fmtRateShort: fmtRateShort,
    fmtUptime: fmtUptime,
    fmtPct: fmtPct,
    fmtTemp: fmtTemp,
    setTempUnit: setTempUnit,
    displayTemp: displayTemp,
    tempSuffix: tempSuffix,
    MANGO_METRICS: MANGO_METRICS,
    MANGO_POSITIONS: MANGO_POSITIONS,
    DEFAULT_MANGO_METRICS: DEFAULT_MANGO_METRICS,
    mangoMetricByKey: mangoMetricByKey,
    cleanMangoValue: cleanMangoValue,
    mangoColor: mangoColor,
    normalizeMango: normalizeMango,
    toggleMangoMetric: toggleMangoMetric,
    mangohudConfig: mangohudConfig,
    MANGO_FPS_LIMITS: MANGO_FPS_LIMITS,
    stepFpsLimit: stepFpsLimit,
    fmtWatts: fmtWatts,
    metricValue: metricValue,
    metricUrgent: metricUrgent,
    ALERT_KEYS: ALERT_KEYS,
    ALERT_SETTINGS: ALERT_SETTINGS,
    alertSettingByKey: alertSettingByKey,
    normalizeAlertsOn: normalizeAlertsOn,
    toggleAlertOn: toggleAlertOn,
    stepAlertThreshold: stepAlertThreshold,
    alertLimitText: alertLimitText,
    alertNowText: alertNowText,
    VITAL_KEYS: VITAL_KEYS,
    alertText: alertText,
    attributableAlert: attributableAlert,
    attributionFor: attributionFor,
    markerIndices: markerIndices,
    barSegments: barSegments,
    barText: barText,
    barLines: barLines,
    PLACEHOLDER_ICON: PLACEHOLDER_ICON
  }
}
