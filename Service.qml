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
    if (!healthProc.running) healthProc.running = true
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

  // Per-process GPU usage (panel-only samples, like the process lists).
  // Engine counters are cumulative, so rates use the wall clock between
  // the two GPU snapshots — panel-closed gaps would otherwise inflate the
  // first reopened tick.
  property var gpuPdev: ({})
  property var gpuProcs: []
  property var _prevGpuProc: null
  property double _prevGpuProcAt: 0

  // Drive SMART health via udisks2; sampled at startup and panel open.
  property var driveHealth: []
  property var _healthNotified: ({})

  // Rolling per-tick history for the panel sparklines (Model.HISTORY_LEN
  // points, oldest first). Populated only from valid delta ticks.
  property var cpuHist: []
  property var memHist: []
  property var gpuHist: []
  property var netDownHist: []
  property var netUpHist: []
  property var ioReadHist: []
  property var ioWriteHist: []

  // Hour-scale rings behind the fine ones: one peak per minute, all
  // series in one object (see Model.pushHourHist).
  property var hourHist: Model.emptyHourHist()

  // The last few fired alerts, newest first: { at: epoch ms, key, text }.
  // Notifications vanish; this answers "did anything trip while I was
  // away?" from the panel. `key` lets the sparklines mark when an alert
  // fired on their series.
  property var alertLog: []

  // Wall-clock time of the newest applied sample — the right edge of every
  // sparkline, used to place alert markers.
  property double lastTickAt: 0

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

  // Argus's own cost, measured rather than promised: wall clock from
  // launching sample.sh to the parsed values being applied. Shown in the
  // BAR tab so the monitor's overhead is never a matter of trust.
  property double _sampleStartedAt: 0
  property double lastSampleMs: 0
  property double avgSampleMs: 0

  function refresh() {
    if (_staticText === "") {
      if (!staticProc.running) staticProc.running = true
      return
    }
    if (!proc.running) {
      _sampleStartedAt = Date.now()
      proc.running = true
    }
  }

  function apply(text) {
    var now = Date.now()
    var parsed = Model.parseSample(_staticText + "\n" + text)
    if (parsed.cpus.length === 0) return
    var hadPrev = _prevCpus !== null

    if (_sampleStartedAt > 0) {
      lastSampleMs = now - _sampleStartedAt
      avgSampleMs = avgSampleMs > 0 ? avgSampleMs * 0.9 + lastSampleMs * 0.1 : lastSampleMs
    }

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
    gpuPdev = parsed.gpuPdev
    if (parsed.gpuProcs.length > 0) {
      var gpuElapsed = _prevGpuProcAt > 0 ? (now - _prevGpuProcAt) / 1000 : 0
      gpuProcs = Model.gpuProcRates(_prevGpuProc, parsed.gpuProcs, gpuElapsed)
      _prevGpuProc = parsed.gpuProcs
      _prevGpuProcAt = now
    }
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
      ioReadHist = Model.pushHistory(ioReadHist, ioRead)
      ioWriteHist = Model.pushHistory(ioWriteHist, ioWrite)
      hourHist = Model.pushHourHist(hourHist, {
        cpu: cpuPct, mem: memPct, gpu: primaryGpu ? primaryGpu.busy : 0,
        netDown: netDown, netUp: netUp, ioRead: ioRead, ioWrite: ioWrite
      }, now)
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
    lastTickAt = now
    sample = parsed
    ready = _prevCpus !== null && corePcts.length > 0

    if (ready && hadPrev) checkAlerts(now)
  }

  // ---- Threshold alerts ----------------------------------------------
  // Alerts are per-metric opt-in: only keys in the user's `alertsOn` list
  // (BAR tab toggles; empty by default) are watched. When an enabled
  // metric stays past its threshold for alertHoldTicks consecutive ticks,
  // send one desktop notification, then stay quiet for the cooldown.
  // Temperatures and battery are critical; the rest normal. The `alerts`
  // setting remains a master switch over everything, including the
  // per-sensor TEMP-tab thresholds.
  readonly property bool alertsEnabled: !settings || settings.alerts !== "Off"
  readonly property var enabledAlerts: Model.normalizeAlertsOn(settings ? settings.alertsOn : null)
  readonly property int alertHoldTicks: 3
  readonly property int alertCooldownMs: 300000

  property var _alertStreak: ({})
  property var _alertNotifiedAt: ({})

  // Per-sensor thresholds the user set in the TEMP tab.
  readonly property var sensorThresholds: Model.normalizeSensorThresholds(settings ? settings.sensorThresholds : null)

  // Whether this key's streak just crossed the hold threshold and is out
  // of cooldown — the moment an alert fires.
  function _fired(streakKey, urgent, now) {
    var streak = urgent ? (_alertStreak[streakKey] || 0) + 1 : 0
    _alertStreak[streakKey] = streak
    if (streak !== alertHoldTicks) return false
    if (now - (_alertNotifiedAt[streakKey] || 0) < alertCooldownMs) return false
    _alertNotifiedAt[streakKey] = now
    return true
  }

  function checkAlerts(now) {
    if (!alertsEnabled) return
    var th = Model.thresholdsFrom(settings)
    var data = barData
    var pending = []
    for (var i = 0; i < Model.ALERT_KEYS.length; i++) {
      var key = Model.ALERT_KEYS[i]
      // Off-by-default: a disabled metric accumulates no streak, so
      // toggling it on mid-breach still takes the full hold to fire.
      if (enabledAlerts.indexOf(key) === -1) continue
      if (!_fired(key, Model.metricUrgent(key, data, th), now)) continue
      var critical = key === "cputemp" || key === "gputemp" || key === "drivetemp" || key === "bat"
      pending.push({ at: now, key: key, critical: critical, text: Model.alertText(key, data, th) })
    }
    // User-set per-sensor thresholds, each with its own streak/cooldown.
    for (var t = 0; t < temps.length; t++) {
      var temp = temps[t]
      var limit = Model.sensorThreshold(sensorThresholds, temp)
      if (!isFinite(limit)) continue
      if (!_fired("sensor:" + Model.sensorKey(temp), temp.celsius >= limit, now)) continue
      pending.push({ at: now, key: "sensor:" + Model.sensorKey(temp), critical: true,
        text: Model.tempName(temp) + " at " + Model.fmtTemp(temp.celsius) + " (threshold " + limit + "°)" })
    }
    _dispatchAlerts(pending)
  }

  // ---- Alert attribution ----------------------------------------------
  // CPU and memory alerts name their likely culprit ("— chromium 61%").
  // The panel-open tick already carries fresh process lists; otherwise a
  // one-shot `sample.sh ps` fetches them, and a short timeout emits the
  // alert unattributed rather than never.
  property var _pendingAlerts: []

  function _dispatchAlerts(pending) {
    if (pending.length === 0) return
    var needsPs = false
    for (var i = 0; i < pending.length; i++) {
      if (Model.attributableAlert(pending[i].key)) needsPs = true
    }
    if (!needsPs || panelActive) {
      _emitAlerts(pending, psCpu, psMem)
      return
    }
    _pendingAlerts = _pendingAlerts.concat(pending)
    if (!psProc.running) psProc.running = true
    psTimeout.restart()
  }

  function _flushPendingAlerts(cpuList, memList) {
    var pending = _pendingAlerts
    _pendingAlerts = []
    _emitAlerts(pending, cpuList, memList)
  }

  function _emitAlerts(pending, cpuList, memList) {
    for (var i = 0; i < pending.length; i++) {
      var a = pending[i]
      var attribution = Model.attributionFor(a.key, cpuList, memList, memTotal)
      _deliverAlert(a.at, a.key, a.critical, a.text + (attribution !== "" ? " — " + attribution : ""))
    }
  }

  // The user's alert hook: a shell command run on every fired alert, with
  // the alert's details in ARGUS_ALERT_* environment variables. One
  // setting turns alerts into automation (log to a file, push to a
  // phone, page a webhook).
  readonly property string alertCommand: settings && typeof settings.alertCommand === "string"
    ? settings.alertCommand : ""

  // Every fired alert flows through here: log entry, notification, hook.
  function _deliverAlert(at, key, critical, text) {
    alertLog = [{ at: at, key: key, text: text }].concat(alertLog).slice(0, 10)
    Quickshell.execDetached([
      "notify-send", "-a", "Argus", "-u", critical ? "critical" : "normal",
      "Argus", text
    ])
    if (alertCommand !== "") {
      Quickshell.execDetached([
        "env",
        "ARGUS_ALERT_KEY=" + key,
        "ARGUS_ALERT_TEXT=" + text,
        "ARGUS_ALERT_CRITICAL=" + (critical ? "1" : "0"),
        "ARGUS_ALERT_AT=" + String(at),
        "sh", "-c", alertCommand
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
        // First drive-health sample once identity is in; a failing drive
        // should be surfaced without waiting for a panel open.
        if (!healthProc.running) healthProc.running = true
      }
    }
  }

  // Drive SMART health via udisks2 (sample.sh health). Wear moves in
  // weeks, so this runs at startup and panel open, not per tick. With the
  // drivehealth alert enabled, a drive that turns bad notifies once per
  // shell session; the DISK tab renders it urgent either way.
  Process {
    id: healthProc
    command: ["bash", root.scriptPath, "health"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var parsed = Model.parseSample(text)
        root.driveHealth = parsed.driveHealth
        if (!root.alertsEnabled || root.enabledAlerts.indexOf("drivehealth") === -1) return
        var wearPct = Model.thresholdsFrom(root.settings).wearPct
        for (var i = 0; i < parsed.driveHealth.length; i++) {
          var d = parsed.driveHealth[i]
          if (!Model.driveHealthBad(d, wearPct) || root._healthNotified[d.dev]) continue
          root._healthNotified[d.dev] = true
          var message = "Drive health: " + (d.model !== "" ? d.model + " (" + d.dev + ")" : d.dev)
            + " — " + Model.fmtDriveHealth(d)
          root._deliverAlert(Date.now(), "drivehealth", true, message)
        }
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

  // One-shot top-process sample for alert attribution while no panel is
  // open. The snapshot also refreshes the PROC tab's kept-last lists.
  Process {
    id: psProc
    command: ["bash", root.scriptPath, "ps"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        psTimeout.stop()
        var parsed = Model.parseSample(text)
        if (parsed.psCpu.length > 0) root.psCpu = parsed.psCpu
        if (parsed.psMem.length > 0) root.psMem = parsed.psMem
        root._flushPendingAlerts(parsed.psCpu, parsed.psMem)
      }
    }
  }

  // If the attribution sample hangs, emit the alerts unattributed rather
  // than never.
  Timer {
    id: psTimeout
    interval: 2000
    onTriggered: root._flushPendingAlerts([], [])
  }
}
