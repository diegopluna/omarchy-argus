import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Argus system-monitor bar widget: compact selectable metrics in the bar, a tabbed
// popup panel with the full picture, and per-metric toggles that persist to
// shell.json.
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
  // The placeholder icon also covers the not-yet-sampled window right after
  // the shell starts, so the widget is clickable from the first frame.
  readonly property string displayText: sys.ready ? Model.barText(shownKeys, sys.barData) : Model.PLACEHOLDER_ICON
  readonly property var verticalLines: sys.ready ? Model.barLines(shownKeys, sys.barData) : [Model.PLACEHOLDER_ICON]

  readonly property var tabs: ["CPU", "MEM", "GPU", "DISK", "NET", "TEMP", "BAR"]
  property string tab: "CPU"

  function switchTab(direction) {
    var index = (tabs.indexOf(tab) + direction + tabs.length) % tabs.length
    tab = tabs[index]
  }

  onTabChanged: flick.contentY = 0

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

  function meterColor(fraction) {
    return fraction >= 0.9 ? root.urgent : Color.accent
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onOpenedChanged: if (opened) {
    sys.refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  Service {
    id: sys
    settings: root.settings
  }

  IpcHandler {
    target: root.ipcTarget
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): string { sys.refresh(); return "ok" }
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
    labelVisible: !(root.bar && root.bar.vertical)
    hasVisualContent: root.bar && root.bar.vertical ? root.verticalLines.length > 0 : text !== ""
    fixedHeight: root.bar && root.bar.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1
    tooltipText: sys.ready
      ? sys.host + " · up " + Model.fmtUptime(sys.uptimeSec) + " · load " + sys.load1.toFixed(2)
      : "Argus"

    onPressed: function(b) {
      if (b === Qt.RightButton) { if (root.bar) root.bar.run("omarchy-launch-or-focus-tui btop") }
      else if (b === Qt.MiddleButton) sys.refresh()
      else root.toggle()
    }

    Column {
      visible: root.bar && root.bar.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          fontFamily: button.fontFamily
          fontSize: modelData.length > 3 ? button.fontSize * 0.85 : button.fontSize
          color: button.foreground
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
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(header.implicitHeight + Style.space(12) + flick.contentHeight, Style.space(560))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.switchTab(dx)
        else if (dy !== 0) flick.scrollBy(dy * Style.space(110))
      }
      onTextKey: function(text) {
        if (text === "r" || text === "R") sys.refresh()
      }

      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: sys.host !== "" ? sys.host : "Argus"
          meta: sys.ready
            ? "up " + Model.fmtUptime(sys.uptimeSec) + " · load " + sys.load1.toFixed(2) + " " + sys.load5.toFixed(2) + " " + sys.load15.toFixed(2)
            : "Gathering data…"
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
              onClicked: sys.refresh()
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
              name: sys.cpuName
            }

            MeterRow {
              label: "Usage"
              value: Model.fmtPct(sys.cpuPct)
              fraction: sys.cpuPct / 100
            }

            Text {
              text: sys.corePcts.length + " threads"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Flow {
              width: parent.width
              spacing: Style.space(3)

              Repeater {
                model: sys.corePcts

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
              value: sys.cpuMhz > 0 ? (sys.cpuMhz / 1000).toFixed(2) + " GHz" : ""
            }

            DetailRow {
              label: "Temperature"
              value: isFinite(sys.cpuTempC) ? Model.fmtTemp(sys.cpuTempC) : ""
            }

            DetailRow {
              label: "Load 1 / 5 / 15 min"
              value: sys.ready ? sys.load1.toFixed(2) + " / " + sys.load5.toFixed(2) + " / " + sys.load15.toFixed(2) : ""
            }

            DetailRow {
              label: "Uptime"
              value: sys.ready ? Model.fmtUptime(sys.uptimeSec) : ""
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
              label: "RAM · " + Model.fmtBytes(sys.memUsed) + " of " + Model.fmtBytes(sys.memTotal)
              value: Model.fmtPct(sys.memPct)
              fraction: sys.memPct / 100
            }

            MeterRow {
              visible: sys.swapTotal > 0
              label: "Swap · " + Model.fmtBytes(sys.swapUsed) + " of " + Model.fmtBytes(sys.swapTotal)
              value: Model.fmtPct(sys.swapPct)
              fraction: sys.swapPct / 100
            }

            DetailRow {
              label: "Available"
              value: sys.ready ? Model.fmtBytes(sys.memTotal - sys.memUsed) : ""
            }
          }

          // ---- GPU tab
          Column {
            visible: root.tab === "GPU"
            width: parent.width
            spacing: Style.space(10)

            Text {
              visible: sys.gpus.length === 0
              width: parent.width
              text: "No supported GPU detected (amdgpu sysfs or nvidia-smi)."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: sys.gpus

              Column {
                required property var modelData
                width: parent.width
                spacing: Style.space(6)

                NameHeader {
                  title: sys.primaryGpu && sys.primaryGpu.card === modelData.card && sys.gpus.length > 1
                    ? modelData.label + " · PRIMARY"
                    : modelData.label
                  name: modelData.name
                }

                MeterRow {
                  label: "Usage"
                  value: Model.fmtPct(modelData.busy)
                  fraction: (modelData.busy || 0) / 100
                }

                MeterRow {
                  visible: modelData.vramTotal > 0
                  label: "VRAM · " + Model.fmtBytes(modelData.vramUsed) + " of " + Model.fmtBytes(modelData.vramTotal)
                  value: modelData.vramTotal > 0 ? Model.fmtPct(100 * modelData.vramUsed / modelData.vramTotal) : ""
                  fraction: modelData.vramTotal > 0 ? modelData.vramUsed / modelData.vramTotal : 0
                }

                DetailRow {
                  label: "Temperature"
                  value: isFinite(modelData.celsius) ? Model.fmtTemp(modelData.celsius) : ""
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
              model: sys.disks

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
              value: sys.ready ? "\u{f0045} " + Model.fmtBytes(sys.netDown) + "/s   \u{f005d} " + Model.fmtBytes(sys.netUp) + "/s" : ""
            }

            Repeater {
              model: sys.netIfaces

              DetailRow {
                required property var modelData
                visible: modelData.total > 0
                label: modelData.iface
                value: "\u{f0045} " + Model.fmtBytes(modelData.down) + "/s   \u{f005d} " + Model.fmtBytes(modelData.up) + "/s"
              }
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
              model: sys.temps

              DetailRow {
                required property var modelData
                label: Model.tempName(modelData)
                value: Model.fmtTemp(modelData.celsius)
              }
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
              model: Model.METRICS

              Toggle {
                required property var modelData
                width: parent.width
                label: (modelData.icon !== "" ? modelData.icon + "  " : "") + modelData.label
                checked: root.shownKeys.indexOf(modelData.key) !== -1
                foreground: root.foreground
                accent: Color.accent
                fontFamily: root.fontFamily
                onClicked: root.toggleMetric(modelData.key)
              }
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
            text: "h/l: tabs · j/k: scroll · r: refresh"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            horizontalAlignment: Text.AlignHCenter
          }
        }
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
        color: root.meterColor(meterRow.fraction)

        Behavior on width {
          NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
        }
      }
    }
  }
}
