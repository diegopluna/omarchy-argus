import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Argus system-monitor bar widget: compact selectable metrics in the bar, a tabbed
// popup panel with the full picture, and per-metric toggles that persist to
// shell.json. Bar segments turn the bar's urgent color past configurable
// thresholds.
//
// Bar button — left click: panel · right click: btop · middle click: refresh
// Panel — h/l or ←/→: switch tab · j/k or ↑/↓: scroll · r: refresh · Esc: close
Panel {
  id: root
  moduleName: "io.github.diegopluna.argus"
  ipcTarget: "io.github.diegopluna.argus"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  readonly property var shownKeys: Model.normalizeShow(setting("show", Model.DEFAULT_SHOW))
  readonly property var thresholds: Model.thresholdsFrom(settings)
  readonly property var barSegs: Service.ready ? Model.barSegments(shownKeys, Service.barData, thresholds) : []
  // The placeholder icon also covers the not-yet-sampled window right after
  // the shell starts, so the widget is clickable from the first frame.
  readonly property bool placeholderOnly: barSegs.length === 0

  // "#aarrggbb" → "#rrggbb": styled-text font tags reject the alpha form.
  function colorHex(c) {
    var s = String(c)
    return s.length === 9 ? "#" + s.slice(3) : s
  }

  // Plain text normally; when a segment crosses its threshold, styled text
  // with per-segment <font> colors (the string starts with a tag so the
  // label's AutoText detection reliably switches to StyledText).
  readonly property string displayText: {
    if (placeholderOnly) return Model.PLACEHOLDER_ICON
    var anyUrgent = false
    var i
    for (i = 0; i < barSegs.length; i++) if (barSegs[i].urgent) anyUrgent = true
    var parts = []
    if (!anyUrgent) {
      for (i = 0; i < barSegs.length; i++) parts.push(barSegs[i].text)
      return parts.join("  ")
    }
    for (i = 0; i < barSegs.length; i++) {
      parts.push("<font color=\"" + colorHex(barSegs[i].urgent ? root.urgent : root.foreground) + "\">"
        + barSegs[i].text + "</font>")
    }
    return parts.join("&#160;&#160;")
  }

  readonly property var verticalLines: Service.ready
    ? Model.barLines(shownKeys, Service.barData, thresholds)
    : [{ text: Model.PLACEHOLDER_ICON, urgent: false }]

  readonly property var tabs: {
    var t = ["CPU", "MEM", "GPU", "DISK", "NET", "PROC", "TEMP"]
    if (Service.batteries.length > 0) t.push("BAT")
    t.push("BAR")
    return t
  }
  property string tab: "CPU"

  function switchTab(direction) {
    var index = (tabs.indexOf(tab) + direction + tabs.length) % tabs.length
    tab = tabs[index]
  }

  onTabChanged: {
    flick.contentY = 0
    editingSensor = ""
  }
  onTabsChanged: if (tabs.indexOf(tab) === -1) tab = "CPU"

  // Which TEMP-tab sensor row has its threshold editor expanded.
  property string editingSensor: ""
  // Whether hidden sensor rows are temporarily revealed.
  property bool showHiddenSensors: false
  readonly property var hiddenSensors: Model.normalizeHiddenSensors(setting("hiddenSensors", []))
  readonly property int hiddenSensorCount: {
    var count = 0
    for (var i = 0; i < Service.temps.length; i++) {
      if (hiddenSensors.indexOf(Model.sensorKey(Service.temps[i])) !== -1) count++
    }
    return count
  }

  // Process pending a kill confirmation: { pid, name } or null.
  property var pendingKill: null

  // How much wall clock one full sparkline spans.
  readonly property string histSpan: "last " + Model.fmtUptime(Model.HISTORY_LEN * Service.intervalSec)

  function setSensorLimit(key, value) {
    persistPluginSetting("sensorThresholds", Model.setSensorThreshold(setting("sensorThresholds", null), key, value))
  }

  function toggleSensorHidden(key) {
    persistPluginSetting("hiddenSensors", Model.toggleHiddenSensor(setting("hiddenSensors", []), key))
  }

  // The tab that explains a bar segment's urgency.
  function tabForKey(key) {
    switch (key) {
      case "cpu": case "cputemp": case "load": return "CPU"
      case "ram": return "MEM"
      case "gpu": case "gputemp": case "vram": return "GPU"
      case "disk": case "io": return "DISK"
      case "net": return "NET"
      case "bat": return "BAT"
      default: return ""
    }
  }

  // ---- Easter egg: the hundred eyes of Argus Panoptes -------------------
  property string _typed: ""
  property bool eggActive: false

  Timer {
    id: eggTimer
    interval: 6000
    onTriggered: root.eggActive = false
  }

  function handlePanelKey(text) {
    if (text.length !== 1) return
    _typed = (_typed + text.toLowerCase()).slice(-5)
    if (_typed === "argus") {
      eggActive = true
      eggTimer.restart()
      return
    }
    if (text === "r" || text === "R") {
      Service.refresh()
      return
    }
    var digit = parseInt(text, 10)
    if (!isNaN(digit) && digit >= 1 && digit <= tabs.length) {
      tab = tabs[digit - 1]
      return
    }
    // First-letter tab jump; repeated presses cycle ties (BAR/BAT).
    var letter = text.toUpperCase()
    if (letter < "A" || letter > "Z") return
    var start = tabs.indexOf(tab)
    for (var step = 1; step <= tabs.length; step++) {
      var candidate = tabs[(start + step) % tabs.length]
      if (candidate.charAt(0) === letter) { tab = candidate; return }
    }
  }

  function persistPluginSetting(name, value) {
    if (!root.bar || !root.bar.shell || typeof root.bar.shell.updateEntryInline !== "function") return
    var entry = { id: root.moduleName }
    for (var key in settings) if (key !== "id" && key !== name) entry[key] = settings[key]
    entry[name] = value
    root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function toggleMetric(key) {
    persistPluginSetting("show", Model.toggleShow(setting("show", Model.DEFAULT_SHOW), key))
  }

  function moveMetric(key, delta) {
    persistPluginSetting("show", Model.moveShow(setting("show", Model.DEFAULT_SHOW), key, delta))
  }

  function meterColor(fraction) {
    return fraction >= 0.9 ? root.urgent : Color.accent
  }

  // BAR tab rows: shown metrics first, in bar order, then the rest. The
  // battery metric only appears on machines that have one.
  readonly property var metricRows: {
    var rows = []
    var i
    for (i = 0; i < shownKeys.length; i++) {
      var shown = Model.metricByKey(shownKeys[i])
      if (shown) rows.push(shown)
    }
    for (i = 0; i < Model.METRICS.length; i++) {
      var metric = Model.METRICS[i]
      if (shownKeys.indexOf(metric.key) !== -1) continue
      if (metric.key === "bat" && Service.batteries.length === 0) continue
      rows.push(metric)
    }
    return rows
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) {
      Service.panelOpened()
      // Land on the tab that explains the problem, if there is one.
      for (var i = 0; i < barSegs.length; i++) {
        if (!barSegs[i].urgent) continue
        var target = tabForKey(barSegs[i].key)
        if (target !== "" && tabs.indexOf(target) !== -1) { tab = target; break }
      }
      Qt.callLater(function() { keyCatcher.forceActiveFocus() })
    } else {
      Service.panelClosed()
      pendingKill = null
      eggActive = false
      showHiddenSensors = false
    }
  }

  // One shared Service sampler runs for every bar surface; each widget
  // instance pushes its (identical) inline settings into the singleton.
  onSettingsChanged: Service.settings = root.settings
  Component.onCompleted: Service.settings = root.settings

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { Service.refresh(); return "ok" }
    function metrics(): string {
      return JSON.stringify({
        host: Service.host,
        uptimeSec: Service.uptimeSec,
        load: [Service.load1, Service.load5, Service.load15],
        cpuPct: Service.cpuPct,
        cpuTempC: Service.cpuTempC,
        memPct: Service.memPct,
        memUsedBytes: Service.memUsed,
        memTotalBytes: Service.memTotal,
        netDownBps: Service.netDown,
        netUpBps: Service.netUp,
        ioReadBps: Service.ioRead,
        ioWriteBps: Service.ioWrite,
        psi: Service.psi,
        gpus: Service.gpus.map(function(g) {
          return { label: g.label, name: g.name, busyPct: g.busy, tempC: g.celsius, vramUsed: g.vramUsed, vramTotal: g.vramTotal, powerW: g.powerW, asleep: g.asleep === true }
        }),
        battery: Service.battery,
        disks: Service.disks.map(function(d) { return { mount: d.mount, used: d.used, size: d.size } })
      })
    }
    function tab(name: string): string {
      var upper = String(name).toUpperCase()
      if (root.tabs.indexOf(upper) === -1) return "unknown tab; use " + root.tabs.join("|")
      root.tab = upper
      return "ok"
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.bar && root.bar.vertical ? "" : root.displayText
    labelVisible: !(root.bar && root.bar.vertical) && !root.placeholderOnly
    hasVisualContent: root.bar && root.bar.vertical ? root.verticalLines.length > 0 : text !== ""
    fixedWidth: !(root.bar && root.bar.vertical) && root.placeholderOnly ? Style.bar.iconSlot : -1
    fixedHeight: root.bar && root.bar.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1
    tooltipText: Service.ready
      ? Service.host + " · up " + Model.fmtUptime(Service.uptimeSec) + " · load " + Service.load1.toFixed(2)
        + (Service.battery ? " · bat " + Model.fmtPct(Service.battery.pct) + " " + Service.battery.status.toLowerCase() : "")
      : "Argus"

    onPressed: function(b) {
      if (b === Qt.RightButton) { if (root.bar) root.bar.run("omarchy-launch-or-focus-tui btop") }
      else if (b === Qt.MiddleButton) Service.refresh()
      else root.toggle()
    }

    // A bare Nerd Font glyph has asymmetric side bearings, so the plain text
    // label would paint it visibly off-center; when only the placeholder icon
    // shows, render through OpticalGlyph the way BarIconButton does.
    OpticalGlyph {
      id: placeholderEye
      visible: !(root.bar && root.bar.vertical) && root.placeholderOnly
      anchors.centerIn: parent
      width: Style.bar.iconCanvas
      height: Style.bar.iconCanvas
      text: Model.PLACEHOLDER_ICON
      fontFamily: button.fontFamily
      fontSize: Style.bar.iconFont
      color: button.foreground

      // Even the ever-watchful eye blinks now and then.
      property real blinkY: 1
      transform: Scale {
        origin.y: placeholderEye.height / 2
        yScale: placeholderEye.blinkY
      }

      Timer {
        running: placeholderEye.visible
        repeat: true
        interval: 6000
        onTriggered: {
          blinkAnim.restart()
          interval = 5000 + Math.round(Math.random() * 9000)
        }
      }

      SequentialAnimation {
        id: blinkAnim
        NumberAnimation { target: placeholderEye; property: "blinkY"; to: 0.08; duration: 70 }
        NumberAnimation { target: placeholderEye; property: "blinkY"; to: 1; duration: 110 }
      }
    }

    Column {
      visible: root.bar && root.bar.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property var modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData.text
          fontFamily: button.fontFamily
          fontSize: modelData.text.length > 3 ? button.fontSize * 0.85 : button.fontSize
          color: modelData.urgent ? root.urgent : button.foreground
        }
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
    contentHeight: panel.fittedContentHeight(header.implicitHeight + Style.space(12) + flick.contentHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: {
        if (confirmKill.opened) { root.pendingKill = null; return }
        if (root.eggActive) { root.eggActive = false; return }
        root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.switchTab(dx)
        else if (dy !== 0) flick.scrollBy(dy * Style.space(110))
      }
      onTextKey: function(text) { root.handlePanelKey(text) }

      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: root.eggActive ? "ARGUS PANOPTES" : (Service.host !== "" ? Service.host : "Argus")
          meta: root.eggActive
            ? "One hundred eyes, ever watchful."
            : (Service.ready
              ? "up " + Model.fmtUptime(Service.uptimeSec) + " · load " + Service.load1.toFixed(2) + " " + Service.load5.toFixed(2) + " " + Service.load15.toFixed(2)
              : "Gathering data…")
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            OpticalGlyph {
              width: Style.font.display
              height: Style.font.display
              text: "\u{f0ee0}"
              fontFamily: root.fontFamily
              fontSize: Style.font.display
              color: root.foreground
            }
          }
          trailingControl: Component {
            PanelActionButton {
              iconText: "\u{f0450}"
              tooltipText: "Refresh now"
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.subtitle
              size: Style.space(28)
              onClicked: Service.refresh()
            }
          }
        }

        ButtonGroup {
          options: root.tabs
          value: root.tab
          foreground: root.foreground
          accent: Color.accent
          fontFamily: root.fontFamily
          fontSize: Style.font.bodySmall
          focusable: false
          spacing: Style.space(4)
          onChanged: function(value) { root.tab = value }
        }
      }

      Flickable {
        id: flick
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.bottom: parent.bottom
        anchors.topMargin: Style.space(12)
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        function scrollBy(delta) {
          contentY = Math.max(0, Math.min(Math.max(0, contentHeight - height), contentY + delta))
        }

        // The Flickable's built-in wheel handling is sluggish inside the
        // panel surface; scroll a fixed chunk per notch instead.
        WheelHandler {
          target: null
          onWheel: function(event) {
            if (event.angleDelta.y === 0) return
            flick.scrollBy(event.angleDelta.y > 0 ? -Style.space(90) : Style.space(90))
          }
        }

        Column {
          id: content
          width: parent.width
          spacing: Style.space(12)

          // ---- CPU tab
          Column {
            visible: root.tab === "CPU"
            width: parent.width
            spacing: Style.space(8)

            NameHeader {
              title: "PROCESSOR"
              name: Service.cpuName
            }

            MeterRow {
              label: "Usage"
              value: Model.fmtPct(Service.cpuPct)
              fraction: Service.cpuPct / 100
            }

            Sparkline {
              width: parent.width
              values: Service.cpuHist
              maxValue: 100
            }

            Text {
              text: root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Text {
              text: Service.corePcts.length + " threads"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Flow {
              width: parent.width
              spacing: Style.space(3)

              Repeater {
                model: Service.corePcts

                Rectangle {
                  required property real modelData
                  width: Style.space(12)
                  height: Style.space(24)
                  radius: Style.space(2)
                  color: Qt.alpha(root.foreground, 0.12)

                  Rectangle {
                    anchors.bottom: parent.bottom
                    anchors.left: parent.left
                    anchors.right: parent.right
                    height: Math.max(Style.space(2), parent.height * parent.modelData / 100)
                    radius: parent.radius
                    color: root.meterColor(parent.modelData / 100)
                  }
                }
              }
            }

            DetailRow {
              label: "Frequency"
              value: Service.cpuMhz > 0 ? (Service.cpuMhz / 1000).toFixed(2) + " GHz" : ""
            }

            DetailRow {
              label: "Temperature"
              value: isFinite(Service.cpuTempC) ? Model.fmtTemp(Service.cpuTempC) : ""
            }

            DetailRow {
              label: "Peak temperature (session)"
              value: isFinite(Service.peakCpuTemp) ? Model.fmtTemp(Service.peakCpuTemp) : ""
            }

            DetailRow {
              label: "Load 1 / 5 / 15 min"
              value: Service.ready ? Service.load1.toFixed(2) + " / " + Service.load5.toFixed(2) + " / " + Service.load15.toFixed(2) : ""
            }

            DetailRow {
              label: "Uptime"
              value: Service.ready ? Model.fmtUptime(Service.uptimeSec) : ""
            }

            DetailRow {
              label: "Stall pressure 10s / 1m / 5m"
              value: Model.fmtPsi(Service.psi.cpu, "some")
            }

            DetailRow {
              label: "Kernel"
              value: Service.kernel
            }
          }

          // ---- Memory tab
          Column {
            visible: root.tab === "MEM"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "MEMORY"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            MeterRow {
              label: "RAM · " + Model.fmtBytes(Service.memUsed) + " of " + Model.fmtBytes(Service.memTotal)
              value: Model.fmtPct(Service.memPct)
              fraction: Service.memPct / 100
            }

            Sparkline {
              width: parent.width
              values: Service.memHist
              maxValue: 100
            }

            Text {
              text: root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            MeterRow {
              visible: Service.swapTotal > 0
              label: "Swap · " + Model.fmtBytes(Service.swapUsed) + " of " + Model.fmtBytes(Service.swapTotal)
              value: Model.fmtPct(Service.swapPct)
              fraction: Service.swapPct / 100
            }

            DetailRow {
              label: "Available"
              value: Service.ready ? Model.fmtBytes(Service.memTotal - Service.memUsed) : ""
            }

            DetailRow {
              label: "Stall pressure 10s / 1m / 5m"
              value: Model.fmtPsi(Service.psi.memory, "some")
            }

            Text {
              width: parent.width
              text: "Stall pressure (PSI) is time tasks spent waiting on the resource — 0 means nothing had to wait, however busy the machine was."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- GPU tab
          Column {
            visible: root.tab === "GPU"
            width: parent.width
            spacing: Style.space(10)

            Text {
              visible: Service.gpus.length === 0 && !Service.nvidiaSuspended
              width: parent.width
              text: "No supported GPU detected (amdgpu sysfs or nvidia-smi)."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Text {
              visible: Service.gpus.length === 0 && Service.nvidiaSuspended
              width: parent.width
              text: "NVIDIA GPU is runtime-suspended (asleep); stats resume when it wakes."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: Service.gpus

              Column {
                id: gpuBlock
                required property var modelData
                readonly property bool isPrimary: Service.primaryGpu && Service.primaryGpu.card === modelData.card
                width: parent.width
                spacing: Style.space(6)

                NameHeader {
                  title: gpuBlock.isPrimary && Service.gpus.length > 1
                    ? modelData.label + " · PRIMARY"
                    : modelData.label
                  name: modelData.name
                }

                DetailRow {
                  label: "State"
                  value: modelData.asleep ? "Runtime-suspended (asleep)" : ""
                }

                MeterRow {
                  visible: !modelData.asleep && isFinite(modelData.busy)
                  label: "Usage"
                  value: Model.fmtPct(modelData.busy)
                  fraction: (modelData.busy || 0) / 100
                }

                Text {
                  visible: modelData.noBusyCounter === true
                  width: parent.width
                  text: "Usage unavailable — this driver exposes no busy counter."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                Sparkline {
                  visible: gpuBlock.isPrimary && !modelData.asleep && isFinite(modelData.busy)
                  width: parent.width
                  values: Service.gpuHist
                  maxValue: 100
                }

                Text {
                  visible: gpuBlock.isPrimary && !modelData.asleep && isFinite(modelData.busy)
                  text: root.histSpan
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                MeterRow {
                  visible: !modelData.asleep && modelData.vramTotal > 0
                  label: "VRAM · " + Model.fmtBytes(modelData.vramUsed) + " of " + Model.fmtBytes(modelData.vramTotal)
                  value: modelData.vramTotal > 0 ? Model.fmtPct(100 * modelData.vramUsed / modelData.vramTotal) : ""
                  fraction: modelData.vramTotal > 0 ? modelData.vramUsed / modelData.vramTotal : 0
                }

                DetailRow {
                  label: "Temperature"
                  value: isFinite(modelData.celsius) ? Model.fmtTemp(modelData.celsius) : ""
                }

                DetailRow {
                  label: "Peak temperature (session)"
                  value: gpuBlock.isPrimary && isFinite(Service.peakGpuTemp) ? Model.fmtTemp(Service.peakGpuTemp) : ""
                }

                DetailRow {
                  label: "Power draw"
                  value: isFinite(modelData.powerW) && modelData.powerW > 0 ? Model.fmtWatts(modelData.powerW) : ""
                }
              }
            }
          }

          // ---- Storage tab
          Column {
            visible: root.tab === "DISK"
            width: parent.width
            spacing: Style.space(10)

            Repeater {
              model: Service.disks

              Column {
                required property var modelData
                width: parent.width
                spacing: Style.space(6)

                NameHeader {
                  title: modelData.mount
                  name: modelData.model !== "" ? modelData.model + " · " + modelData.device : modelData.source
                }

                MeterRow {
                  label: Model.fmtBytes(modelData.used) + " of " + Model.fmtBytes(modelData.size) + " used"
                  value: Model.fmtPct(100 * modelData.used / modelData.size)
                  fraction: modelData.used / modelData.size
                }
              }
            }

            PanelSectionHeader {
              text: "I/O"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            DetailRow {
              label: "Total"
              value: Service.ready ? "R " + Model.fmtBytes(Service.ioRead) + "/s · W " + Model.fmtBytes(Service.ioWrite) + "/s" : ""
            }

            DetailRow {
              label: "Session peak"
              value: Service.ready && (Service.peakIoRead > 0 || Service.peakIoWrite > 0)
                ? "R " + Model.fmtBytes(Service.peakIoRead) + "/s · W " + Model.fmtBytes(Service.peakIoWrite) + "/s"
                : ""
            }

            DetailRow {
              label: "Stall pressure 10s / 1m / 5m"
              value: Model.fmtPsi(Service.psi.io, "some")
            }

            Text {
              text: "Read · session peak " + Model.fmtBytes(Service.peakIoRead) + "/s · " + root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Sparkline {
              width: parent.width
              values: Service.ioReadHist
              heat: false
            }

            Text {
              text: "Write · session peak " + Model.fmtBytes(Service.peakIoWrite) + "/s · " + root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Sparkline {
              width: parent.width
              values: Service.ioWriteHist
              heat: false
            }

            Repeater {
              model: Service.ioDisks

              DetailRow {
                required property var modelData
                label: modelData.model !== "" ? modelData.model + " · " + modelData.dev : modelData.dev
                value: "R " + Model.fmtBytes(modelData.read) + "/s · W " + Model.fmtBytes(modelData.write) + "/s"
              }
            }
          }

          // ---- Network tab
          Column {
            visible: root.tab === "NET"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "NETWORK"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            DetailRow {
              label: "Total"
              value: Service.ready ? "\u{f0045} " + Model.fmtBytes(Service.netDown) + "/s   \u{f005d} " + Model.fmtBytes(Service.netUp) + "/s" : ""
            }

            Text {
              text: "Download · session peak " + Model.fmtBytes(Service.peakNetDown) + "/s · " + root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Sparkline {
              width: parent.width
              values: Service.netDownHist
              heat: false
            }

            Text {
              text: "Upload · session peak " + Model.fmtBytes(Service.peakNetUp) + "/s · " + root.histSpan
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Sparkline {
              width: parent.width
              values: Service.netUpHist
              heat: false
            }

            Repeater {
              model: Service.netIfaces

              DetailRow {
                required property var modelData
                visible: modelData.total > 0
                label: modelData.iface + (modelData.virtual ? " · virtual, not in totals" : "")
                value: "\u{f0045} " + Model.fmtBytes(modelData.down) + "/s   \u{f005d} " + Model.fmtBytes(modelData.up) + "/s"
              }
            }
          }

          // ---- Processes tab
          Column {
            visible: root.tab === "PROC"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "TOP CPU"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.psCpu

              ProcRow {
                required property var modelData
                proc: modelData
                value: modelData.cpu.toFixed(1) + "%"
              }
            }

            PanelSectionHeader {
              text: "TOP MEMORY"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.psMem

              ProcRow {
                required property var modelData
                proc: modelData
                value: Model.fmtBytes(Service.memTotal * modelData.mem / 100)
              }
            }

            Text {
              width: parent.width
              text: "\u{f0156} sends SIGTERM after confirmation."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- Temperatures tab
          Column {
            visible: root.tab === "TEMP"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "TEMPERATURES"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.temps

              Column {
                id: sensorRow
                required property var modelData
                readonly property string skey: Model.sensorKey(modelData)
                readonly property real limit: Model.sensorThreshold(Service.sensorThresholds, modelData)
                readonly property bool over: isFinite(limit) && modelData.celsius >= limit
                readonly property bool editing: root.editingSensor === skey
                readonly property bool hiddenSensor: root.hiddenSensors.indexOf(skey) !== -1
                visible: !hiddenSensor || root.showHiddenSensors
                width: parent.width
                spacing: Style.space(4)

                RowLayout {
                  width: parent.width
                  spacing: Style.space(8)

                  Text {
                    Layout.fillWidth: true
                    text: Model.tempName(sensorRow.modelData)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  Text {
                    visible: isFinite(sensorRow.limit) && !sensorRow.editing
                    text: "alert " + sensorRow.limit + "°"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Text {
                    text: Model.fmtTemp(sensorRow.modelData.celsius)
                    color: sensorRow.over ? root.urgent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  PanelActionButton {
                    iconText: sensorRow.hiddenSensor ? "\u{f0208}" : "\u{f0209}"
                    tooltipText: sensorRow.hiddenSensor ? "Show this sensor" : "Hide this sensor"
                    foreground: sensorRow.hiddenSensor ? Color.accent : root.dim
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.toggleSensorHidden(sensorRow.skey)
                  }

                  PanelActionButton {
                    iconText: "\u{f009a}"
                    tooltipText: isFinite(sensorRow.limit) ? "Edit alert threshold" : "Set alert threshold"
                    foreground: isFinite(sensorRow.limit) ? Color.accent : root.dim
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: {
                      if (sensorRow.editing) {
                        root.editingSensor = ""
                      } else {
                        if (!isFinite(sensorRow.limit)) {
                          root.setSensorLimit(sensorRow.skey, Model.suggestedSensorThreshold(sensorRow.modelData.celsius))
                        }
                        root.editingSensor = sensorRow.skey
                      }
                    }
                  }
                }

                RowLayout {
                  visible: sensorRow.editing
                  anchors.right: parent.right
                  spacing: Style.space(6)

                  Text {
                    text: "Alert at"
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  PanelActionButton {
                    iconText: "\u{f0374}"
                    tooltipText: "-5°"
                    enabled: sensorRow.limit > Model.SENSOR_THRESHOLD_MIN
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.setSensorLimit(sensorRow.skey, sensorRow.limit - 5)
                  }

                  Text {
                    text: sensorRow.limit + "°"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  PanelActionButton {
                    iconText: "\u{f0415}"
                    tooltipText: "+5°"
                    enabled: sensorRow.limit < Model.SENSOR_THRESHOLD_MAX
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.setSensorLimit(sensorRow.skey, sensorRow.limit + 5)
                  }

                  PanelActionButton {
                    iconText: "\u{f009b}"
                    tooltipText: "Remove threshold"
                    hoverColor: root.urgent
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: {
                      root.setSensorLimit(sensorRow.skey, NaN)
                      root.editingSensor = ""
                    }
                  }
                }
              }
            }

            Text {
              visible: root.hiddenSensorCount > 0
              width: parent.width
              text: root.showHiddenSensors
                ? "Done showing hidden sensors"
                : root.hiddenSensorCount + " hidden sensor" + (root.hiddenSensorCount === 1 ? "" : "s") + " · show"
              color: Color.accent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.showHiddenSensors = !root.showHiddenSensors
              }
            }

            Text {
              width: parent.width
              text: "\u{f009a} sets a per-sensor alert threshold — the row turns urgent and a notification fires when it stays above the limit. \u{f0209} hides a sensor row (thresholds keep alerting)."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSectionHeader {
              visible: Service.fans.length > 0
              text: "FANS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.fans

              DetailRow {
                required property var modelData
                label: Model.tempName(modelData)
                value: modelData.rpm + " RPM"
              }
            }

            Text {
              visible: Service.ready
                && Model.isDesktopChassis(Service.chassisType)
                && !Model.hasMotherboardSensors(Service.temps, Service.fans)
              width: parent.width
              text: "Motherboard fans and sensors need the board's Super I/O kernel driver, which does not auto-load — usually `modprobe nct6775` (`it87` for ITE chips). See the Argus README, section Fans."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- Battery tab (only reachable when a system battery exists)
          Column {
            visible: root.tab === "BAT"
            width: parent.width
            spacing: Style.space(10)

            Repeater {
              model: Service.batteries

              Column {
                id: batteryBlock
                required property var modelData
                readonly property real pct: modelData.energyFullWh > 0
                  ? 100 * modelData.energyNowWh / modelData.energyFullWh
                  : modelData.capacity
                width: parent.width
                spacing: Style.space(6)

                NameHeader {
                  title: modelData.name.toUpperCase()
                  name: modelData.model
                }

                MeterRow {
                  label: "Charge"
                    + (modelData.energyFullWh > 0
                      ? " · " + modelData.energyNowWh.toFixed(1) + " of " + modelData.energyFullWh.toFixed(1) + " Wh"
                      : "")
                  value: Model.fmtPct(batteryBlock.pct)
                  fraction: isFinite(batteryBlock.pct) ? batteryBlock.pct / 100 : 0
                  urgentLow: true
                }

                DetailRow {
                  label: "Status"
                  value: modelData.status
                }

                DetailRow {
                  label: "Charge limit"
                  value: isFinite(modelData.chargeLimit) ? Model.fmtPct(modelData.chargeLimit) : ""
                }

                DetailRow {
                  label: "Power draw"
                  value: modelData.powerW > 0 ? Model.fmtWatts(modelData.powerW) : ""
                }

                DetailRow {
                  label: "Health"
                  value: modelData.energyDesignWh > 0 && modelData.energyFullWh > 0
                    ? Model.fmtPct(100 * modelData.energyFullWh / modelData.energyDesignWh)
                      + " · " + modelData.energyFullWh.toFixed(1) + " of " + modelData.energyDesignWh.toFixed(1) + " Wh"
                    : ""
                }
              }
            }

            DetailRow {
              label: Service.battery && Service.battery.charging ? "Time to full" : "Time remaining"
              value: Service.battery && isFinite(Service.battery.timeSec) ? Model.fmtUptime(Service.battery.timeSec) : ""
            }
          }

          // ---- Bar metric selection tab
          Column {
            visible: root.tab === "BAR"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "SHOW IN BAR"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.metricRows

              RowLayout {
                id: metricRow
                required property var modelData
                readonly property int shownIndex: root.shownKeys.indexOf(modelData.key)
                readonly property bool isShown: shownIndex !== -1
                width: parent.width
                spacing: Style.space(4)

                PanelActionButton {
                  visible: metricRow.isShown
                  enabled: metricRow.shownIndex > 0
                  iconText: "\u{f005d}"
                  tooltipText: "Move up"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  size: Style.space(24)
                  onClicked: root.moveMetric(metricRow.modelData.key, -1)
                }

                PanelActionButton {
                  visible: metricRow.isShown
                  enabled: metricRow.shownIndex < root.shownKeys.length - 1
                  iconText: "\u{f0045}"
                  tooltipText: "Move down"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  size: Style.space(24)
                  onClicked: root.moveMetric(metricRow.modelData.key, 1)
                }

                Toggle {
                  Layout.fillWidth: true
                  label: (metricRow.modelData.icon !== "" ? metricRow.modelData.icon + "  " : "") + metricRow.modelData.label
                  checked: metricRow.isShown
                  foreground: root.foreground
                  accent: Color.accent
                  fontFamily: root.fontFamily
                  onClicked: root.toggleMetric(metricRow.modelData.key)
                }
              }
            }

            PanelSectionHeader {
              visible: Service.alertLog.length > 0
              text: "RECENT ALERTS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.alertLog

              Text {
                required property var modelData
                width: parent.width
                text: Qt.formatTime(new Date(modelData.at), "HH:mm") + " · " + modelData.text
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            Text {
              width: parent.width
              text: "Bar order follows this list · segments turn " + "urgent past thresholds (see plugin settings)"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "Bar button — left: panel · middle: refresh · right: btop"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }
          }

          Text {
            width: parent.width
            text: "h/l, 1-9, or first letter: tabs · j/k: scroll · r: refresh"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
      }

      // The hundred eyes of Argus Panoptes. Some say they can be summoned
      // by speaking his name.
      Item {
        id: eggOverlay
        anchors.fill: parent
        visible: root.eggActive
        z: 80

        Repeater {
          model: 100

          OpticalGlyph {
            id: eggEye
            required property int index
            readonly property real rx: Math.random()
            readonly property real ry: Math.random()
            readonly property real eyeSize: Style.font.body + Math.random() * Style.space(16)
            x: rx * Math.max(1, eggOverlay.width - width)
            y: ry * Math.max(1, eggOverlay.height - height)
            width: eyeSize
            height: eyeSize
            text: Model.PLACEHOLDER_ICON
            fontFamily: root.fontFamily
            fontSize: eyeSize
            color: index % 5 === 0 ? Color.accent : root.foreground
            opacity: 0

            SequentialAnimation on opacity {
              running: root.eggActive
              PauseAnimation { duration: eggEye.index * 20 }
              NumberAnimation { to: 0.85; duration: 250 }

              SequentialAnimation {
                loops: Animation.Infinite
                PauseAnimation { duration: 900 + (eggEye.index % 13) * 260 }
                NumberAnimation { to: 0.15; duration: 70 }
                NumberAnimation { to: 0.85; duration: 130 }
              }
            }
          }
        }
      }

      ConfirmDialog {
        id: confirmKill
        anchors.fill: parent
        z: 90
        opened: root.pendingKill !== null
        message: root.pendingKill
          ? "Terminate " + root.pendingKill.name + " (PID " + root.pendingKill.pid + ")?"
          : ""
        confirmText: "Terminate"
        fontFamily: root.fontFamily
        onCanceled: root.pendingKill = null
        onConfirmed: {
          Quickshell.execDetached(["kill", String(root.pendingKill.pid)])
          root.pendingKill = null
          killRefresh.restart()
        }
      }

      // Give the terminated process a beat to exit before resampling.
      Timer {
        id: killRefresh
        interval: 700
        onTriggered: Service.refresh()
      }
    }
  }

  // Section header plus the hardware's actual name underneath.
  component NameHeader: Column {
    required property string title
    property string name: ""
    width: parent ? parent.width : 0
    spacing: Style.space(2)

    PanelSectionHeader {
      text: parent.title
      foreground: root.foreground
      fontFamily: root.fontFamily
    }

    Text {
      visible: parent.name !== ""
      width: parent.width
      text: parent.name
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      wrapMode: Text.WordWrap
    }
  }

  // Process row: elided command line, metric value, and a terminate button
  // that arms the confirm dialog.
  component ProcRow: RowLayout {
    id: procRow
    property var proc: null
    property string value: ""
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    Text {
      Layout.fillWidth: true
      text: procRow.proc ? Model.procDisplay(procRow.proc.comm) + " · " + procRow.proc.pid : ""
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Text {
      text: procRow.value
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    PanelActionButton {
      iconText: "\u{f0156}"
      tooltipText: "Terminate (SIGTERM)"
      hoverColor: root.urgent
      foreground: root.dim
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      size: Style.space(22)
      onClicked: root.pendingKill = {
        pid: procRow.proc.pid,
        name: Model.procDisplay(procRow.proc.comm).split(" ")[0]
      }
    }
  }

  component DetailRow: RowLayout {
    required property string label
    property string value: ""
    width: parent ? parent.width : 0
    visible: value !== ""
    spacing: Style.space(12)

    Text {
      Layout.fillWidth: true
      text: parent.label
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Text {
      text: parent.value
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      horizontalAlignment: Text.AlignRight
    }
  }

  component MeterRow: Column {
    id: meterRow
    required property string label
    property string value: ""
    property real fraction: 0
    // High fill is the alarming direction by default; battery charge flips it.
    property bool urgentLow: false
    width: parent ? parent.width : 0
    spacing: Style.space(4)

    RowLayout {
      width: parent.width
      spacing: Style.space(12)

      Text {
        Layout.fillWidth: true
        text: meterRow.label
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        text: meterRow.value
        color: root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
      }
    }

    Rectangle {
      width: parent.width
      height: Style.space(4)
      radius: height / 2
      color: Qt.alpha(root.foreground, 0.12)

      Rectangle {
        anchors.left: parent.left
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        width: parent.width * Math.max(0, Math.min(1, meterRow.fraction))
        radius: parent.radius
        color: meterRow.urgentLow
          ? (meterRow.fraction <= 0.15 ? root.urgent : Color.accent)
          : root.meterColor(meterRow.fraction)

        Behavior on width {
          NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
        }
      }
    }
  }

  // Rolling bar-chart history, right-aligned so the newest sample hugs the
  // right edge and the chart fills leftward as history accumulates.
  component Sparkline: Item {
    id: spark
    property var values: []
    property real maxValue: 0 // 0 = autoscale to the series peak
    property bool heat: true  // color bars by fraction; false = plain accent
    height: Style.space(34)

    readonly property real peak: {
      if (maxValue > 0) return maxValue
      var m = 1
      for (var i = 0; i < values.length; i++) if (values[i] > m) m = values[i]
      return m
    }
    readonly property real slot: width / Model.HISTORY_LEN

    Rectangle {
      anchors.fill: parent
      radius: Style.space(2)
      color: Qt.alpha(root.foreground, 0.07)
    }

    Repeater {
      model: spark.values

      Rectangle {
        required property int index
        required property real modelData
        readonly property real fraction: Math.max(0, Math.min(1, modelData / spark.peak))
        x: spark.width - (spark.values.length - index) * spark.slot
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 1
        width: Math.max(1, spark.slot - 1)
        height: Math.max(2, (spark.height - 2) * fraction)
        radius: 1
        color: spark.heat ? root.meterColor(fraction) : Color.accent
      }
    }
  }
}
