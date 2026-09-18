pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Shared state for every bar surface: the Monitor that samples this
// machine, and the in-game HUD config. A singleton so multi-monitor setups
// run ONE sampler regardless of how many bar surfaces show the widget;
// every surface binds to the same instance. The Monitor's data properties
// are forwarded under their own names, so the widget reads Service.cpuPct
// and friends as before.
Singleton {
  id: root

  // Pushed by each widget instance; all surfaces share one shell.json
  // entry so the values are identical.
  property var settings: ({})
  onSettingsChanged: Model.setTempUnit(settings ? settings.tempUnit : "C")

  // The tab the panel was last on; reopening lands there (session-scoped
  // — persisting it would write shell.json on every tab switch).
  property string lastTab: "HOME"

  readonly property int intervalSec: monitor.intervalSec

  // How many panels are currently open across all bar surfaces.
  property int _panelRefs: 0
  readonly property bool panelActive: _panelRefs > 0

  function panelOpened() { _panelRefs++ }
  function panelClosed() { _panelRefs = Math.max(0, _panelRefs - 1) }

  Monitor {
    id: monitor
    settings: root.settings
    lastTab: root.lastTab
    panelActive: root.panelActive
  }

  function refresh(force) { monitor.refresh(force) }

  // The MangoHud config lives beside the flight recorder.
  readonly property string stateDir: monitor.stateDir

  readonly property string host: monitor.host
  readonly property string cpuName: monitor.cpuName
  readonly property string kernel: monitor.kernel
  readonly property int chassisType: monitor.chassisType
  readonly property var psi: monitor.psi
  readonly property var driveTemp: monitor.driveTemp
  readonly property real cpuPct: monitor.cpuPct
  readonly property var corePcts: monitor.corePcts
  readonly property real cpuMhz: monitor.cpuMhz
  readonly property real cpuTempC: monitor.cpuTempC
  readonly property real load1: monitor.load1
  readonly property real load5: monitor.load5
  readonly property real load15: monitor.load15
  readonly property real uptimeSec: monitor.uptimeSec
  readonly property real memTotal: monitor.memTotal
  readonly property real memUsed: monitor.memUsed
  readonly property real swapTotal: monitor.swapTotal
  readonly property real swapUsed: monitor.swapUsed
  readonly property var disks: monitor.disks
  readonly property var temps: monitor.temps
  readonly property var fans: monitor.fans
  readonly property var gpus: monitor.gpus
  readonly property var primaryGpu: monitor.primaryGpu
  readonly property bool nvidiaSuspended: monitor.nvidiaSuspended
  readonly property real netDown: monitor.netDown
  readonly property real netUp: monitor.netUp
  readonly property var netIfaces: monitor.netIfaces
  readonly property real ioRead: monitor.ioRead
  readonly property real ioWrite: monitor.ioWrite
  readonly property var ioDisks: monitor.ioDisks
  readonly property var psAll: monitor.psAll
  readonly property var netInfo: monitor.netInfo
  readonly property var memInfo: monitor.memInfo
  readonly property var swaps: monitor.swaps
  readonly property var cpuTopo: monitor.cpuTopo
  readonly property var cpuFreq: monitor.cpuFreq
  readonly property var batteries: monitor.batteries
  readonly property var battery: monitor.battery
  readonly property bool ready: monitor.ready
  readonly property var gpuPdev: monitor.gpuPdev
  readonly property var gpuProcs: monitor.gpuProcs
  readonly property var driveHealth: monitor.driveHealth
  readonly property var cpuHist: monitor.cpuHist
  readonly property var memHist: monitor.memHist
  readonly property var gpuHist: monitor.gpuHist
  readonly property var netDownHist: monitor.netDownHist
  readonly property var netUpHist: monitor.netUpHist
  readonly property var ioReadHist: monitor.ioReadHist
  readonly property var ioWriteHist: monitor.ioWriteHist
  readonly property var hourHist: monitor.hourHist
  readonly property var dayHist: monitor.dayHist
  readonly property var raplWatts: monitor.raplWatts
  readonly property bool raplRestricted: monitor.raplRestricted
  readonly property real cpuEnergyWh: monitor.cpuEnergyWh
  readonly property real gpuEnergyWh: monitor.gpuEnergyWh
  readonly property var cpuPowerHist: monitor.cpuPowerHist
  readonly property var gpuPowerHist: monitor.gpuPowerHist
  readonly property var cpuTempHist: monitor.cpuTempHist
  readonly property real peakCpuPower: monitor.peakCpuPower
  readonly property real peakGpuPower: monitor.peakGpuPower
  readonly property var alertLog: monitor.alertLog
  readonly property double lastTickAt: monitor.lastTickAt
  readonly property real peakCpuTemp: monitor.peakCpuTemp
  readonly property real peakGpuTemp: monitor.peakGpuTemp
  readonly property real peakNetDown: monitor.peakNetDown
  readonly property real peakNetUp: monitor.peakNetUp
  readonly property real peakIoRead: monitor.peakIoRead
  readonly property real peakIoWrite: monitor.peakIoWrite
  readonly property real memPct: monitor.memPct
  readonly property real swapPct: monitor.swapPct
  readonly property double lastSampleMs: monitor.lastSampleMs
  readonly property double avgSampleMs: monitor.avgSampleMs
  readonly property var sensorThresholds: monitor.sensorThresholds
  readonly property var barData: monitor.barData
  readonly property string historyPath: monitor.historyPath


  // ---- In-game HUD (MangoHud) -----------------------------------------
  // Argus owns a dedicated config file (never the user's MangoHud.conf)
  // and re-renders it whenever the GAME-tab settings or the shell theme
  // change; `mangohudctl reload-cfg` restyles any running game live.
  readonly property var mango: Model.normalizeMango(settings ? settings.mangoHud : null)
  readonly property string mangoConfPath: stateDir + "/mangohud.conf"
  property bool mangohudInstalled: false
  // Setup model: only MANGOHUD_CONFIGFILE is session-global; activation
  // (MANGOHUD=1) is per-game, because the Vulkan layer loads into EVERY
  // Vulkan process — a global MANGOHUD=1 crashed the shell itself
  // (libMangoHud segfault in quickshell's vkCreateDevice). The session
  // env is the proxy for whether the config path reaches games.
  readonly property bool mangoInjectionReady:
    Quickshell.env("MANGOHUD_CONFIGFILE") === mangoConfPath

  readonly property string mangoConf: Model.mangohudConfig(mango, {
    text: Model.mangoColor(Color.foreground),
    background: Model.mangoColor(Color.background),
    accent: Model.mangoColor(Color.accent),
    urgent: Model.mangoColor(Color.bar.active)
  })

  onMangoConfChanged: _writeMangoConf()

  function _writeMangoConf() {
    Quickshell.execDetached(["bash", "-c",
      'mkdir -p "$1" && printf %s "$2" > "$1/.mangohud.tmp" && mv "$1/.mangohud.tmp" "$1/mangohud.conf"; command -v mangohudctl >/dev/null && mangohudctl reload-cfg',
      "argus-mangohud", stateDir, mangoConf])
  }

  // mpv doubles as the GAME tab's HUD preview canvas.
  property bool mpvInstalled: false

  Process {
    id: mangoCheckProc
    command: ["sh", "-c", "command -v mangohud >/dev/null && echo mango; command -v mpv >/dev/null && echo mpv"]
    running: true
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.mangohudInstalled = text.indexOf("mango") !== -1
        root.mpvInstalled = text.indexOf("mpv") !== -1
      }
    }
  }
}
