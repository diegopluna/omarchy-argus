import QtQuick
import Quickshell.Io
import "Model.js" as Model

// Polls sample.sh on a timer and exposes parsed, delta-derived system data.
// One instance runs per bar surface; the sampler is a single short-lived
// bash process per tick.
Item {
  id: root

  property var settings: ({})

  readonly property int intervalSec: {
    var value = Number(settings && settings.intervalSec)
    return isFinite(value) && value >= 1 ? Math.min(60, Math.round(value)) : 2
  }

  // Raw parsed sample plus previous tick for delta metrics.
  property var sample: null
  property var _prevCpus: null
  property var _prevNet: null
  property double _prevTime: 0

  // Derived state the UI binds to.
  property string host: ""
  property string cpuName: ""
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
  property var gpus: []
  property var primaryGpu: null
  property real netDown: 0
  property real netUp: 0
  property var netIfaces: []
  property bool ready: false

  readonly property real memPct: memTotal > 0 ? 100 * memUsed / memTotal : 0
  readonly property real swapPct: swapTotal > 0 ? 100 * swapUsed / swapTotal : 0

  readonly property string scriptPath: Qt.resolvedUrl("sample.sh").toString().replace(/^file:\/\//, "")

  function refresh() {
    if (!proc.running) proc.running = true
  }

  function apply(text) {
    var now = Date.now()
    var parsed = Model.parseSample(text)
    if (parsed.cpus.length === 0) return

    var usage = Model.cpuUsage(_prevCpus, parsed.cpus)
    var cores = []
    for (var i = 0; i < usage.length; i++) {
      if (usage[i].id === "cpu") cpuPct = usage[i].pct
      else cores.push(usage[i].pct)
    }
    corePcts = cores

    var rates = Model.netRates(_prevNet, parsed.net, (_prevTime > 0 ? (now - _prevTime) : 0) / 1000)
    netDown = rates.down
    netUp = rates.up
    netIfaces = rates.perIface

    host = parsed.host
    cpuName = parsed.cpuName
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
    gpus = parsed.gpus
    primaryGpu = Model.primaryGpu(parsed.gpus)
    cpuTempC = Model.cpuTemp(parsed.temps)

    _prevCpus = parsed.cpus
    _prevNet = parsed.net
    _prevTime = now
    sample = parsed
    ready = _prevCpus !== null && corePcts.length > 0
  }

  // Everything metricValue/barText need, bundled once per bind.
  readonly property var barData: ({
    cpuPct: cpuPct,
    cpuTemp: cpuTempC,
    memPct: memPct,
    gpu: primaryGpu,
    disk: Model.diskFor(disks, settings && settings.diskMount ? String(settings.diskMount) : "/"),
    netDown: netDown,
    netUp: netUp,
    load1: load1
  })

  Timer {
    interval: root.intervalSec * 1000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Process {
    id: proc
    command: ["bash", root.scriptPath]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.apply(text)
    }
  }
}
