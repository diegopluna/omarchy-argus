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

  // Threshold captions render through this so they re-evaluate when the
  // unit flips — Model's module state alone is invisible to QML's
  // dependency tracking.
  readonly property string tempUnit: setting("tempUnit", "C")
  function fmtLimitTemp(celsius) {
    var unit = tempUnit // binding dependency
    return Model.displayTemp(celsius) + Model.tempSuffix()
  }
  readonly property var thresholds: Model.thresholdsFrom(settings)
  readonly property var barSegs: Service.ready ? Model.barSegments(shownKeys, Service.barData, thresholds) : []
  // The panel's always-visible vitals, independent of the bar selection.
  readonly property var vitalSegs: Service.ready ? Model.barSegments(Model.VITAL_KEYS, Service.barData, thresholds) : []
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

  // Row models must not rebuild their delegates every tick, so they hang
  // off these stable booleans instead of the per-tick Service arrays —
  // a bool only signals when it actually flips.
  readonly property bool hasGpu: Service.gpus.length > 0
  readonly property bool hasBattery: Service.batteries.length > 0
  readonly property bool hasDriveTemp: Service.driveTemp !== null
  readonly property bool hasDriveHealth: Service.driveHealth.length > 0

  readonly property var tabs: {
    var t = ["HOME", "CPU", "MEM", "GPU", "DISK", "NET", "PROC", "TEMP"]
    if (hasBattery) t.push("BAT")
    t.push("PWR")
    t.push("GAME")
    t.push("ALERTS")
    t.push("SETUP")
    return t
  }

  // ---- GAME tab (MangoHud) ----------------------------------------------
  property bool mangoFieldFocused: false

  function setMango(key, value) {
    var m = JSON.parse(JSON.stringify(Service.mango))
    m[key] = value
    persistPluginSetting("mangoHud", m)
  }

  function toggleMangoMetric(key) {
    setMango("metrics", Model.toggleMangoMetric(Service.mango.metrics, key))
  }
  property string tab: "HOME"

  function switchTab(direction) {
    var index = (tabs.indexOf(tab) + direction + tabs.length) % tabs.length
    tab = tabs[index]
  }

  onTabChanged: {
    flick.contentY = 0
    editingSensor = ""
    editingAlert = ""
    procCursor = -1
    expandedProc = ""
    expandedAlertAt = 0
    Service.lastTab = tab
    // The full process table only ships while PROC is watched; fetch it
    // immediately on arrival instead of waiting out the tick.
    if (tab === "PROC" && opened) Service.refresh(true)
  }
  onTabsChanged: if (tabs.indexOf(tab) === -1) tab = "HOME"

  // ---- Home tab ---------------------------------------------------------
  // Which tiles the user enabled, minus hardware this machine lacks.
  readonly property var enabledHomeTiles: Model.normalizeHomeTiles(setting("homeTiles", Model.DEFAULT_HOME))
  readonly property var homeTiles: {
    var rows = []
    for (var i = 0; i < enabledHomeTiles.length; i++) {
      var tile = Model.homeTileByKey(enabledHomeTiles[i])
      if (!tile) continue
      if (tile.key === "gpu" && !hasGpu) continue
      if (tile.key === "bat" && !hasBattery) continue
      rows.push(tile)
    }
    return rows
  }
  // Every offerable tile, for the SETUP tab's SHOW ON HOME toggles.
  readonly property var homeTileRows: {
    var rows = []
    for (var i = 0; i < Model.HOME_TILES.length; i++) {
      var tile = Model.HOME_TILES[i]
      if (tile.key === "gpu" && !hasGpu) continue
      if (tile.key === "bat" && !hasBattery) continue
      rows.push(tile)
    }
    return rows
  }

  function toggleHomeTile(key) {
    persistPluginSetting("homeTiles", Model.toggleHomeTile(setting("homeTiles", Model.DEFAULT_HOME), key))
  }

  // Everything a home tile renders: big value, dim subline, and either a
  // sparkline series (values/maxValue/heat/peakValue) or a meter
  // (fraction, low = battery-style urgency direction).
  function homeTileData(key) {
    var d = Service
    switch (key) {
      case "cpu": return {
        value: Model.fmtPct(d.cpuPct),
        sub: (isFinite(d.cpuTempC) ? Model.fmtTemp(d.cpuTempC) + " · " : "") + (d.cpuMhz > 0 ? (d.cpuMhz / 1000).toFixed(1) + " GHz" : ""),
        values: histFor(d.cpuHist, "cpu"), maxValue: 100, heat: true
      }
      case "ram": return {
        value: Model.fmtPct(d.memPct),
        sub: Model.fmtBytes(d.memUsed) + " of " + Model.fmtBytes(d.memTotal),
        values: histFor(d.memHist, "mem"), maxValue: 100, heat: true
      }
      case "gpu": {
        var g = d.primaryGpu
        return {
          value: g && !g.asleep && isFinite(g.busy) ? Model.fmtPct(g.busy) : "—",
          sub: g ? ((isFinite(g.celsius) ? Model.fmtTemp(g.celsius) : "")
            + (isFinite(g.powerW) && g.powerW > 0 ? " · " + Model.fmtWatts(g.powerW) : "")) : "",
          values: histFor(d.gpuHist, "gpu"), maxValue: 100, heat: true
        }
      }
      case "net": return {
        value: "\u{f0045} " + Model.fmtBytes(d.netDown) + "/s",
        sub: "\u{f005d} " + Model.fmtBytes(d.netUp) + "/s",
        values: histFor(d.netDownHist, "netDown"), maxValue: 0, heat: false, peakValue: d.peakNetDown
      }
      case "io": return {
        value: "R " + Model.fmtBytes(d.ioRead) + "/s",
        sub: "W " + Model.fmtBytes(d.ioWrite) + "/s",
        values: Model.sumHist(histFor(d.ioReadHist, "ioRead"), histFor(d.ioWriteHist, "ioWrite")),
        maxValue: 0, heat: false, peakValue: d.peakIoRead + d.peakIoWrite
      }
      case "disk": {
        var disk = Service.barData.disk
        return disk && disk.size > 0
          ? { value: Model.fmtPct(100 * disk.used / disk.size), sub: disk.mount + " · " + Model.fmtBytes(disk.used) + " of " + Model.fmtBytes(disk.size), fraction: disk.used / disk.size }
          : { value: "—", sub: "", fraction: 0 }
      }
      case "bat": {
        var b = d.battery
        return b && isFinite(b.pct)
          ? { value: Model.fmtPct(b.pct), sub: b.status + (isFinite(b.timeSec) ? " · " + Model.fmtUptime(b.timeSec) : ""), fraction: b.pct / 100, low: true }
          : { value: "—", sub: "", fraction: 0 }
      }
      default: return { value: "", sub: "" }
    }
  }

  // Which TEMP-tab sensor row has its threshold editor expanded.
  property string editingSensor: ""
  // Which BAR-tab alert row has its threshold editor expanded.
  property string editingAlert: ""

  // Alerts the user has opted into (all off by default); the ALERTS tab's
  // toggles persist this list.
  readonly property var enabledAlerts: Model.normalizeAlertsOn(setting("alertsOn", []))

  // ALERTS-tab rows, minus hardware this machine doesn't have — a GPU
  // alert on a GPU-less box could never fire. Each row is { entry,
  // header }: header carries the group title on the group's first
  // surviving row (USAGE / TEMPERATURE / HEALTH), "" otherwise.
  readonly property var alertRows: {
    var rows = []
    var lastGroup = ""
    for (var i = 0; i < Model.ALERT_SETTINGS.length; i++) {
      var entry = Model.ALERT_SETTINGS[i]
      if ((entry.key === "gpu" || entry.key === "gputemp" || entry.key === "vram") && !hasGpu) continue
      if (entry.key === "bat" && !hasBattery) continue
      if (entry.key === "drivetemp" && !hasDriveTemp) continue
      if (entry.key === "drivehealth" && !hasDriveHealth) continue
      rows.push({ entry: entry, header: entry.group !== lastGroup ? entry.group : "" })
      lastGroup = entry.group
    }
    return rows
  }

  function toggleAlert(key) {
    persistPluginSetting("alertsOn", Model.toggleAlertOn(setting("alertsOn", []), key))
  }

  function stepAlert(entry, delta) {
    persistPluginSetting(entry.setting, Model.stepAlertThreshold(entry, thresholds[entry.thKey], delta))
  }
  // Whether hidden sensor rows are temporarily revealed.
  property bool showHiddenSensors: false
  readonly property var hiddenSensors: Model.normalizeHiddenSensors(setting("hiddenSensors", []))
  // Armed per-sensor alerts, for the ALERTS tab's overview list.
  readonly property var sensorAlerts: Model.sensorAlertRows(Service.sensorThresholds, Service.temps)
  readonly property int hiddenSensorCount: {
    var count = 0
    for (var i = 0; i < Service.temps.length; i++) {
      if (hiddenSensors.indexOf(Model.sensorKey(Service.temps[i])) !== -1) count++
    }
    return count
  }

  // Process pending a kill confirmation: { pid, name, sig } or null;
  // sig is "TERM" or "KILL".
  property var pendingKill: null

  // ---- Process table state ---------------------------------------------
  // Filter text, sort column/direction, keyboard cursor row, and which
  // pid's row is expanded. The sampler ships the full table; slicing is
  // pure Model code, so re-sorting costs no resample.
  property string procFilter: ""
  property string procSort: "cpu"
  property bool procSortAsc: false
  property string expandedProc: ""
  property int procCursor: -1
  // While the filter field holds focus, the panel's key catcher stands
  // aside so h/j/k/l/x become typeable text.
  property bool procFilterFocused: false
  property var procFilterField: null
  readonly property var procView: Model.visibleProcs(Service.psAll, procFilter, procSort, procSortAsc)

  function setProcSort(key) {
    if (procSort === key) {
      procSortAsc = !procSortAsc
    } else {
      procSort = key
      // Rates read best largest-first; identities smallest-first.
      procSortAsc = key === "name" || key === "pid"
    }
    procCursor = -1
  }

  function moveProcCursor(delta) {
    var count = procView.rows.length
    if (count === 0) return
    procCursor = procCursor < 0 ? (delta > 0 ? 0 : count - 1)
      : Math.max(0, Math.min(count - 1, procCursor + delta))
    Qt.callLater(scrollProcCursorIntoView)
  }

  function scrollProcCursorIntoView() {
    var item = procRepeater.itemAt(procCursor)
    if (!item) return
    var top = item.mapToItem(content, 0, 0).y
    var bottom = top + item.height
    if (top < flick.contentY) flick.contentY = Math.max(0, top - Style.space(8))
    else if (bottom > flick.contentY + flick.height)
      flick.contentY = Math.min(Math.max(0, flick.contentHeight - flick.height), bottom - flick.height + Style.space(8))
  }

  function procAtCursor() {
    return procCursor >= 0 && procCursor < procView.rows.length ? procView.rows[procCursor] : null
  }

  function armKill(proc, sig) {
    pendingKill = {
      pid: proc.pid,
      name: Model.procDisplay(proc.comm).split(" ")[0].replace(/[<>&]/g, ""),
      sig: sig
    }
  }

  // Which span the sparklines show: the per-tick fine ring (~2m), the
  // hour ring of per-minute peaks, or the persisted day ring. Cycled by
  // clicking any chart caption.
  property string histSpan: "2m"

  // Which alert-log entry has its context snapshot expanded (its `at`).
  property double expandedAlertAt: 0

  // Bumped on every user-triggered refresh so the hero's refresh glyph can
  // spin in acknowledgment — without it, r / middle click do nothing visible.
  property int refreshPulse: 0

  function refreshNow() {
    Service.refresh(true)
    refreshPulse++
  }

  // Sparkline slots (counted back from the right edge) where an alert on
  // one of `keys` fired within the visible window.
  function alertMarkers(keys) {
    var times = []
    for (var i = 0; i < Service.alertLog.length; i++) {
      if (keys.indexOf(Service.alertLog[i].key) !== -1) times.push(Service.alertLog[i].at)
    }
    var slotSec = Model.spanSlotSec(histSpan, Service.intervalSec)
    return Model.markerIndices(times, Service.lastTickAt, slotSec, Model.HISTORY_LEN)
  }

  // The series a chart renders at the current span.
  function histFor(fine, key) {
    if (histSpan === "1h") return Model.hourValues(Service.hourHist, key)
    if (histSpan === "24h") return Model.hourValues(Service.dayHist, key)
    return fine
  }

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
      root.refreshNow()
      return
    }
    if (text === "/" && tab === "PROC") {
      if (procFilterField) procFilterField.forceActiveFocus()
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

  // SETUP tab bar-metric rows: shown metrics first, in bar order, then the rest. The
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
      if (metric.key === "bat" && !hasBattery) continue
      rows.push(metric)
    }
    return rows
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: {
    if (opened) {
      Service.panelOpened()
      // Reopen where the user left off; an urgent metric still wins.
      if (tabs.indexOf(Service.lastTab) !== -1) tab = Service.lastTab
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
  // The temperature unit is module state in this file's own copy of
  // Model.js, so it is set here too.
  onSettingsChanged: {
    Service.settings = root.settings
    Model.setTempUnit(setting("tempUnit", "C"))
  }
  Component.onCompleted: {
    Service.settings = root.settings
    Model.setTempUnit(setting("tempUnit", "C"))
  }

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
          return { label: g.label, name: g.name, busyPct: g.busy, tempC: g.celsius,
            vramUsed: g.vramUsed, vramTotal: g.vramTotal,
            gttUsed: g.gttUsed || 0, gttTotal: g.gttTotal || 0, apu: g.apu === true,
            memUsed: Model.gpuMemUsed(g), memTotal: Model.gpuMemTotal(g),
            powerW: g.powerW, asleep: g.asleep === true }
        }),
        battery: Service.battery,
        disks: Service.disks.map(function(d) { return { mount: d.mount, used: d.used, size: d.size } }),
        driveHealth: Service.driveHealth,
        alerts: Service.alertLog,
        samplerMs: { last: Service.lastSampleMs, avg: Service.avgSampleMs }
      })
    }
    function tab(name: string): string {
      var upper = String(name).toUpperCase()
      if (upper === "BAR") upper = "SETUP" // pre-1.0 scripts
      if (root.tabs.indexOf(upper) === -1) return "unknown tab; use " + root.tabs.join("|")
      root.tab = upper
      return "ok"
    }
    function span(name: string): string {
      var v = String(name).toLowerCase()
      if (Model.SPANS.indexOf(v) === -1) return "unknown span; use " + Model.SPANS.join("|")
      root.histSpan = v
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
      else if (b === Qt.MiddleButton) root.refreshNow()
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
      // A focused text field owns the keyboard — h/j/k/l/x must be
      // typeable text there, not navigation.
      blocked: root.procFilterFocused || root.mangoFieldFocused
      onCloseRequested: {
        if (confirmKill.opened) { root.pendingKill = null; return }
        if (root.eggActive) { root.eggActive = false; return }
        if (root.tab === "PROC" && root.procFilter !== "") { root.procFilter = ""; return }
        root.close()
      }
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.switchTab(dx)
        else if (dy !== 0) {
          if (root.tab === "PROC") root.moveProcCursor(dy)
          else flick.scrollBy(dy * Style.space(110))
        }
      }
      onActivateRequested: {
        if (root.tab !== "PROC") return
        var proc = root.procAtCursor()
        if (proc) root.expandedProc = root.expandedProc === proc.pid ? "" : proc.pid
      }
      onDeleteRequested: {
        if (root.tab !== "PROC") return
        var proc = root.procAtCursor()
        if (proc) root.armKill(proc, "TERM")
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
              ? "up " + Model.fmtUptime(Service.uptimeSec) + " · load " + Service.load1.toFixed(2)
              : "Gathering data…")
          foreground: root.foreground
          fontFamily: root.fontFamily
          iconComponent: Component {
            // The eye of Argus heads its own panel — and blinks on the
            // same lazy schedule as the bar placeholder.
            OpticalGlyph {
              id: heroEye
              width: Style.font.display
              height: Style.font.display
              text: Model.PLACEHOLDER_ICON
              fontFamily: root.fontFamily
              fontSize: Style.font.display
              color: root.foreground

              property real blinkY: 1
              transform: Scale {
                origin.y: heroEye.height / 2
                yScale: heroEye.blinkY
              }

              Timer {
                running: root.opened
                repeat: true
                interval: 7000
                onTriggered: {
                  heroBlink.restart()
                  interval = 5000 + Math.round(Math.random() * 9000)
                }
              }

              SequentialAnimation {
                id: heroBlink
                NumberAnimation { target: heroEye; property: "blinkY"; to: 0.08; duration: 70 }
                NumberAnimation { target: heroEye; property: "blinkY"; to: 1; duration: 110 }
              }
            }
          }
          trailingControl: Component {
            PanelActionButton {
              id: refreshButton
              iconText: "\u{f0450}"
              tooltipText: "Refresh now"
              foreground: root.foreground
              fontFamily: root.fontFamily
              fontSize: Style.font.subtitle
              size: Style.space(28)
              onClicked: root.refreshNow()

              // One spin per refresh, whichever gesture triggered it.
              Connections {
                target: root
                function onRefreshPulseChanged() { refreshSpin.restart() }
              }

              NumberAnimation {
                id: refreshSpin
                target: refreshButton
                property: "rotation"
                from: 0
                to: 360
                duration: 450
                easing.type: Easing.OutCubic
              }
            }
          }
        }

        // The watch row: every vital on every tab — Argus never goes blind
        // to the rest of the system while you read one tab. Dim at rest,
        // urgent when a metric is, foreground for the tab you're on.
        // Clicking a vital jumps to the tab that explains it.
        Flow {
          visible: root.vitalSegs.length > 0
          width: parent.width
          spacing: Style.space(12)

          Repeater {
            model: root.vitalSegs

            Text {
              textFormat: Text.PlainText
              id: vital
              required property var modelData
              readonly property string target: root.tabForKey(modelData.key)
              text: modelData.text
              color: modelData.urgent ? root.urgent
                : (vital.target === root.tab ? root.foreground : root.dim)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                  if (vital.target !== "" && root.tabs.indexOf(vital.target) !== -1) root.tab = vital.target
                }
              }
            }
          }
        }

        // Tab strip: plain text tabs with an accent underline — without
        // chip chrome all eleven fit one calm row (wrapping only at large
        // font scales). Hover brightens, the wheel cycles tabs, and the
        // hairline below anchors the strip to the content.
        Column {
          width: parent.width
          spacing: Style.space(8)

          Flow {
            width: parent.width
            spacing: Style.space(8)

            WheelHandler {
              onWheel: function(event) {
                if (event.angleDelta.y !== 0) root.switchTab(event.angleDelta.y < 0 ? 1 : -1)
              }
            }

            Repeater {
              model: root.tabs

              Item {
                id: tabItem
                required property string modelData
                readonly property bool active: root.tab === modelData
                width: tabLabel.implicitWidth
                height: tabLabel.implicitHeight + Style.space(5)

                Text {
                  textFormat: Text.PlainText
                  id: tabLabel
                  text: tabItem.modelData
                  color: tabItem.active ? Color.accent : (tabMouse.containsMouse ? root.foreground : root.dim)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Rectangle {
                  anchors.bottom: parent.bottom
                  width: tabLabel.implicitWidth
                  height: Math.max(2, Style.space(2))
                  radius: height / 2
                  color: Color.accent
                  opacity: tabItem.active ? 1 : 0

                  Behavior on opacity {
                    NumberAnimation { duration: 140 }
                  }
                }

                MouseArea {
                  id: tabMouse
                  anchors.fill: parent
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.tab = tabItem.modelData
                }
              }
            }
          }

          PanelSeparator {
            foreground: root.foreground
          }
        }
      }

      Flickable {
        id: flick
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.bottom: parent.bottom
        anchors.topMargin: Style.space(12)
        // Gutter for the scroll indicator, so it never overlaps content
        // (toggles and steppers sit flush at the right edge).
        anchors.rightMargin: Style.space(7)
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

          // ---- Home tab: the overview. Configurable tiles (SETUP tab picks
          // them), each a glance at one subsystem; clicking opens its tab.
          Column {
            visible: root.tab === "HOME"
            width: parent.width
            spacing: Style.space(10)

            Flow {
              width: parent.width
              spacing: Style.space(8)

              Repeater {
                model: root.homeTiles

                Rectangle {
                  id: homeTile
                  required property var modelData
                  readonly property var tile: root.homeTileData(modelData.key)
                  width: (parent.width - Style.space(8)) / 2
                  height: tileContent.implicitHeight + Style.space(20)
                  radius: Style.space(6)
                  color: Qt.alpha(root.foreground, 0.05)

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: if (root.tabs.indexOf(homeTile.modelData.tab) !== -1) root.tab = homeTile.modelData.tab
                  }

                  Column {
                    id: tileContent
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: Style.space(10)
                    spacing: Style.space(5)

                    RowLayout {
                      width: parent.width
                      spacing: Style.space(6)

                      Text {
                        textFormat: Text.PlainText
                        Layout.fillWidth: true
                        text: homeTile.modelData.icon + "  " + homeTile.modelData.label
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }

                      Text {
                        textFormat: Text.PlainText
                        text: homeTile.tile.value
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.subtitle
                      }
                    }

                    Text {
                      visible: homeTile.tile.sub !== ""
                      width: parent.width
                      text: homeTile.tile.sub
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }

                    Sparkline {
                      visible: homeTile.tile.values !== undefined
                      width: parent.width
                      height: Style.space(22)
                      values: homeTile.tile.values || []
                      maxValue: homeTile.tile.maxValue || 0
                      heat: homeTile.tile.heat === true
                      peakValue: homeTile.tile.peakValue || 0
                    }

                    Rectangle {
                      visible: homeTile.tile.fraction !== undefined
                      width: parent.width
                      height: Style.space(5)
                      radius: height / 2
                      color: Qt.alpha(root.foreground, 0.12)

                      Rectangle {
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.bottom: parent.bottom
                        width: parent.width * Math.max(0, Math.min(1, homeTile.tile.fraction || 0))
                        radius: parent.radius
                        color: homeTile.tile.low === true
                          ? ((homeTile.tile.fraction || 0) <= 0.15 ? root.urgent : Color.accent)
                          : root.meterColor(homeTile.tile.fraction || 0)
                      }
                    }
                  }
                }
              }
            }

            SpanCaption {}

            Text {
              id: homeLastAlert
              visible: Service.alertLog.length > 0
              width: parent.width
              text: Service.alertLog.length > 0
                ? "Last alert · " + Qt.formatDateTime(new Date(Service.alertLog[0].at), "ddd HH:mm") + " · " + Service.alertLog[0].text
                : ""
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight

              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: root.tab = "ALERTS"
              }
            }

            Text {
              visible: root.homeTiles.length === 0
              width: parent.width
              text: "All Home tiles are hidden — pick some in the SETUP tab."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "Click a tile to open its tab · choose tiles in the SETUP tab"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }
          }

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
              values: root.histFor(Service.cpuHist, "cpu")
              maxValue: 100
              markers: root.alertMarkers(["cpu", "cputemp"])
            }

            SpanCaption {}

            // Core grid, laid out like the silicon: SMT siblings fused
            // into one core cell, cores grouped by L3 domain (CCDs on
            // multi-die parts), efficiency cores drawn shorter on hybrid
            // chips. Machines without exposed topology keep the flat grid.
            Column {
              id: coreGrid
              readonly property var topo: Model.cpuTopoGroups(Service.cpuTopo)
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: coreGrid.topo.groups

                Column {
                  id: topoGroup
                  required property var modelData
                  width: parent.width
                  spacing: Style.space(3)

                  Text {
                    textFormat: Text.PlainText
                    text: (topoGroup.modelData.label !== "" ? topoGroup.modelData.label + " · " : "")
                      + topoGroup.modelData.cores.length + " cores"
                      + (coreGrid.topo.smt ? ", " + Service.corePcts.length + " threads" : "")
                      + (Model.groupFreqText(topoGroup.modelData, Service.cpuFreq) !== ""
                        ? " · " + Model.groupFreqText(topoGroup.modelData, Service.cpuFreq) : "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Flow {
                    width: parent.width
                    spacing: Style.space(4)

                    Repeater {
                      model: topoGroup.modelData.cores

                      Row {
                        id: coreCell
                        required property var modelData
                        spacing: 1

                        Repeater {
                          model: coreCell.modelData.cpus

                          Rectangle {
                            required property var modelData
                            readonly property real pct: Service.corePcts[modelData] || 0
                            width: Style.space(10)
                            height: coreCell.modelData.eff ? Style.space(17) : Style.space(24)
                            radius: Style.space(2)
                            color: Qt.alpha(root.foreground, 0.12)

                            Rectangle {
                              anchors.bottom: parent.bottom
                              anchors.left: parent.left
                              anchors.right: parent.right
                              // Idle threads show empty cells — minimum
                              // fills read as a dashed line of phantom load.
                              height: parent.pct < 1 ? 0 : Math.max(Style.space(2), parent.height * parent.pct / 100)
                              radius: parent.radius
                              color: root.meterColor(parent.pct / 100)
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }

              Text {
                textFormat: Text.PlainText
                visible: coreGrid.topo.groups.length === 0
                text: Service.corePcts.length + " threads"
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }

              Flow {
                visible: coreGrid.topo.groups.length === 0
                width: parent.width
                spacing: Style.space(3)

                Repeater {
                  model: coreGrid.topo.groups.length === 0 ? Service.corePcts : []

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
                      height: parent.modelData < 1 ? 0 : Math.max(Style.space(2), parent.height * parent.modelData / 100)
                      radius: parent.radius
                      color: root.meterColor(parent.modelData / 100)
                    }
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

            SpanCaption {
              visible: isFinite(Service.cpuTempC)
              prefix: "Temperature · "
            }

            Sparkline {
              visible: isFinite(Service.cpuTempC)
              width: parent.width
              values: root.histFor(Service.cpuTempHist, "cpuTemp")
              maxValue: 100
              markers: root.alertMarkers(["cputemp"])
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
            id: memTab
            visible: root.tab === "MEM"
            // free(1)'s used / cache / free accounting, for the split bar.
            readonly property var split: Model.memBreakdown(Service.memInfo)
            readonly property string swapKind: Model.swapNote(Service.swaps)
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
              values: root.histFor(Service.memHist, "mem")
              maxValue: 100
              markers: root.alertMarkers(["ram"])
            }

            SpanCaption {}

            // Where the memory actually is: in use, reclaimable cache, free.
            Rectangle {
              width: parent.width
              height: Style.space(6)
              radius: height / 2
              color: Qt.alpha(root.foreground, 0.12)
              clip: true

              Row {
                anchors.fill: parent

                Rectangle {
                  width: parent.width * memTab.split.used / Math.max(1, memTab.split.total)
                  height: parent.height
                  color: Color.accent
                }

                Rectangle {
                  width: parent.width * memTab.split.cache / Math.max(1, memTab.split.total)
                  height: parent.height
                  color: Qt.alpha(root.foreground, 0.35)
                }
              }
            }

            Flow {
              width: parent.width
              spacing: Style.space(14)

              MemLegend { swatch: Color.accent; text: "In use " + Model.fmtBytes(memTab.split.used) }
              MemLegend { swatch: Qt.alpha(root.foreground, 0.35); text: "Cache " + Model.fmtBytes(memTab.split.cache) }
              MemLegend { swatch: Qt.alpha(root.foreground, 0.12); text: "Free " + Model.fmtBytes(memTab.split.free) }
            }

            Text {
              width: parent.width
              text: "Cache is reclaimable — the kernel hands it back the moment a program needs the memory."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            MeterRow {
              visible: Service.swapTotal > 0
              label: "Swap" + (memTab.swapKind !== "" ? " (" + memTab.swapKind + ")" : "")
                + " · " + Model.fmtBytes(Service.swapUsed) + " of " + Model.fmtBytes(Service.swapTotal)
              value: Model.fmtPct(Service.swapPct)
              fraction: Service.swapPct / 100
            }

            DetailRow {
              label: "Available"
              value: Service.ready ? Model.fmtBytes(Service.memTotal - Service.memUsed) : ""
            }

            DetailRow {
              label: "Dirty (waiting for disk)"
              value: Service.memInfo.dirty > 0 ? Model.fmtBytes(Service.memInfo.dirty) : ""
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
              model: Model.primaryFirstGpus(Service.gpus)

              Column {
                id: gpuBlock
                required property var modelData
                required property int index
                readonly property bool isPrimary: Service.primaryGpu && Service.primaryGpu.card === modelData.card
                width: parent.width
                spacing: Style.space(6)

                PanelSeparator {
                  visible: gpuBlock.index > 0
                  foreground: root.foreground
                }

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
                  values: root.histFor(Service.gpuHist, "gpu")
                  maxValue: 100
                  markers: root.alertMarkers(["gpu", "gputemp", "vram"])
                }

                SpanCaption {
                  visible: gpuBlock.isPrimary && !modelData.asleep && isFinite(modelData.busy)
                }

                // An APU's "VRAM" is only the BIOS carve-out; its real
                // ceiling adds GTT (shared system RAM), so meter the pool
                // and break down where it comes from.
                MeterRow {
                  visible: !modelData.asleep && Model.gpuMemTotal(modelData) > 0
                  label: (modelData.apu ? "Memory · " : "VRAM · ")
                    + Model.fmtBytes(Model.gpuMemUsed(modelData)) + " of " + Model.fmtBytes(Model.gpuMemTotal(modelData))
                  value: Model.gpuMemTotal(modelData) > 0 ? Model.fmtPct(100 * Model.gpuMemUsed(modelData) / Model.gpuMemTotal(modelData)) : ""
                  fraction: Model.gpuMemTotal(modelData) > 0 ? Model.gpuMemUsed(modelData) / Model.gpuMemTotal(modelData) : 0
                }

                // The pool's two halves, with used figures — these are the
                // numbers radeontop/sysfs show, so users can reconcile
                // them. A near-full carve-out is normal on an APU: the
                // driver spills to GTT transparently.
                DetailRow {
                  label: "VRAM (reserved carve-out)"
                  value: modelData.apu === true
                    ? Model.fmtBytes(modelData.vramUsed) + " of " + Model.fmtBytes(modelData.vramTotal)
                    : ""
                }

                DetailRow {
                  label: "GTT (shared system RAM)"
                  value: modelData.apu === true
                    ? Model.fmtBytes(modelData.gttUsed) + " of " + Model.fmtBytes(modelData.gttTotal)
                    : ""
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

                // This card's busiest DRM clients (fdinfo; drivers without
                // usage stats — proprietary NVIDIA — simply list nothing).
                readonly property var procs: {
                  var pdev = Service.gpuPdev[modelData.card]
                  if (!pdev) return []
                  var rows = []
                  for (var i = 0; i < Service.gpuProcs.length; i++) {
                    var p = Service.gpuProcs[i]
                    if (p.pdev !== pdev) continue
                    if (p.pct < 0.5 && p.vramKib < 51200) continue
                    rows.push(p)
                    if (rows.length >= 6) break
                  }
                  return rows
                }

                PanelSectionHeader {
                  visible: gpuBlock.procs.length > 0
                  text: "TOP PROCESSES"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Repeater {
                  model: gpuBlock.procs

                  DetailRow {
                    required property var modelData
                    label: modelData.comm + " · " + modelData.pid
                    value: Model.fmtPct(modelData.pct) + " · " + Model.fmtBytes(modelData.vramKib * 1024)
                  }
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
                id: diskBlock
                required property var modelData
                required property int index
                width: parent.width
                spacing: Style.space(6)

                PanelSeparator {
                  visible: diskBlock.index > 0
                  foreground: root.foreground
                }

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

            SpanCaption {
              prefix: "Read · session peak " + Model.fmtBytes(Service.peakIoRead) + "/s · "
            }

            Sparkline {
              width: parent.width
              values: root.histFor(Service.ioReadHist, "ioRead")
              heat: false
              peakValue: Service.peakIoRead
            }

            SpanCaption {
              prefix: "Write · session peak " + Model.fmtBytes(Service.peakIoWrite) + "/s · "
            }

            Sparkline {
              width: parent.width
              values: root.histFor(Service.ioWriteHist, "ioWrite")
              heat: false
              peakValue: Service.peakIoWrite
            }

            Repeater {
              model: Service.ioDisks

              DetailRow {
                required property var modelData
                label: modelData.model !== "" ? modelData.model + " · " + modelData.dev : modelData.dev
                value: "R " + Model.fmtBytes(modelData.read) + "/s · W " + Model.fmtBytes(modelData.write) + "/s"
              }
            }

            PanelSectionHeader {
              visible: Service.driveHealth.length > 0
              text: "DRIVE HEALTH"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.driveHealth

              DetailRow {
                required property var modelData
                label: modelData.model !== "" ? modelData.model + " · " + modelData.dev : modelData.dev
                value: Model.fmtDriveHealth(modelData)
                urgent: Model.driveHealthBad(modelData, root.thresholds.wearPct)
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
              value: Service.ready ? "\u{f0045} " + Model.fmtBytes(Service.netDown) + "/s · \u{f005d} " + Model.fmtBytes(Service.netUp) + "/s" : ""
            }

            SpanCaption {
              prefix: "Download · session peak " + Model.fmtBytes(Service.peakNetDown) + "/s · "
            }

            Sparkline {
              width: parent.width
              values: root.histFor(Service.netDownHist, "netDown")
              heat: false
              peakValue: Service.peakNetDown
            }

            SpanCaption {
              prefix: "Upload · session peak " + Model.fmtBytes(Service.peakNetUp) + "/s · "
            }

            Sparkline {
              width: parent.width
              values: root.histFor(Service.netUpHist, "netUp")
              heat: false
              peakValue: Service.peakNetUp
            }

            Repeater {
              model: Service.netIfaces

              DetailRow {
                required property var modelData
                // Identity from the panel-only NETINFO sample: kind icon,
                // Wi-Fi SSID, IPv4 address.
                readonly property var info: Service.netInfo[modelData.iface]
                readonly property string detail: Model.netIfaceDetail(info)
                visible: modelData.total > 0
                label: (Model.NET_KIND_ICONS[(info && info.kind) || (modelData.virtual ? "virtual" : "eth")] || "") + "  "
                  + modelData.iface
                  + (detail !== "" ? " · " + detail : "")
                  + (modelData.virtual ? " · virtual, not in totals" : "")
                value: "\u{f0045} " + Model.fmtBytes(modelData.down) + "/s · \u{f005d} " + Model.fmtBytes(modelData.up) + "/s"
              }
            }
          }

          // ---- Processes tab: the full table — filter, sortable columns,
          // keyboard cursor, expandable rows, terminate/kill.
          Column {
            visible: root.tab === "PROC"
            width: parent.width
            spacing: Style.space(6)

            TextField {
              id: procFilterInput
              width: parent.width
              placeholderText: "Filter by name, user, or pid — press /"
              foreground: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              onTextChanged: {
                if (root.procFilter !== text) {
                  root.procFilter = text
                  root.procCursor = -1
                }
              }
              onActiveFocusChanged: root.procFilterFocused = activeFocus
              Component.onCompleted: root.procFilterField = procFilterInput
              Keys.onEscapePressed: {
                text = ""
                keyCatcher.forceActiveFocus()
              }
              Keys.onReturnPressed: keyCatcher.forceActiveFocus()

              // Esc clears the filter from the catcher's side too; keep
              // the field's text in sync with the property.
              Connections {
                target: root
                function onProcFilterChanged() {
                  if (procFilterInput.text !== root.procFilter) procFilterInput.text = root.procFilter
                }
              }
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)

              ProcHeader { sortKey: "name"; title: "NAME"; Layout.fillWidth: true }
              ProcHeader { sortKey: "pid"; title: "PID"; Layout.preferredWidth: Style.space(52); alignRight: true }
              ProcHeader { sortKey: "mem"; title: "MEM"; Layout.preferredWidth: Style.space(56); alignRight: true }
              ProcHeader { sortKey: "cpu"; title: "CPU"; Layout.preferredWidth: Style.space(46); alignRight: true }
            }

            Column {
              width: parent.width
              spacing: 0

              Repeater {
                id: procRepeater
                model: root.procView.rows

                Column {
                  id: procRow
                  required property var modelData
                  required property int index
                  readonly property bool current: root.procCursor === index
                  readonly property bool expanded: root.expandedProc === modelData.pid
                  width: parent.width

                  Rectangle {
                    width: parent.width
                    height: rowLine.implicitHeight + Style.space(6)
                    radius: Style.space(3)
                    color: procRow.current ? Qt.alpha(root.foreground, 0.08) : "transparent"

                    MouseArea {
                      anchors.fill: parent
                      cursorShape: Qt.PointingHandCursor
                      onClicked: {
                        root.procCursor = procRow.index
                        root.expandedProc = procRow.expanded ? "" : procRow.modelData.pid
                      }
                    }

                    RowLayout {
                      id: rowLine
                      anchors.fill: parent
                      anchors.leftMargin: Style.space(4)
                      anchors.rightMargin: Style.space(4)
                      spacing: Style.space(8)

                      Text {
                        Layout.fillWidth: true
                        text: Model.procDisplay(procRow.modelData.comm)
                        textFormat: Text.PlainText
                        color: procRow.current ? root.foreground : root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        elide: Text.ElideRight
                      }

                      Text {
                        textFormat: Text.PlainText
                        Layout.preferredWidth: Style.space(52)
                        text: procRow.modelData.pid
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        horizontalAlignment: Text.AlignRight
                      }

                      Text {
                        textFormat: Text.PlainText
                        Layout.preferredWidth: Style.space(56)
                        text: Model.fmtBytes(Service.memTotal * procRow.modelData.mem / 100)
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        horizontalAlignment: Text.AlignRight
                      }

                      Text {
                        textFormat: Text.PlainText
                        Layout.preferredWidth: Style.space(46)
                        text: procRow.modelData.cpu.toFixed(1) + "%"
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        horizontalAlignment: Text.AlignRight
                      }
                    }
                  }

                  // Expanded detail: the full command line, ownership, and
                  // the kill actions (confirmed before anything is sent).
                  Column {
                    visible: procRow.expanded
                    width: parent.width
                    spacing: Style.space(4)
                    leftPadding: Style.space(8)
                    rightPadding: Style.space(4)
                    bottomPadding: Style.space(6)

                    Text {
                      width: parent.width - parent.leftPadding - parent.rightPadding
                      text: procRow.modelData.comm
                      textFormat: Text.PlainText
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      wrapMode: Text.WrapAnywhere
                    }

                    RowLayout {
                      width: parent.width - parent.leftPadding - parent.rightPadding
                      spacing: Style.space(8)

                      Text {
                        Layout.fillWidth: true
                        text: (procRow.modelData.user !== "" ? procRow.modelData.user : "—")
                          + (procRow.modelData.threads > 0 ? " · " + procRow.modelData.threads + " threads" : "")
                        textFormat: Text.PlainText
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        elide: Text.ElideRight
                      }

                      Button {
                        text: "Terminate"
                        bordered: true
                        foreground: root.foreground
                        fontFamily: root.fontFamily
                        fontSize: Style.font.caption
                        onClicked: root.armKill(procRow.modelData, "TERM")
                      }

                      Button {
                        text: "Kill −9"
                        bordered: true
                        foreground: root.urgent
                        fontFamily: root.fontFamily
                        fontSize: Style.font.caption
                        onClicked: root.armKill(procRow.modelData, "KILL")
                      }
                    }
                  }
                }
              }
            }

            Text {
              visible: root.procView.hidden > 0
              width: parent.width
              text: root.procView.hidden + " more not shown · refine the filter"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "/ filter · j/k move · enter expand · x terminate · click headers to sort"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }
          }

          // ---- Temperatures tab
          Column {
            visible: root.tab === "TEMP"
            width: parent.width
            spacing: Style.space(8)

            // Sensors grouped by physical device: one header per device
            // ("NVMe · KINGSTON SNV3S1000G"), just the sensor label per row —
            // Super I/O chips would otherwise repeat their name a dozen times.
            Repeater {
              model: Model.groupTemps(Service.temps)

              Column {
                id: tempGroup
                required property var modelData
                // A group whose rows are all hidden hides its header too.
                readonly property bool anyVisible: {
                  if (root.showHiddenSensors) return true
                  for (var i = 0; i < modelData.sensors.length; i++) {
                    if (root.hiddenSensors.indexOf(Model.sensorKey(modelData.sensors[i])) === -1) return true
                  }
                  return false
                }
                visible: anyVisible
                width: parent.width
                spacing: Style.space(4)

                PanelSectionHeader {
                  text: tempGroup.modelData.title
                  textFormat: Text.PlainText
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                Repeater {
                  model: tempGroup.modelData.sensors

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
                        text: Model.sensorRowLabel(sensorRow.modelData)
                        textFormat: Text.PlainText
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                        elide: Text.ElideRight
                      }

                      Text {
                        visible: isFinite(sensorRow.limit) && !sensorRow.editing
                        text: "alert " + root.fmtLimitTemp(sensorRow.limit)
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                      }

                      Text {
                        textFormat: Text.PlainText
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
                        text: root.fmtLimitTemp(sensorRow.limit)
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
              text: "\u{f009a} sets a per-sensor alert threshold — the row turns urgent and a notification fires when it stays above the limit; armed sensors are listed in the ALERTS tab. \u{f0209} hides a sensor row (thresholds keep alerting)."
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
                required property int index
                readonly property real pct: modelData.energyFullWh > 0
                  ? 100 * modelData.energyNowWh / modelData.energyFullWh
                  : modelData.capacity
                width: parent.width
                spacing: Style.space(6)

                PanelSeparator {
                  visible: batteryBlock.index > 0
                  foreground: root.foreground
                }

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
            visible: root.tab === "SETUP"
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

                // Arrows keep their slot even when hidden so every label
                // starts at the same x — flat rows make ragged indents loud.
                PanelActionButton {
                  opacity: metricRow.isShown ? 1 : 0
                  enabled: metricRow.isShown && metricRow.shownIndex > 0
                  iconText: "\u{f005d}"
                  tooltipText: "Move up"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  size: Style.space(24)
                  onClicked: root.moveMetric(metricRow.modelData.key, -1)
                }

                PanelActionButton {
                  opacity: metricRow.isShown ? 1 : 0
                  enabled: metricRow.isShown && metricRow.shownIndex < root.shownKeys.length - 1
                  iconText: "\u{f0045}"
                  tooltipText: "Move down"
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  size: Style.space(24)
                  onClicked: root.moveMetric(metricRow.modelData.key, 1)
                }

                // Fixed icon column; metrics whose bar segment composes its
                // own glyphs (net, battery) fall back to their listIcon.
                Text {
                  textFormat: Text.PlainText
                  Layout.preferredWidth: Style.space(24)
                  text: metricRow.modelData.icon !== "" ? metricRow.modelData.icon : (metricRow.modelData.listIcon || "")
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.toggleMetric(metricRow.modelData.key)
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  Layout.fillWidth: true
                  text: metricRow.modelData.label
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.toggleMetric(metricRow.modelData.key)
                  }
                }

                ToggleSwitch {
                  checked: metricRow.isShown
                  foreground: root.foreground
                  accent: Color.accent
                  onToggled: root.toggleMetric(metricRow.modelData.key)
                }
              }
            }

            PanelSectionHeader {
              text: "SHOW ON HOME"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.homeTileRows

              RowLayout {
                id: homeConfigRow
                required property var modelData
                width: parent.width
                spacing: Style.space(4)

                Text {
                  textFormat: Text.PlainText
                  Layout.preferredWidth: Style.space(24)
                  text: homeConfigRow.modelData.icon
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  horizontalAlignment: Text.AlignHCenter
                }

                Text {
                  textFormat: Text.PlainText
                  Layout.fillWidth: true
                  text: homeConfigRow.modelData.label
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                ToggleSwitch {
                  checked: root.enabledHomeTiles.indexOf(homeConfigRow.modelData.key) !== -1
                  foreground: root.foreground
                  accent: Color.accent
                  onToggled: root.toggleHomeTile(homeConfigRow.modelData.key)
                }
              }
            }

            PanelSectionHeader {
              text: "PANEL"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)

              Text {
                Layout.fillWidth: true
                text: "Fahrenheit temperatures"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              ToggleSwitch {
                checked: root.setting("tempUnit", "C") === "F"
                foreground: root.foreground
                accent: Color.accent
                onToggled: root.persistPluginSetting("tempUnit", root.setting("tempUnit", "C") === "F" ? "C" : "F")
              }
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)

              Text {
                Layout.fillWidth: true
                text: "Refresh interval"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              PanelActionButton {
                iconText: "\u{f0374}"
                tooltipText: "-1s"
                enabled: Service.intervalSec > 1
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                size: Style.space(22)
                onClicked: root.persistPluginSetting("intervalSec", Math.max(1, Service.intervalSec - 1))
              }

              Text {
                textFormat: Text.PlainText
                text: Service.intervalSec + "s"
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
              }

              PanelActionButton {
                iconText: "\u{f0415}"
                tooltipText: "+1s"
                enabled: Service.intervalSec < 60
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.bodySmall
                size: Style.space(22)
                onClicked: root.persistPluginSetting("intervalSec", Math.min(60, Service.intervalSec + 1))
              }
            }

            Text {
              textFormat: Text.PlainText
              visible: Service.avgSampleMs > 0
              width: parent.width
              text: "Argus's own cost: sampling takes ~" + Math.round(Service.avgSampleMs)
                + " ms of each " + Service.intervalSec + "s tick (last " + Math.round(Service.lastSampleMs) + " ms)"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              width: parent.width
              text: "Bar order follows this list · segments turn urgent past the thresholds in the ALERTS tab"
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

          // ---- Power tab: measured draw per source and session energy.
          Column {
            visible: root.tab === "PWR"
            width: parent.width
            spacing: Style.space(8)

            PanelSectionHeader {
              text: "POWER DRAW"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Service.raplWatts

              DetailRow {
                required property var modelData
                label: Model.raplLabel(modelData.name)
                value: isFinite(modelData.watts) ? Model.fmtWatts(modelData.watts) : ""
              }
            }

            Text {
              visible: Service.raplRestricted && Service.raplWatts.length === 0
              width: parent.width
              text: "CPU package power (RAPL) exists on this machine, but the kernel keeps its counters root-only (a side-channel mitigation). A one-line udev rule unlocks read access — see the Argus README, section Power."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: Service.gpus

              DetailRow {
                required property var modelData
                label: modelData.label + (modelData.name !== "" ? " · " + modelData.name : "")
                value: !modelData.asleep && isFinite(modelData.powerW) && modelData.powerW > 0 ? Model.fmtWatts(modelData.powerW) : ""
              }
            }

            DetailRow {
              label: Service.battery && Service.battery.charging ? "Battery (charging)" : "Battery draw"
              value: Service.battery && Service.battery.watts > 0 ? Model.fmtWatts(Service.battery.watts) : ""
            }

            SpanCaption {
              visible: Service.peakCpuPower > 0
              prefix: "CPU package · session peak " + Model.fmtWatts(Service.peakCpuPower) + " · "
            }

            Sparkline {
              visible: Service.peakCpuPower > 0
              width: parent.width
              values: root.histFor(Service.cpuPowerHist, "cpuPower")
              heat: false
              peakValue: Service.peakCpuPower
            }

            SpanCaption {
              visible: Service.peakGpuPower > 0
              prefix: "GPU (primary) · session peak " + Model.fmtWatts(Service.peakGpuPower) + " · "
            }

            Sparkline {
              visible: Service.peakGpuPower > 0
              width: parent.width
              values: root.histFor(Service.gpuPowerHist, "gpuPower")
              heat: false
              peakValue: Service.peakGpuPower
            }

            PanelSectionHeader {
              visible: Model.fmtWh(Service.cpuEnergyWh) !== "" || Model.fmtWh(Service.gpuEnergyWh) !== ""
              text: "SESSION ENERGY"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            DetailRow {
              label: "CPU package"
              value: Model.fmtWh(Service.cpuEnergyWh)
            }

            DetailRow {
              label: "GPU (primary)"
              value: Model.fmtWh(Service.gpuEnergyWh)
            }

            Text {
              visible: Model.fmtWh(Service.cpuEnergyWh) !== "" || Model.fmtWh(Service.gpuEnergyWh) !== ""
              width: parent.width
              text: "Energy since the shell started, integrated from measured draw."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- Game tab: the in-game HUD's control room. Argus renders a
          // managed MangoHud config and reloads running games live.
          Column {
            visible: root.tab === "GAME"
            width: parent.width
            spacing: Style.space(8)

            Text {
              visible: !Service.mangohudInstalled
              width: parent.width
              text: "MangoHud is not installed — the in-game HUD needs it: sudo pacman -S mangohud"
              textFormat: Text.PlainText
              color: root.urgent
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)

              Text {
                Layout.fillWidth: true
                text: "In-game HUD (MangoHud)"
                textFormat: Text.PlainText
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
              }

              // A looping Vulkan test pattern with the HUD injected —
              // every tweak below restyles it live, no game needed.
              Button {
                visible: Service.mpvInstalled && Service.mangohudInstalled
                enabled: Service.mango.enabled
                text: "Test window"
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                // The app-id reaches the script only via "$2", so the
                // guard's own command line never contains the expanded
                // "wayland-app-id=<id>" it greps for — only the running
                // mpv does. (An inline literal made every click match
                // itself and exit before launching.)
                onClicked: Quickshell.execDetached(["sh", "-c",
                  'pgrep -f "wayland-app-id=$2" >/dev/null && exit 0; exec env -u DISABLE_MANGOHUD MANGOHUD=1 MANGOHUD_CONFIGFILE="$1" mpv --loop=inf --really-quiet --wayland-app-id="$2" --geometry=960x540 --vo=gpu-next --gpu-api=vulkan "av://lavfi:testsrc2=size=960x540:rate=60"',
                  "argus-preview", Service.mangoConfPath, "argus-hud-preview"])
              }

              ToggleSwitch {
                checked: Service.mango.enabled
                foreground: root.foreground
                accent: Color.accent
                onToggled: root.setMango("enabled", !Service.mango.enabled)
              }
            }

            Text {
              visible: Service.mango.enabled && !Service.mangoInjectionReady
              width: parent.width
              text: "One-time setup — add to ~/.config/hypr/hyprland.lua, then run `hyprctl reload` (this status updates after the shell restarts):\n"
                + "hl.env(\"MANGOHUD_CONFIGFILE\", os.getenv(\"HOME\") .. \"/.local/state/argus/mangohud.conf\")\n"
                + "Do NOT set MANGOHUD=1 globally — the layer would load into every Vulkan app, the shell included. Enable per game instead (below)."
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WrapAnywhere
            }

            Text {
              visible: Service.mango.enabled && Service.mangoInjectionReady
              width: parent.width
              text: "Config path active. Per game, set Steam Launch Options to: MANGOHUD=1 %command% — the HUD appears with this styling; toggle in-game with " + Service.mango.hotkey + "."
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            PanelSectionHeader {
              text: "METRICS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: Model.MANGO_METRICS

              MangoToggle {
                required property var modelData
                label: modelData.label
                checked: Service.mango.metrics.indexOf(modelData.key) !== -1
                onFlip: root.toggleMangoMetric(modelData.key)
              }
            }

            PanelSectionHeader {
              text: "LABELS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            MangoField {
              label: "CPU label"
              value: Service.mango.cpuText
              placeholder: "e.g. 9700X"
              settingKey: "cpuText"
            }

            MangoField {
              label: "GPU label"
              value: Service.mango.gpuText
              placeholder: "e.g. RX 9070"
              settingKey: "gpuText"
            }

            PanelSectionHeader {
              text: "APPEARANCE"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Text {
              width: parent.width
              text: "Position"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Flow {
              width: parent.width
              spacing: Style.space(4)

              Repeater {
                model: Model.MANGO_POSITIONS

                Button {
                  required property string modelData
                  text: modelData
                  selected: Service.mango.position === modelData
                  bordered: true
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  fontSize: Style.font.caption
                  onClicked: root.setMango("position", modelData)
                }
              }
            }

            MangoStepper {
              label: "Font size"
              display: Service.mango.fontSize + "px"
              canDec: Service.mango.fontSize > 12
              canInc: Service.mango.fontSize < 48
              onDec: root.setMango("fontSize", Service.mango.fontSize - 2)
              onInc: root.setMango("fontSize", Service.mango.fontSize + 2)
            }

            MangoStepper {
              label: "Background opacity"
              display: Math.round(Service.mango.bgAlpha * 100) + "%"
              canDec: Service.mango.bgAlpha > 0
              canInc: Service.mango.bgAlpha < 1
              onDec: root.setMango("bgAlpha", Math.round((Service.mango.bgAlpha - 0.1) * 10) / 10)
              onInc: root.setMango("bgAlpha", Math.round((Service.mango.bgAlpha + 0.1) * 10) / 10)
            }

            MangoStepper {
              label: "Table columns"
              display: String(Service.mango.tableColumns)
              canDec: Service.mango.tableColumns > 1
              canInc: Service.mango.tableColumns < 6
              onDec: root.setMango("tableColumns", Service.mango.tableColumns - 1)
              onInc: root.setMango("tableColumns", Service.mango.tableColumns + 1)
            }

            MangoStepper {
              label: "Round corners"
              display: Service.mango.roundCorners + "px"
              canDec: Service.mango.roundCorners > 0
              canInc: Service.mango.roundCorners < 20
              onDec: root.setMango("roundCorners", Service.mango.roundCorners - 2)
              onInc: root.setMango("roundCorners", Service.mango.roundCorners + 2)
            }

            MangoStepper {
              label: "Offset X"
              display: Service.mango.offsetX + "px"
              canDec: Service.mango.offsetX > 0
              canInc: Service.mango.offsetX < 4000
              onDec: root.setMango("offsetX", Math.max(0, Service.mango.offsetX - 25))
              onInc: root.setMango("offsetX", Service.mango.offsetX + 25)
            }

            MangoStepper {
              label: "Offset Y"
              display: Service.mango.offsetY + "px"
              canDec: Service.mango.offsetY > 0
              canInc: Service.mango.offsetY < 4000
              onDec: root.setMango("offsetY", Math.max(0, Service.mango.offsetY - 25))
              onInc: root.setMango("offsetY", Service.mango.offsetY + 25)
            }

            MangoStepper {
              label: "FPS limit"
              display: Service.mango.fpsLimit === 0 ? "off" : Service.mango.fpsLimit + " fps"
              canDec: Model.MANGO_FPS_LIMITS.indexOf(Service.mango.fpsLimit) > 0
              canInc: Model.MANGO_FPS_LIMITS.indexOf(Service.mango.fpsLimit) < Model.MANGO_FPS_LIMITS.length - 1
              onDec: root.setMango("fpsLimit", Model.stepFpsLimit(Service.mango.fpsLimit, -1))
              onInc: root.setMango("fpsLimit", Model.stepFpsLimit(Service.mango.fpsLimit, 1))
            }

            MangoStepper {
              label: "FPS red below"
              display: String(Service.mango.fpsLow)
              canDec: Service.mango.fpsLow > 10
              canInc: Service.mango.fpsLow < Service.mango.fpsHigh - 5
              onDec: root.setMango("fpsLow", Service.mango.fpsLow - 5)
              onInc: root.setMango("fpsLow", Service.mango.fpsLow + 5)
            }

            MangoStepper {
              label: "FPS green above"
              display: String(Service.mango.fpsHigh)
              canDec: Service.mango.fpsHigh > Service.mango.fpsLow + 5
              canInc: Service.mango.fpsHigh < 500
              onDec: root.setMango("fpsHigh", Service.mango.fpsHigh - 5)
              onInc: root.setMango("fpsHigh", Service.mango.fpsHigh + 5)
            }

            MangoToggle {
              label: "Horizontal layout"
              checked: Service.mango.horizontal
              onFlip: root.setMango("horizontal", !Service.mango.horizontal)
            }

            MangoToggle {
              label: "Compact layout"
              checked: Service.mango.compact
              onFlip: root.setMango("compact", !Service.mango.compact)
            }

            MangoToggle {
              label: "Match Omarchy theme colors"
              checked: Service.mango.themed
              onFlip: root.setMango("themed", !Service.mango.themed)
            }

            MangoToggle {
              label: "Start hidden — summon with the hotkey"
              checked: Service.mango.startHidden
              onFlip: root.setMango("startHidden", !Service.mango.startHidden)
            }

            MangoField {
              label: "Toggle hotkey"
              value: Service.mango.hotkey
              placeholder: "Shift_R+F12"
              settingKey: "hotkey"
            }

            Text {
              width: parent.width
              text: "Changes apply live to running games. Argus writes its own config ("
                + Service.mangoConfPath.replace(/^\/home\/[^/]+/, "~")
                + ") and never touches your MangoHud.conf. Theme colors follow the shell theme, in-game too."
              textFormat: Text.PlainText
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }

          // ---- Alerts tab: per-metric opt-in toggles, thresholds, and the
          // session's fired-alert log.
          Column {
            visible: root.tab === "ALERTS"
            width: parent.width
            spacing: Style.space(8)

            // One row per alert, grouped under USAGE / TEMPERATURE /
            // HEALTH headers: threshold caption, inline stepper, and the
            // opt-in toggle. Everything is off by default — the threshold
            // still colors bar segments urgent; the toggle adds the
            // notification.
            Repeater {
              model: root.alertRows

              Column {
                id: alertRow
                required property var modelData
                readonly property var entry: modelData.entry
                readonly property bool on: root.enabledAlerts.indexOf(entry.key) !== -1
                readonly property real limit: root.thresholds[entry.thKey]
                readonly property bool editing: root.editingAlert === entry.key
                width: parent.width
                spacing: Style.space(4)

                PanelSectionHeader {
                  visible: alertRow.modelData.header !== ""
                  text: alertRow.modelData.header
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                }

                RowLayout {
                  width: parent.width
                  spacing: Style.space(8)

                  Text {
                    textFormat: Text.PlainText
                    Layout.fillWidth: true
                    text: alertRow.entry.label
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }

                  // The live reading beside the threshold, so the stepper
                  // is set against reality instead of blind.
                  Text {
                    readonly property string now: Model.alertNowText(alertRow.entry, Service.barData, Service.driveHealth)
                    visible: now !== ""
                    text: "now " + now
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  Text {
                    textFormat: Text.PlainText
                    text: Model.alertLimitText(alertRow.entry, root.thresholds)
                    color: alertRow.on ? Color.accent : root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }

                  PanelActionButton {
                    iconText: "\u{f009a}"
                    tooltipText: "Edit threshold"
                    foreground: alertRow.editing ? Color.accent : root.dim
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.editingAlert = alertRow.editing ? "" : alertRow.entry.key
                  }

                  ToggleSwitch {
                    checked: alertRow.on
                    foreground: root.foreground
                    accent: Color.accent
                    onToggled: root.toggleAlert(alertRow.entry.key)
                  }
                }

                RowLayout {
                  visible: alertRow.editing
                  anchors.right: parent.right
                  spacing: Style.space(6)

                  Text {
                    textFormat: Text.PlainText
                    text: (alertRow.entry.low ? "Alert below" : "Alert above")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  PanelActionButton {
                    iconText: "\u{f0374}"
                    tooltipText: "-" + alertRow.entry.step
                    enabled: alertRow.limit > alertRow.entry.min
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.stepAlert(alertRow.entry, -1)
                  }

                  Text {
                    textFormat: Text.PlainText
                    text: alertRow.entry.unit === "°" ? root.fmtLimitTemp(alertRow.limit) : alertRow.limit + alertRow.entry.unit
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                  }

                  PanelActionButton {
                    iconText: "\u{f0415}"
                    tooltipText: "+" + alertRow.entry.step
                    enabled: alertRow.limit < alertRow.entry.max
                    foreground: root.foreground
                    fontFamily: root.fontFamily
                    fontSize: Style.font.bodySmall
                    size: Style.space(22)
                    onClicked: root.stepAlert(alertRow.entry, 1)
                  }
                }
              }
            }

            Text {
              width: parent.width
              text: "Alerts are off by default. A toggled-on alert notifies after its metric stays past the threshold for 3 ticks (5-minute cooldown). Thresholds color bar segments urgent whether or not the alert is on."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            // Per-sensor alerts armed from the TEMP tab, listed here so
            // this tab is the one complete view of everything armed.
            PanelSectionHeader {
              visible: root.sensorAlerts.length > 0
              text: "SENSOR ALERTS"
              foreground: root.foreground
              fontFamily: root.fontFamily
            }

            Repeater {
              model: root.sensorAlerts

              RowLayout {
                id: sensorAlertRow
                required property var modelData
                width: parent.width
                spacing: Style.space(8)

                Text {
                  Layout.fillWidth: true
                  text: sensorAlertRow.modelData.label
                  textFormat: Text.PlainText
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }

                Text {
                  textFormat: Text.PlainText
                  visible: isFinite(sensorAlertRow.modelData.now)
                  text: "now " + Model.fmtTemp(sensorAlertRow.modelData.now)
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  textFormat: Text.PlainText
                  text: "≥ " + root.fmtLimitTemp(sensorAlertRow.modelData.limit)
                  color: Color.accent
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                PanelActionButton {
                  iconText: "\u{f009b}"
                  tooltipText: "Remove this sensor alert"
                  hoverColor: root.urgent
                  foreground: root.dim
                  fontFamily: root.fontFamily
                  fontSize: Style.font.bodySmall
                  size: Style.space(22)
                  onClicked: root.setSensorLimit(sensorAlertRow.modelData.key, NaN)
                }
              }
            }

            Text {
              visible: root.sensorAlerts.length > 0
              width: parent.width
              text: "Sensor alerts are armed from the TEMP tab — the \u{f009a} button on any sensor row."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }

            RowLayout {
              width: parent.width
              spacing: Style.space(8)

              PanelSectionHeader {
                Layout.fillWidth: true
                text: "RECENT ALERTS"
                foreground: root.foreground
                fontFamily: root.fontFamily
              }

              // The flight recorder's raw file, readable in place —
              // rings, alert log, context snapshots and all.
              Button {
                text: "Open log in nvim"
                bordered: true
                foreground: root.foreground
                fontFamily: root.fontFamily
                fontSize: Style.font.caption
                onClicked: {
                  // The launcher chain flattens its command to a string
                  // and re-splits it, eating quotes — so nvim gets exactly
                  // one spaceless argument: a pretty-printed copy in the
                  // runtime dir. -n -R: no swapfile, read-only, nothing
                  // to prompt about.
                  Quickshell.execDetached(["sh", "-c",
                    'view="${XDG_RUNTIME_DIR:-/tmp}/argus-history-view.json"; jq . "$1" > "$view" 2>/dev/null || cp "$1" "$view"; exec omarchy-launch-or-focus-tui --app-id=org.omarchy.argus-history nvim -n -R "$view"',
                    "argus-view", Service.historyPath])
                }
              }
            }

            Repeater {
              model: Service.alertLog

              Column {
                id: alertEntry
                required property var modelData
                readonly property bool hasCtx: modelData.ctx !== undefined && modelData.ctx !== null
                readonly property bool expanded: hasCtx && root.expandedAlertAt === modelData.at
                width: parent.width
                spacing: Style.space(2)

                Text {
                  width: parent.width
                  text: Qt.formatDateTime(new Date(alertEntry.modelData.at), "ddd HH:mm") + " · " + alertEntry.modelData.text
                  textFormat: Text.PlainText
                  color: alertEntry.expanded ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: alertEntry.hasCtx ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: {
                      if (alertEntry.hasCtx) root.expandedAlertAt = alertEntry.expanded ? 0 : alertEntry.modelData.at
                    }
                  }
                }

                // The context snapshot: what the system looked like the
                // moment this alert fired.
                Column {
                  visible: alertEntry.expanded
                  width: parent.width
                  leftPadding: Style.space(12)
                  spacing: Style.space(2)

                  Text {
                    width: parent.width - parent.leftPadding
                    text: "at that moment · " + Model.fmtAlertContext(alertEntry.modelData.ctx)
                    textFormat: Text.PlainText
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    wrapMode: Text.WordWrap
                  }

                  Repeater {
                    model: alertEntry.expanded ? alertEntry.modelData.ctx.procs : []

                    Text {
                      required property var modelData
                      width: parent.width - parent.leftPadding
                      text: Model.fmtAlertProc(modelData, Service.memTotal)
                      textFormat: Text.PlainText
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                      elide: Text.ElideRight
                    }
                  }
                }
              }
            }

            Text {
              visible: Service.alertLog.length === 0
              width: parent.width
              text: "No alerts have fired this session."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              horizontalAlignment: Text.AlignHCenter
            }

            Text {
              visible: Service.alertLog.length > 0
              width: parent.width
              text: "Click an alert to see what the system looked like when it fired. The log survives shell restarts."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
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

      // Thin scroll indicator so long tabs (TEMP, PROC) signal the content
      // below the fold. Lives outside the Flickable — its children scroll.
      Rectangle {
        visible: flick.contentHeight > flick.height
        readonly property real thumbHeight: Math.max(Style.space(24), flick.height * flick.height / Math.max(1, flick.contentHeight))
        readonly property real travel: Math.max(1, flick.contentHeight - flick.height)
        anchors.right: parent.right
        width: Style.space(3)
        radius: width / 2
        color: Qt.alpha(root.foreground, 0.25)
        height: thumbHeight
        y: flick.y + (flick.height - thumbHeight) * Math.max(0, Math.min(1, flick.contentY / travel))
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
          ? (root.pendingKill.sig === "KILL" ? "Force kill " : "Terminate ")
            + root.pendingKill.name + " (PID " + root.pendingKill.pid + ")?"
          : ""
        confirmText: root.pendingKill && root.pendingKill.sig === "KILL" ? "Kill −9" : "Terminate"
        fontFamily: root.fontFamily
        onCanceled: root.pendingKill = null
        onConfirmed: {
          Quickshell.execDetached(["kill", "-" + (root.pendingKill.sig || "TERM"), String(root.pendingKill.pid)])
          root.pendingKill = null
          killRefresh.restart()
        }
      }

      // Give the terminated process a beat to exit before resampling.
      Timer {
        id: killRefresh
        interval: 700
        onTriggered: Service.refresh(true)
      }
    }
  }

  // Sparkline caption that doubles as the history-span control: the
  // active span renders in the accent color, and clicking anywhere on
  // the caption cycles every chart through 2m → 1h → 24h. The peak rings
  // keep each slot's maximum, so spikes survive the zoom-out; the 24h
  // ring persists across shell restarts (the flight recorder).
  component SpanCaption: Text {
    property string prefix: ""
    readonly property string fineLabel: Model.fmtUptime(Model.HISTORY_LEN * Service.intervalSec)
    text: {
      var accent = root.colorHex(Color.accent)
      function seg(label, span) {
        return root.histSpan === span
          ? "<font color=\"" + accent + "\">" + label + "</font>"
          : label
      }
      return prefix + "last " + seg(fineLabel, "2m") + " · " + seg("1h", "1h") + " · " + seg("24h", "24h") + " peaks"
    }
    textFormat: Text.StyledText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.histSpan = Model.nextSpan(root.histSpan)
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
      textFormat: Text.PlainText
      foreground: root.foreground
      fontFamily: root.fontFamily
    }

    Text {
      visible: parent.name !== ""
      width: parent.width
      text: parent.name
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      wrapMode: Text.WordWrap
    }
  }

  // GAME-tab building blocks: a labeled toggle row, a labeled −/+
  // stepper, and a labeled text field that persists on editing-finished
  // and hands the keyboard back to the panel.
  component MangoToggle: RowLayout {
    id: mangoToggle
    required property string label
    required property bool checked
    signal flip()
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    Text {
      Layout.fillWidth: true
      text: mangoToggle.label
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    ToggleSwitch {
      checked: mangoToggle.checked
      foreground: root.foreground
      accent: Color.accent
      onToggled: mangoToggle.flip()
    }
  }

  component MangoStepper: RowLayout {
    id: mangoStepper
    required property string label
    required property string display
    property bool canDec: true
    property bool canInc: true
    signal dec()
    signal inc()
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    Text {
      Layout.fillWidth: true
      text: mangoStepper.label
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    PanelActionButton {
      iconText: "\u{f0374}"
      tooltipText: "Decrease"
      enabled: mangoStepper.canDec
      foreground: root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      size: Style.space(22)
      onClicked: mangoStepper.dec()
    }

    Text {
      text: mangoStepper.display
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    PanelActionButton {
      iconText: "\u{f0415}"
      tooltipText: "Increase"
      enabled: mangoStepper.canInc
      foreground: root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.bodySmall
      size: Style.space(22)
      onClicked: mangoStepper.inc()
    }
  }

  component MangoField: RowLayout {
    id: mangoField
    required property string label
    required property string value
    required property string settingKey
    property string placeholder: ""
    width: parent ? parent.width : 0
    spacing: Style.space(8)

    Text {
      Layout.fillWidth: true
      text: mangoField.label
      textFormat: Text.PlainText
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    TextField {
      id: mangoInput
      Layout.preferredWidth: Style.space(170)
      text: mangoField.value
      placeholderText: mangoField.placeholder
      foreground: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      onActiveFocusChanged: root.mangoFieldFocused = activeFocus
      onEditingFinished: {
        if (text !== mangoField.value) root.setMango(mangoField.settingKey, text)
      }
      Keys.onEscapePressed: {
        text = mangoField.value
        keyCatcher.forceActiveFocus()
      }
      Keys.onReturnPressed: keyCatcher.forceActiveFocus()
    }
  }

  // Legend chip for the memory split bar: color swatch + label.
  component MemLegend: Row {
    id: memLegend
    required property color swatch
    required property string text
    spacing: Style.space(5)

    Rectangle {
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(8)
      height: Style.space(8)
      radius: Style.space(2)
      color: memLegend.swatch
    }

    Text {
      text: memLegend.text
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // Clickable column header for the process table; the active sort column
  // reads in the accent color with a direction arrow.
  component ProcHeader: Text {
    id: procHeader
    required property string sortKey
    required property string title
    property bool alignRight: false
    readonly property bool active: root.procSort === sortKey
    text: title + (active ? (root.procSortAsc ? " ▴" : " ▾") : "")
    color: active ? Color.accent : root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    horizontalAlignment: alignRight ? Text.AlignRight : Text.AlignLeft

    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.setProcSort(procHeader.sortKey)
    }
  }

  component DetailRow: RowLayout {
    required property string label
    property string value: ""
    // Paints the value in the urgent color (drive health warnings, etc.).
    property bool urgent: false
    width: parent ? parent.width : 0
    visible: value !== ""
    spacing: Style.space(12)

    Text {
      Layout.fillWidth: true
      text: parent.label
      textFormat: Text.PlainText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Text {
      text: parent.value
      textFormat: Text.PlainText
      color: parent.urgent ? root.urgent : root.foreground
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
        textFormat: Text.PlainText
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        elide: Text.ElideRight
      }

      Text {
        text: meterRow.value
        textFormat: Text.PlainText
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
    property real maxValue: 0  // 0 = autoscale to the series peak
    property bool heat: true   // color bars by fraction; false = plain accent
    // Session peak of the series. When set it becomes the scale ceiling, so
    // the y-axis stays put as spikes scroll out of the window instead of
    // rescaling the whole chart every tick.
    property real peakValue: 0
    // Slots (back from the right edge) where an alert fired on this series;
    // each gets an urgent tick hanging from the top of the chart.
    property var markers: []
    height: Style.space(34)

    readonly property real peak: {
      if (maxValue > 0) return maxValue
      var m = 1
      for (var i = 0; i < values.length; i++) if (values[i] > m) m = values[i]
      return Math.max(m, peakValue)
    }
    readonly property real slot: width / Model.HISTORY_LEN

    Rectangle {
      anchors.fill: parent
      radius: Style.space(2)
      color: Qt.alpha(root.foreground, 0.07)
    }

    // Solid baseline; idle samples render nothing above it instead of the
    // dashed row of 2px stubs a per-bar minimum height would paint.
    Rectangle {
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      height: 1
      color: Qt.alpha(root.foreground, 0.25)
    }

    // The session-peak ceiling, when the chart is scaled by one.
    Rectangle {
      visible: spark.peakValue > 0
      anchors.left: parent.left
      anchors.right: parent.right
      y: 1 + (spark.height - 3) * (1 - Math.min(1, spark.peakValue / spark.peak))
      height: 1
      color: Qt.alpha(root.foreground, 0.18)
    }

    // Constant-count model: a fresh values array arrives every tick, and
    // a Repeater keyed on it would destroy and recreate all 60 bars each
    // time. With a fixed count the delegates are built once and only
    // their height/color bindings move.
    Repeater {
      model: Model.HISTORY_LEN

      Rectangle {
        required property int index
        // Right-aligned: the last value fills the last slot; slots before
        // the series started stay empty.
        readonly property int vIndex: index - (Model.HISTORY_LEN - spark.values.length)
        readonly property real value: vIndex >= 0 ? spark.values[vIndex] : 0
        readonly property real fraction: Math.max(0, Math.min(1, value / spark.peak))
        readonly property real rawHeight: (spark.height - 2) * fraction
        x: index * spark.slot
        anchors.bottom: parent.bottom
        anchors.bottomMargin: 1
        width: Math.max(1, spark.slot - 1)
        height: rawHeight < 1 ? 0 : Math.max(2, rawHeight)
        radius: 1
        color: spark.heat ? root.meterColor(fraction) : Color.accent
      }
    }

    Repeater {
      model: spark.markers

      // Foreground, not urgent: the marker usually sits on a bar that is
      // itself urgent-colored (that's why the alert fired), so the urgent
      // color would camouflage it.
      Rectangle {
        required property var modelData
        x: spark.width - (modelData + 1) * spark.slot
        y: 0
        width: Math.max(2, spark.slot - 1)
        height: Style.space(5)
        color: root.foreground
      }
    }
  }
}
