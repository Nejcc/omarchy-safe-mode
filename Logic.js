.pragma library

// Pure decision logic for safe mode, kept free of QML so plain Node can test
// it (see tests/). Nothing in here reads files, runs commands or looks at the
// clock: Service.qml gathers the facts and does what this decides.

var SELF_ID = "nejcc.safe-mode"
var CRASH_LIMIT = 2     // unhealthy shell starts in a row before acting
var WINDOW_S = 600      // ...all within this many seconds of kernel uptime
var MAX_ROUNDS = 3      // safe-mode actions per crash loop before giving up
var MAX_SUSPECTS = 3
var MAX_RECORDS = 20

// One shell process. Uptime (CLOCK_BOOTTIME) orders and spaces starts, so a
// wall clock that jumps (NTP at boot, manual change, timezone) can't open or
// close the crash window. Records from another kernel boot never count.
function bootKey(f) {
  return [f.bootId, f.pid, f.startTicks].join(":")
}

function parseJson(text, fallback) {
  try {
    var v = JSON.parse(text)
    return v === null || v === undefined ? fallback : v
  } catch (e) {
    return fallback
  }
}

function parseState(text) {
  var s = parseJson(text || "", null)
  if (!s || typeof s !== "object" || !Array.isArray(s.boots)) return { version: 1, boots: [], rounds: 0 }
  var boots = s.boots.filter(function(b) {
    return b && typeof b === "object" && typeof b.key === "string" && typeof b.kernelBoot === "string"
      && typeof b.uptime === "number" && isFinite(b.uptime)
  })
  var rounds = typeof s.rounds === "number" && s.rounds > 0 ? Math.floor(s.rounds) : 0
  return { version: 1, boots: boots, rounds: rounds }
}

// Adds this shell process (newest last). The same process seen again (the
// service recreated by a disable/enable cycle) is not a new start.
function recordBoot(state, facts) {
  var key = bootKey(facts)
  for (var i = 0; i < state.boots.length; i++)
    if (state.boots[i].key === key) return { state: state, isNew: false }
  var boot = {
    key: key, kernelBoot: String(facts.bootId), pid: Number(facts.pid),
    uptime: Number(facts.uptime), started: Number(facts.now) || 0, healthy: false, handled: false
  }
  var boots = state.boots.concat([boot]).slice(-MAX_RECORDS)
  return { state: { version: 1, boots: boots, rounds: state.rounds }, isNew: true }
}

function markHealthy(state, key) {
  state.boots.forEach(function(b) { if (b.key === key) b.healthy = true })
  state.rounds = 0
  return state
}

// Earlier starts that never reached healthy, most recent first, stopping at
// the first healthy or already-handled one, another kernel boot, or the
// window edge.
function crashStreak(state, key) {
  var idx = -1
  for (var i = 0; i < state.boots.length; i++) if (state.boots[i].key === key) idx = i
  if (idx < 0) return []
  var cur = state.boots[idx]
  var out = []
  for (var j = idx - 1; j >= 0; j--) {
    var b = state.boots[j]
    if (b.healthy || b.handled || b.kernelBoot !== cur.kernelBoot) break
    var age = cur.uptime - b.uptime
    if (!(age >= 0 && age <= WINDOW_S)) break
    out.push(b)
  }
  return out
}

// `journalctl -o json` lines -> [{ pid, message }]. MESSAGE is a byte array
// when it isn't valid UTF-8; ANSI colours are stripped.
function parseJournal(text) {
  var out = []
  String(text || "").split("\n").forEach(function(line) {
    if (!line) return
    var e = parseJson(line, null)
    if (!e || typeof e !== "object") return
    var m = e.MESSAGE
    if (Array.isArray(m)) {
      var raw = ""
      for (var i = 0; i < m.length; i++) raw += String.fromCharCode(Number(m[i]) & 255)
      try { m = decodeURIComponent(escape(raw)) } catch (err) { m = raw }
    }
    if (typeof m !== "string") return
    out.push({ pid: Number(e._PID), message: m.replace(/\x1b\[[0-9;]*m/g, "") })
  })
  return out
}

// `omarchy-restart-shell` stops the old shell over IPC, and Quickshell says
// so on the way out. That start ended on purpose, so it ends the streak.
function isCleanExit(message) {
  return /Exiting due to IPC request/.test(message)
}

function cutAtCleanExit(streak, entries) {
  var clean = {}
  entries.forEach(function(e) { if (isCleanExit(e.message)) clean[e.pid] = true })
  var out = []
  for (var i = 0; i < streak.length; i++) {
    if (clean[streak[i].pid]) break
    out.push(streak[i])
  }
  return out
}

// Duplicate IPC handler warnings name every plugin on every start; DEBUG and
// INFO lines aren't errors.
function isErrorLine(message) {
  if (/^\s*(DEBUG|INFO)\b/.test(message)) return false
  if (/Handler was registered but will not be used/.test(message)) return false
  return true
}

// Plugin ids a line points at: file paths under ~/.config/omarchy/plugins/
// (by directory) and the shell's "service plugin load failed for <id>".
function mentionedIds(message, dirToId, ids0) {
  var ids = []
  var re = /\.config\/omarchy\/plugins\/([^\/\s"'\]]+)\//g
  var m
  while ((m = re.exec(message)) !== null) {
    var id = dirToId[m[1]]
    if (id && ids.indexOf(id) === -1) ids.push(id)
  }
  var lf = message.match(/load failed for ([A-Za-z0-9._-]+)/)
  if (lf && ids0[lf[1]] && ids.indexOf(lf[1]) === -1) ids.push(lf[1])
  return ids
}

// Ids enabled in shell.json: bar.id, bar layout entries and plugins[].
function enabledIds(config) {
  var ids = []
  function add(v) {
    var id = v && typeof v === "object" ? v.id : v
    if (typeof id === "string" && id && ids.indexOf(id) === -1) ids.push(id)
  }
  if (!config || typeof config !== "object") return ids
  var bar = config.bar && typeof config.bar === "object" ? config.bar : {}
  add(bar.id)
  var layout = bar.layout && typeof bar.layout === "object" ? bar.layout : {}
  for (var section in layout) if (Array.isArray(layout[section])) layout[section].forEach(add)
  if (Array.isArray(config.plugins)) config.plugins.forEach(add)
  return ids
}

// The healthy start just before a streak (same kernel boot), if any. Errors
// it logged too are background noise, not crash evidence.
function baselineBoot(state, streak) {
  if (!streak.length) return null
  var oldest = streak[streak.length - 1]
  for (var i = state.boots.length - 1; i >= 0; i--) {
    if (state.boots[i].key !== oldest.key) continue
    var b = state.boots[i - 1]
    return b && b.healthy && b.kernelBoot === oldest.kernelBoot ? b : null
  }
  return null
}

// Best evidence first: enabled third-party plugins named in error lines of
// the crashed starts (most crashed starts, then the latest mention), minus
// those the healthy baseline start also complained about; else the most
// recently changed enabled third-party plugin. Never first-party, never safe
// mode itself.
//   input: { streak, baselinePid, entries, plugins: [{ id, dir, mtime }], enabled: [id] }
function pickSuspects(input) {
  var enabled = input.enabled || []
  var candidates = (input.plugins || []).filter(function(p) {
    return p && typeof p.id === "string" && p.id !== SELF_ID && p.id.indexOf("omarchy.") !== 0
      && enabled.indexOf(p.id) !== -1
  })
  var dirToId = {}, known = {}
  ;(input.plugins || []).forEach(function(p) { if (p && p.id === SELF_ID) dirToId[p.dir] = SELF_ID })
  candidates.forEach(function(p) { dirToId[p.dir] = p.id; known[p.id] = true })
  known[SELF_ID] = true

  var pids = {}
  ;(input.streak || []).forEach(function(b) { pids[b.pid] = true })
  var crashes = {}, last = {}, evidence = {}, noise = {}, selfImplicated = false
  ;(input.entries || []).forEach(function(e, pos) {
    if (!isErrorLine(e.message)) return
    if (input.baselinePid && e.pid === input.baselinePid) {
      mentionedIds(e.message, dirToId, known).forEach(function(id) { noise[id] = true })
      return
    }
    if (!pids[e.pid]) return
    mentionedIds(e.message, dirToId, known).forEach(function(id) {
      if (id === SELF_ID) { selfImplicated = true; return }
      crashes[id] = crashes[id] || {}
      crashes[id][e.pid] = true
      last[id] = pos
      evidence[id] = e.message.trim().slice(0, 300)
    })
  })
  var named = Object.keys(crashes)
  var signal = named.filter(function(id) { return !noise[id] })
  if (signal.length) named = signal
  if (named.length) {
    var count = function(id) { return Object.keys(crashes[id]).length }
    var top = Math.max.apply(null, named.map(count))
    var ids = named.filter(function(id) { return count(id) === top })
      .sort(function(a, b) { return last[b] - last[a] }).slice(0, MAX_SUSPECTS)
    var ev = {}
    ids.forEach(function(id) { ev[id] = evidence[id] })
    return { ids: ids, reason: "journal", evidence: ev, selfImplicated: selfImplicated }
  }
  var newest = candidates.filter(function(p) { return typeof p.mtime === "number" && isFinite(p.mtime) })
    .sort(function(a, b) { return b.mtime - a.mtime })[0]
  if (newest) return { ids: [newest.id], reason: "recent", evidence: {}, selfImplicated: selfImplicated }
  return { ids: [], reason: "none", evidence: {}, selfImplicated: selfImplicated }
}

// The whole startup decision. facts: { bootId, pid, startTicks, uptime, now },
// entries only when the caller already fetched the journal for `streak`.
//   -> { action: "none" | "journal" | "act" | "give-up", state, streak, isNew }
function decide(state, facts, entries) {
  var r = recordBoot(state, facts)
  var key = bootKey(facts)
  if (!r.isNew && entries === undefined) return { action: "none", state: r.state, streak: [], isNew: false }
  var streak = crashStreak(r.state, key)
  if (entries !== undefined) streak = cutAtCleanExit(streak, entries)
  if (streak.length < CRASH_LIMIT) return { action: "none", state: r.state, streak: streak, isNew: r.isNew }
  if (entries === undefined) return { action: "journal", state: r.state, streak: streak, isNew: r.isNew }
  if (r.state.rounds >= MAX_ROUNDS) return { action: "give-up", state: r.state, streak: streak, isNew: r.isNew }
  return { action: "act", state: r.state, streak: streak, isNew: r.isNew }
}

// Called once safe mode has acted (or given up) on a streak, so the same
// crashes never trigger twice. Two fresh crashes start the next round.
// The current start stays countable: if it crashes too, it opens the next streak.
function markHandled(state, streak, gaveUp) {
  var keys = streak.map(function(b) { return b.key })
  state.boots.forEach(function(b) { if (keys.indexOf(b.key) !== -1) b.handled = true })
  if (!gaveUp) state.rounds = (state.rounds || 0) + 1
  return state
}

function notice(result, crashes, disabled) {
  var n = baseNotice(result, crashes, disabled)
  if (result && result.selfImplicated)
    n.body += "\nErrors also point at Safe mode itself. To turn it off: omarchy plugin disable " + SELF_ID
  return n
}

function baseNotice(result, crashes, disabled) {
  var list = disabled.join(", ")
  var enable = disabled.map(function(id) { return "omarchy plugin enable " + id }).join("\n")
  if (result === "give-up")
    return { title: "Safe mode: shell still crashing",
      body: "Safe mode already disabled plugins " + MAX_ROUNDS + " times and the shell keeps crashing. "
        + "From a terminal, run: omarchy-safe-mode off" }
  if (!disabled.length && result.ids && result.ids.length)
    return { title: "Safe mode could not disable " + result.ids.join(", "),
      body: "The shell crashed " + crashes + " times in a row. From a terminal, run: omarchy-safe-mode off" }
  if (!disabled.length)
    return { title: "Safe mode: shell crashed " + crashes + " times",
      body: "No enabled third-party plugin to blame, so nothing was disabled." }
  // Notifications show about three lines, so the re-enable command goes first.
  var why = result.reason === "journal" ? "named in the crash errors" : "most recently changed; no error named a plugin"
  return { title: "Safe mode disabled " + list,
    body: enable + "\nShell crashed " + crashes + " times in a row; " + why + "." }
}
