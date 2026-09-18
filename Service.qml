pragma Singleton
import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

// Shared state for every bar surface: a Monitor for this machine, one per
// SSH device, and the in-game HUD config. A singleton so multi-monitor
// setups run ONE sampler per machine regardless of how many bar surfaces
// show the widget; every surface binds to the same instance.
//
// The bar always shows this machine (`local`, via localReady and
// localBarData). The panel shows the selected machine (`view`): its data
// properties are forwarded below under their own names, so every tab reads
// Service.cpuPct and friends whichever machine is selected.
Singleton {
  id: root

  // Pushed by each widget instance; all surfaces share one shell.json
  // entry so the values are identical.
  property var settings: ({})
  onSettingsChanged: Model.setTempUnit(settings ? settings.tempUnit : "C")

  // The tab the panel was last on; reopening lands there (session-scoped
  // — persisting it would write shell.json on every tab switch).
  property string lastTab: "HOME"

  readonly property int intervalSec: local.intervalSec

  // How many panels are currently open across all bar surfaces.
  property int _panelRefs: 0
  readonly property bool panelActive: _panelRefs > 0

  function panelOpened() { _panelRefs++ }
  function panelClosed() { _panelRefs = Math.max(0, _panelRefs - 1) }

  // ---- Machines ---------------------------------------------------------
  Monitor {
    id: local
    hostId: "local"
    label: root.settings && root.settings.localName ? String(root.settings.localName)
      : (host !== "" ? host : "This machine")
    settings: root.settings
    lastTab: root.lastTab
    panelActive: root.panelActive && root.view === local
  }

  // SSH devices from shell.json (`devices`, edited in the SETUP tab).
  readonly property var devices: Model.normalizeDevices(settings ? settings.devices : null)
  // The Variants model: device destinations, reassigned only when the set
  // actually changes. Every settings write (a threshold, the temperature
  // unit) produces a fresh list, and Variants rebuilds its instances on a
  // new model — which would drop each device's deltas and history.
  property var _deviceTargets: []
  onDevicesChanged: {
    var next = devices.map(function(d) { return d.ssh })
    if (next.join("\n") !== _deviceTargets.join("\n")) _deviceTargets = next
  }

  function deviceName(ssh) {
    for (var i = 0; i < devices.length; i++) {
      if (devices[i].ssh === ssh && devices[i].name !== "") return devices[i].name
    }
    return ""
  }

  Variants {
    id: deviceMonitors
    model: root._deviceTargets

    Monitor {
      id: device
      required property var modelData
      sshTarget: String(modelData)
      hostId: "ssh:" + sshTarget
      label: root.deviceName(sshTarget) || (host !== "" ? host : sshTarget)
      settings: root.settings
      lastTab: root.lastTab
      panelActive: root.panelActive && root.view === device
    }
  }

  // This machine first, then devices in the order they were added.
  readonly property var hosts: {
    var list = [local]
    var instances = deviceMonitors.instances
    for (var i = 0; i < _deviceTargets.length; i++) {
      for (var j = 0; j < instances.length; j++) {
        if (instances[j].sshTarget === _deviceTargets[i]) list.push(instances[j])
      }
    }
    return list
  }

  // Session-scoped like lastTab. A removed device falls back to local.
  property string selectedHostId: "local"
  readonly property var view: {
    for (var i = 0; i < hosts.length; i++) if (hosts[i].hostId === selectedHostId) return hosts[i]
    return local
  }
  readonly property int hostIndex: Math.max(0, hosts.indexOf(view))

  function selectHost(index) {
    var wrapped = ((index % hosts.length) + hosts.length) % hosts.length
    selectedHostId = hosts[wrapped].hostId
  }

  // IPC: "local", "next", "prev", or a device's ssh destination or name.
  function selectHostNamed(name) {
    if (name === "next" || name === "prev") {
      selectHost(hostIndex + (name === "next" ? 1 : -1))
      return true
    }
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i]
      if (h.hostId === name || h.sshTarget === name || h.label === name) {
        selectedHostId = h.hostId
        return true
      }
    }
    return false
  }

  // The bar's segments and tooltip: always this machine.
  readonly property var localMonitor: local
  readonly property bool localReady: local.ready
  readonly property var localBarData: local.barData

  readonly property bool viewRemote: view.remote
  readonly property bool viewReachable: view.reachable

  function refresh(force) { view.refresh(force) }

  // A PROC-tab process belongs to the machine on screen; a device's is
  // signalled over the same multiplexed connection the sampler uses.
  function killProcess(pid, sig) {
    var signal = "-" + (sig === "KILL" ? "KILL" : "TERM")
    var pidText = String(parseInt(pid, 10))
    if (!view.remote) {
      Quickshell.execDetached(["kill", signal, pidText])
      return
    }
    Quickshell.execDetached(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
      "-o", "ControlMaster=auto", "-o", "ControlPath=" + (Quickshell.env("XDG_RUNTIME_DIR") || "/tmp") + "/argus-ssh-%C",
      "-o", "ControlPersist=120", "--", view.sshTarget, "kill " + signal + " " + pidText])
  }

  // The MangoHud config lives beside the flight recorder.
  readonly property string stateDir: local.stateDir

  readonly property string host: view.host
  readonly property string cpuName: view.cpuName
  readonly property string kernel: view.kernel
  readonly property int chassisType: view.chassisType
  readonly property var psi: view.psi
  readonly property var driveTemp: view.driveTemp
  readonly property real cpuPct: view.cpuPct
  readonly property var corePcts: view.corePcts
  readonly property real cpuMhz: view.cpuMhz
  readonly property real cpuTempC: view.cpuTempC
  readonly property real load1: view.load1
  readonly property real load5: view.load5
  readonly property real load15: view.load15
  readonly property real uptimeSec: view.uptimeSec
  readonly property real memTotal: view.memTotal
  readonly property real memUsed: view.memUsed
  readonly property real swapTotal: view.swapTotal
  readonly property real swapUsed: view.swapUsed
  readonly property var disks: view.disks
  readonly property var temps: view.temps
  readonly property var fans: view.fans
  readonly property var gpus: view.gpus
  readonly property var primaryGpu: view.primaryGpu
  readonly property bool nvidiaSuspended: view.nvidiaSuspended
  readonly property real netDown: view.netDown
  readonly property real netUp: view.netUp
  readonly property var netIfaces: view.netIfaces
  readonly property real ioRead: view.ioRead
  readonly property real ioWrite: view.ioWrite
  readonly property var ioDisks: view.ioDisks
  readonly property var psAll: view.psAll
  readonly property var netInfo: view.netInfo
  readonly property var memInfo: view.memInfo
  readonly property var swaps: view.swaps
  readonly property var cpuTopo: view.cpuTopo
  readonly property var cpuFreq: view.cpuFreq
  readonly property var batteries: view.batteries
  readonly property var battery: view.battery
  readonly property bool ready: view.ready
  readonly property var gpuPdev: view.gpuPdev
  readonly property var gpuProcs: view.gpuProcs
  readonly property var driveHealth: view.driveHealth
  readonly property var cpuHist: view.cpuHist
  readonly property var memHist: view.memHist
  readonly property var gpuHist: view.gpuHist
  readonly property var netDownHist: view.netDownHist
  readonly property var netUpHist: view.netUpHist
  readonly property var ioReadHist: view.ioReadHist
  readonly property var ioWriteHist: view.ioWriteHist
  readonly property var hourHist: view.hourHist
  readonly property var dayHist: view.dayHist
  readonly property var raplWatts: view.raplWatts
  readonly property bool raplRestricted: view.raplRestricted
  readonly property real cpuEnergyWh: view.cpuEnergyWh
  readonly property real gpuEnergyWh: view.gpuEnergyWh
  readonly property var cpuPowerHist: view.cpuPowerHist
  readonly property var gpuPowerHist: view.gpuPowerHist
  readonly property var cpuTempHist: view.cpuTempHist
  readonly property real peakCpuPower: view.peakCpuPower
  readonly property real peakGpuPower: view.peakGpuPower
  readonly property var alertLog: view.alertLog
  readonly property double lastTickAt: view.lastTickAt
  readonly property real peakCpuTemp: view.peakCpuTemp
  readonly property real peakGpuTemp: view.peakGpuTemp
  readonly property real peakNetDown: view.peakNetDown
  readonly property real peakNetUp: view.peakNetUp
  readonly property real peakIoRead: view.peakIoRead
  readonly property real peakIoWrite: view.peakIoWrite
  readonly property real memPct: view.memPct
  readonly property real swapPct: view.swapPct
  readonly property double lastSampleMs: view.lastSampleMs
  readonly property double avgSampleMs: view.avgSampleMs
  readonly property var sensorThresholds: view.sensorThresholds
  readonly property var barData: view.barData
  readonly property string historyPath: view.historyPath


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
