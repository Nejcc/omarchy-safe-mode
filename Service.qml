import QtQuick
import Quickshell
import Quickshell.Io
import "Logic.js" as Logic

// Headless. Each shell start is recorded; a start that lives 60 seconds is
// healthy. Starting after two unhealthy starts in a row, it disables the
// third-party plugin(s) most likely to blame and says so. All decisions are in
// Logic.js; file and journal access is in bin/omarchy-safe-mode.
Item {
  id: root

  readonly property int healthyAfterMs: 60000
  readonly property string script: decodeURIComponent(Qt.resolvedUrl("bin/omarchy-safe-mode").toString().replace(/^file:\/\//, ""))

  property var facts: null
  property var history: null
  property string key: ""
  property var streak: []
  property var suspects: null
  property int baselinePid: 0
  property string pendingSave: ""
  property var pendingNotice: null

  function run(proc, args) {
    proc.command = ["bash", root.script].concat(args)
    proc.running = true
  }

  function save() {
    root.pendingSave = JSON.stringify(root.history)
    if (!saver.running) root.flushSave()
  }

  function flushSave() {
    if (!root.pendingSave) return
    var text = root.pendingSave
    root.pendingSave = ""
    root.run(saver, ["_save", text])
  }

  function notify(n) {
    console.warn("safe-mode: " + n.title + " | " + n.body.replace(/\n/g, " | "))
    root.pendingNotice = n
    noticeDelay.restart()
  }

  function started(text) {
    var f = Logic.parseJson(text, null)
    if (!f || typeof f !== "object" || !f.bootId) {
      console.warn("safe-mode: could not read startup facts; doing nothing this start")
      return
    }
    root.facts = f
    root.key = Logic.bootKey(f)
    var d = Logic.decide(Logic.parseState(f.state), f)
    root.history = d.state
    if (d.isNew) root.save()
    healthyTimer.start()
    if (d.action !== "journal") return
    var pids = d.streak.map(function(b) { return String(b.pid) })
    var base = Logic.baselineBoot(root.history, d.streak)
    root.baselinePid = base ? base.pid : 0
    root.run(journal, ["_journal"].concat(pids, base ? [String(base.pid)] : []))
  }

  function journalRead(text) {
    var entries = Logic.parseJournal(text)
    var d = Logic.decide(root.history, root.facts, entries)
    root.streak = d.streak
    var crashes = d.streak.length
    if (d.action === "give-up") {
      Logic.markHandled(root.history, d.streak, true)
      root.save()
      root.run(logger, ["_log", "gave up after " + Logic.MAX_ROUNDS + " rounds"])
      root.notify(Logic.notice("give-up", crashes, []))
      return
    }
    if (d.action !== "act") return
    var config = Logic.parseJson(root.facts.config, null)
    root.suspects = Logic.pickSuspects({
      streak: d.streak, baselinePid: root.baselinePid, entries: entries, plugins: root.facts.plugins, enabled: Logic.enabledIds(config)
    })
    if (!root.suspects.ids.length) {
      Logic.markHandled(root.history, d.streak, true)
      root.save()
      root.notify(Logic.notice(root.suspects, crashes, []))
      return
    }
    root.run(disabler, ["_disable"].concat(root.suspects.ids))
  }

  function disabled(text) {
    var ids = String(text || "").split("\n").filter(function(l) { return l.length > 0 })
    Logic.markHandled(root.history, root.streak, false)
    root.save()
    root.notify(Logic.notice(root.suspects, root.streak.length, ids))
    for (var id in root.suspects.evidence) console.warn("safe-mode: evidence for " + id + ": " + root.suspects.evidence[id])
  }

  Component.onCompleted: root.run(probe, ["_facts"])

  Process {
    id: probe
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.started(text) }
  }

  Process {
    id: journal
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.journalRead(text) }
  }

  Process {
    id: disabler
    stdout: StdioCollector { waitForEnd: true; onStreamFinished: root.disabled(text) }
  }

  Process {
    id: saver
    onExited: function() { root.flushSave() }
  }

  Process { id: logger }

  Timer {
    id: healthyTimer
    interval: root.healthyAfterMs
    onTriggered: {
      Logic.markHealthy(root.history, root.key)
      root.save()
    }
  }

  // ponytail: fixed delay so the shell's own notification server is up when
  // we start this early; a crash before it fires loses only the toast, the
  // journal and safe-mode.log still have it.
  Timer {
    id: noticeDelay
    interval: 5000
    onTriggered: {
      var n = root.pendingNotice
      if (n) Quickshell.execDetached(["omarchy-notification-send", "--app-name", "Safe mode", "-u", "critical", n.title, n.body])
    }
  }
}
