pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Shared system-monitor state: polls sample.sh on a timer and exposes
// parsed, delta-derived data. A singleton so multi-monitor setups run ONE
// sampler regardless of how many bar surfaces show the widget; every
// surface binds to the same instance. Hardware identity (hostname, CPU
// model, disk models, GPU names) is sampled once at startup via
// `sample.sh static` and merged into every dynamic tick, so lsblk/lspci
// never run on the hot path. Panel-only data (top processes) is sampled
// only while at least one panel is open.
Singleton {
  id: root

  // Pushed by each widget instance; all surfaces share one shell.json
  // entry so the values are identical.
  property var settings: ({})

  readonly property int intervalSec: {
    var value = Number(settings && settings.intervalSec)
    return isFinite(value) && value >= 1 ? Math.min(60, Math.round(value)) : 2
  }

  // How many panels are currently open across all bar surfaces.
  property int _panelRefs: 0
  readonly property bool panelActive: _panelRefs > 0

  function panelOpened() {
    _panelRefs++
    refresh()
  }

  function panelClosed() {
    _panelRefs = Math.max(0, _panelRefs - 1)
  }

  // Raw parsed sample plus previous tick for delta metrics.
  property var sample: null
  property string _staticText: ""
  property var _prevCpus: null
  property var _prevNet: null
  property var _prevIo: null
  property double _prevTime: 0
  // Last awake NVIDIA readings, replayed as "asleep" while the card is
  // runtime-suspended and the sampler refuses to wake it.
  property var _lastNvidia: []

  // Derived state the UI binds to.
  property string host: ""
  property string cpuName: ""
  property string kernel: ""
  property int chassisType: 0
  property var psi: ({})
  property var driveTemp: null
  property real cpuPct: 0
  property var corePcts: []
  property real cpuMhz: 0
  property real cpuTempC: NaN
  property real load1: 0
  property real load5: 0
  property real load15: 0
  property real uptimeSec: 0
  property real memTotal: 0
  property real memUsed: 0
  property real swapTotal: 0
  property real swapUsed: 0
  property var disks: []
  property var temps: []
  property var fans: []
  property var gpus: []
  property var primaryGpu: null
  property bool nvidiaSuspended: false
  property real netDown: 0
  property real netUp: 0
  property var netIfaces: []
  property real ioRead: 0
  property real ioWrite: 0
  property var ioDisks: []
  property var psCpu: []
  property var psMem: []
  property var batteries: []
  property var battery: null
  property bool ready: false

  // Rolling per-tick history for the panel sparklines (Model.HISTORY_LEN
  // points, oldest first). Populated only from valid delta ticks.
  property var cpuHist: []
  property var memHist: []
  property var gpuHist: []
  property var netDownHist: []
  property var netUpHist: []

  // Highest values observed since the shell started.
  property real peakCpuTemp: NaN
  property real peakGpuTemp: NaN
  property real peakNetDown: 0
  property real peakNetUp: 0
  property real peakIoRead: 0
  property real peakIoWrite: 0

  readonly property real memPct: memTotal > 0 ? 100 * memUsed / memTotal : 0
  readonly property real swapPct: swapTotal > 0 ? 100 * swapUsed / swapTotal : 0

  readonly property string scriptPath: Qt.resolvedUrl("sample.sh").toString().replace(/^file:\/\//, "")

  function refresh() {
    if (_staticText === "") {
      if (!staticProc.running) staticProc.running = true
      return
    }
    if (!proc.running) proc.running = true
  }

  function apply(text) {
    var now = Date.now()
    var parsed = Model.parseSample(_staticText + "\n" + text)
    if (parsed.cpus.length === 0) return
    var hadPrev = _prevCpus !== null

    var usage = Model.cpuUsage(_prevCpus, parsed.cpus)
    var cores = []
    for (var i = 0; i < usage.length; i++) {
      if (usage[i].id === "cpu") cpuPct = usage[i].pct
      else cores.push(usage[i].pct)
    }
    corePcts = cores

    var elapsedSec = (_prevTime > 0 ? (now - _prevTime) : 0) / 1000
    var rates = Model.netRates(_prevNet, parsed.net, elapsedSec, parsed.netPhys)
    netDown = rates.down
    netUp = rates.up
    netIfaces = rates.perIface

    var io = Model.ioRates(_prevIo, parsed.io, elapsedSec, parsed.diskModels, parsed.diskLinks)
    ioRead = io.read
    ioWrite = io.write
    ioDisks = io.perDisk

    host = parsed.host
    cpuName = parsed.cpuName
    kernel = parsed.kernel
    chassisType = parsed.chassisType
    psi = parsed.psi
    driveTemp = Model.hottestDrive(parsed.temps)
    cpuMhz = parsed.load.cpuMhz
    load1 = parsed.load.load1
    load5 = parsed.load.load5
    load15 = parsed.load.load15
    uptimeSec = parsed.load.uptimeSec
    memTotal = parsed.mem.total
    memUsed = parsed.mem.total - parsed.mem.avail
    swapTotal = parsed.mem.swapTotal
    swapUsed = parsed.mem.swapTotal - parsed.mem.swapFree
    disks = parsed.disks
    temps = parsed.temps
    fans = parsed.fans
    // Process lists are panel-only samples; keep the last snapshot while
    // the panel is closed instead of blanking the PROC tab.
    if (parsed.psCpu.length > 0) psCpu = parsed.psCpu
    if (parsed.psMem.length > 0) psMem = parsed.psMem
    batteries = parsed.batteries
    battery = Model.batterySummary(parsed.batteries)
    nvidiaSuspended = parsed.nvidiaSuspended

    var allGpus = parsed.gpus
    if (parsed.nvidiaSuspended) {
      for (var n = 0; n < _lastNvidia.length; n++) allGpus = allGpus.concat([Model.markGpuAsleep(_lastNvidia[n])])
    } else {
      var nvidia = []
      for (var g = 0; g < allGpus.length; g++) {
        if (String(allGpus[g].card).indexOf("nv") === 0) nvidia.push(allGpus[g])
      }
      _lastNvidia = nvidia
    }
    gpus = allGpus
    primaryGpu = Model.primaryGpu(allGpus)
    cpuTempC = Model.cpuTemp(parsed.temps)

    if (hadPrev) {
      cpuHist = Model.pushHistory(cpuHist, cpuPct)
      memHist = Model.pushHistory(memHist, memPct)
      gpuHist = Model.pushHistory(gpuHist, primaryGpu ? primaryGpu.busy : 0)
      netDownHist = Model.pushHistory(netDownHist, netDown)
      netUpHist = Model.pushHistory(netUpHist, netUp)
      if (netDown > peakNetDown) peakNetDown = netDown
      if (netUp > peakNetUp) peakNetUp = netUp
      if (ioRead > peakIoRead) peakIoRead = ioRead
      if (ioWrite > peakIoWrite) peakIoWrite = ioWrite
    }
    if (isFinite(cpuTempC) && !(cpuTempC <= peakCpuTemp)) peakCpuTemp = cpuTempC
    if (primaryGpu && isFinite(primaryGpu.celsius) && !(primaryGpu.celsius <= peakGpuTemp)) peakGpuTemp = primaryGpu.celsius

    _prevCpus = parsed.cpus
    _prevNet = parsed.net
    _prevIo = parsed.io
    _prevTime = now
    sample = parsed
    ready = _prevCpus !== null && corePcts.length > 0

    if (ready && hadPrev) checkAlerts(now)
  }

  // ---- Threshold alerts ----------------------------------------------
  // When a metric stays past its threshold for alertHoldTicks consecutive
  // ticks, send one desktop notification, then stay quiet for the
  // cooldown. Temperatures and battery are critical; the rest normal.
  readonly property bool alertsEnabled: !settings || settings.alerts !== "Off"
  readonly property int alertHoldTicks: 3
  readonly property int alertCooldownMs: 300000

  property var _alertStreak: ({})
  property var _alertNotifiedAt: ({})

  function checkAlerts(now) {
    if (!alertsEnabled) return
    var th = Model.thresholdsFrom(settings)
    var data = barData
    for (var i = 0; i < Model.ALERT_KEYS.length; i++) {
      var key = Model.ALERT_KEYS[i]
      var streak = Model.metricUrgent(key, data, th) ? (_alertStreak[key] || 0) + 1 : 0
      _alertStreak[key] = streak
      if (streak !== alertHoldTicks) continue
      if (now - (_alertNotifiedAt[key] || 0) < alertCooldownMs) continue
      _alertNotifiedAt[key] = now
      var critical = key === "cputemp" || key === "gputemp" || key === "drivetemp" || key === "bat"
      Quickshell.execDetached([
        "notify-send", "-a", "Argus", "-u", critical ? "critical" : "normal",
        "Argus", Model.alertText(key, data, th)
      ])
    }
  }

  // Everything metricValue/barText need, bundled once per bind.
  readonly property var barData: ({
    cpuPct: cpuPct,
    cpuTemp: cpuTempC,
    memPct: memPct,
    gpu: primaryGpu,
    disk: Model.diskFor(disks, settings && settings.diskMount ? String(settings.diskMount) : "/"),
    io: { read: ioRead, write: ioWrite },
    netDown: netDown,
    netUp: netUp,
    load1: load1,
    cores: corePcts.length,
    battery: battery,
    driveTemp: driveTemp
  })

  Timer {
    interval: root.intervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: staticProc
    command: ["bash", root.scriptPath, "static"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root._staticText = text
        root.refresh()
      }
    }
  }

  Process {
    id: proc
    command: root.panelActive
      ? ["bash", root.scriptPath, "dynamic", "panel"]
      : ["bash", root.scriptPath, "dynamic"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.apply(text)
    }
  }
}
