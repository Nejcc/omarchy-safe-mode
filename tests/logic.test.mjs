// Unit tests for Logic.js. Run with: node --test tests/*.test.mjs
// Logic.js is a QML JavaScript library, so it's loaded into a sandbox with its
// `.pragma library` line stripped. No dependencies needed.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const source = readFileSync(new URL("../Logic.js", import.meta.url), "utf8").replace(/^\.pragma library\s*$/m, "")
const L = vm.createContext({})
vm.runInContext(source, L)
const plain = (v) => JSON.parse(JSON.stringify(v))
const fixture = (name) => readFileSync(new URL("fixtures/" + name, import.meta.url), "utf8")

const facts = (pid, uptime, bootId = "kb1") => ({ bootId, pid, startTicks: String(pid * 2), uptime, now: 1791300900 + uptime })
const history = () => L.parseState(fixture("boots.json"))
const journal = () => L.parseJournal(fixture("crash-journal.jsonl"))
const plugins = [
  { dir: "acme.weather", id: "acme.weather", mtime: 100 },
  { dir: "old.noisy", id: "old.noisy", mtime: 200 },
  { dir: "bad-clock", id: "someone.clock", mtime: 300 },
  { dir: "evil-service-dir", id: "evil.service", mtime: 50 },
  { dir: "innocent", id: "innocent", mtime: 999 },
  { dir: "omarchy-safe-mode", id: "nejcc.safe-mode", mtime: 5000 },
  { dir: "not-enabled", id: "not.enabled", mtime: 9000 }
]
const enabled = ["omarchy.clock", "acme.weather", "old.noisy", "someone.clock", "evil.service", "innocent", "nejcc.safe-mode"]

test("parseState survives missing, corrupt and hostile files", () => {
  for (const text of ["", "{", "null", "[]", '"x"', '{"boots": 5}', '{"boots": [null, 1, {"key": 2}]}'])
    assert.deepEqual(plain(L.parseState(text)), { version: 1, boots: [], rounds: 0 })
  assert.equal(L.parseState(fixture("boots.json")).boots.length, 4)
  assert.equal(L.parseState('{"boots": [], "rounds": -3}').rounds, 0)
})

test("parseJournal decodes byte-array messages and strips colours", () => {
  const e = journal()
  assert.equal(e.length, 17)
  assert.equal(e[0].pid, 4101)
  assert.equal(e[0].message, '  INFO: Launching config: "/usr/share/omarchy/shell/shell.qml"')
  assert.ok(!e.some((x) => x.message.includes("\x1b")))
  assert.deepEqual(plain(L.parseJournal("garbage\n{}\n{\"MESSAGE\": 5}\n")), [])
  // Invalid UTF-8 bytes fall back to raw characters instead of throwing.
  assert.equal(L.parseJournal(JSON.stringify({ _PID: "1", MESSAGE: [0xff, 0x41] }))[0].message, "ÿA")
})

test("two unhealthy starts in a row ask for the journal, then act", () => {
  const f = facts(4103, 910)
  const d = L.decide(history(), f)
  assert.equal(d.action, "journal")
  assert.equal(d.isNew, true)
  assert.deepEqual(plain(d.streak.map((b) => b.pid)), [4102, 4101])
  const d2 = L.decide(d.state, f, journal().filter((e) => e.pid !== 4103))
  assert.equal(d2.action, "act")
  assert.equal(d2.isNew, false)
})

test("one unhealthy start is not a crash loop", () => {
  const s = history()
  s.boots.pop()
  assert.equal(L.decide(s, facts(4103, 910)).action, "none")
})

test("a healthy start, another kernel boot or the window edge ends the streak", () => {
  const s = history()
  s.boots[2].healthy = true
  assert.equal(L.decide(s, facts(4103, 910)).action, "none")
  // Same pids after a reboot: other kernel boot, nothing counts.
  assert.equal(L.decide(history(), facts(4103, 30, "kb2")).action, "none")
  // Eleven minutes after the oldest crash: outside the window.
  assert.equal(L.decide(history(), facts(4103, 900 + L.WINDOW_S + 1)).action, "none")
  // Uptime going backwards inside one kernel boot is nonsense: don't trust it.
  assert.equal(L.decide(history(), facts(4103, 10)).action, "none")
})

test("a deliberate restart (Quickshell exiting over IPC) is not a crash", () => {
  const s = history()
  s.boots[3].pid = 4103 // the start that logged "Exiting due to IPC request."
  const f = facts(4200, 920)
  assert.equal(L.decide(s, f).action, "journal")
  assert.equal(L.decide(s, f, journal()).action, "none")
})

test("the same shell process seen again is not a new start", () => {
  const f = facts(4103, 910)
  const first = L.decide(history(), f)
  const again = L.decide(first.state, { ...f, uptime: 990 })
  assert.equal(again.isNew, false)
  assert.equal(again.action, "none")
  assert.equal(again.state.boots.length, 5)
})

test("records are capped", () => {
  let s = L.parseState("")
  for (let i = 0; i < 50; i++) s = L.recordBoot(s, facts(5000 + i, i)).state
  assert.equal(s.boots.length, L.MAX_RECORDS)
  assert.equal(s.boots[s.boots.length - 1].pid, 5049)
})

test("journal evidence: plugins named in every crashed start, newest mention first, minus baseline noise", () => {
  const s = history()
  const d = L.decide(s, facts(4103, 910))
  const base = L.baselineBoot(d.state, d.streak)
  assert.equal(base.pid, 4100)
  const r = L.pickSuspects({ streak: d.streak, baselinePid: base.pid, entries: journal(), plugins, enabled })
  assert.equal(r.reason, "journal")
  // acme.weather only shows up in the benign IPC warning; old.noisy also
  // errored on the healthy start; innocent only on the healthy start.
  assert.deepEqual(plain(r.ids), ["evil.service", "someone.clock"])
  assert.match(r.evidence["someone.clock"], /ReferenceError/)
  assert.equal(r.selfImplicated, false)
  // Without the baseline the noisy plugin is a suspect too.
  const noBase = L.pickSuspects({ streak: d.streak, entries: journal(), plugins, enabled })
  assert.deepEqual(plain(noBase.ids), ["evil.service", "someone.clock", "old.noisy"])
})

test("never first-party, never itself, never a disabled plugin", () => {
  const H = "/home/u/.config/omarchy/plugins/"
  const entries = [
    { pid: 1, message: "  WARN scene: file://" + H + "omarchy-safe-mode/Service.qml[3:1]: TypeError: boom" },
    { pid: 1, message: "  WARN scene: file:///usr/share/omarchy/shell/plugins/panels/clock/BarWidget.qml[1:1]: TypeError" },
    { pid: 1, message: "  WARN scene: file://" + H + "not-enabled/X.qml[1:1]: TypeError" },
    { pid: 1, message: "service plugin load failed for omarchy.clock: nope" }
  ]
  const streak = [{ pid: 1, key: "a" }, { pid: 1, key: "b" }]
  const r = L.pickSuspects({ streak, entries, plugins, enabled })
  assert.equal(r.selfImplicated, true)
  assert.equal(r.reason, "recent")
  // Newest enabled third-party plugin, skipping safe mode (5000) and the disabled one (9000).
  assert.deepEqual(plain(r.ids), ["innocent"])
  const n = L.notice(r, 2, ["innocent"])
  assert.match(n.body, /^omarchy plugin enable innocent\n[\s\S]*omarchy plugin disable nejcc\.safe-mode/)
})

test("nothing to blame when no third-party plugin is enabled", () => {
  const r = L.pickSuspects({ streak: [{ pid: 1 }], entries: [], plugins, enabled: ["omarchy.clock", "nejcc.safe-mode"] })
  assert.deepEqual(plain(r.ids), [])
  assert.equal(r.reason, "none")
  assert.match(L.notice(r, 2, []).body, /nothing was disabled/)
})

test("enabledIds reads bar.id, layout entries and plugins[]", () => {
  const cfg = JSON.parse('{"bar":{"id":"x.bar","layout":{"left":[{"id":"a"},"b",null],"center":"bad","right":[{"id":"c","format":"HH"}]}},"plugins":[{"id":"d"},{"nope":1}]}')
  assert.deepEqual(plain(L.enabledIds(cfg)), ["x.bar", "a", "b", "c", "d"])
  assert.deepEqual(plain(L.enabledIds(null)), [])
  assert.deepEqual(plain(L.enabledIds({ bar: 5, plugins: "x" })), [])
})

test("handled crashes never trigger twice; rounds cap, healthy resets", () => {
  const f = facts(4103, 910)
  let d = L.decide(history(), f)
  d = L.decide(d.state, f, [])
  assert.equal(d.action, "act")
  L.markHandled(d.state, d.streak, false)
  assert.equal(d.state.rounds, 1)
  // Next start: the handled crashes don't count, the safe-mode start alone isn't a loop.
  assert.equal(L.decide(d.state, facts(4104, 915)).action, "none")
  // ...but if that one and the next crash as well, round two.
  let s = L.decide(d.state, facts(4104, 915)).state
  s = L.decide(s, facts(4105, 920)).state
  assert.equal(L.decide(s, facts(4106, 925), []).action, "act")
  s.rounds = L.MAX_ROUNDS
  assert.equal(L.decide(s, facts(4106, 925), []).action, "give-up")
  assert.match(L.notice("give-up", 2, []).body, /omarchy-safe-mode off/)
  L.markHealthy(s, s.boots[s.boots.length - 1].key)
  assert.equal(s.rounds, 0)
})

test("notice names what was disabled and how to turn it back on", () => {
  const n = L.notice({ reason: "journal" }, 2, ["evil.service", "someone.clock"])
  assert.match(n.title, /evil\.service, someone\.clock/)
  assert.match(n.body, /omarchy plugin enable evil\.service\nomarchy plugin enable someone\.clock/)
  assert.match(L.notice({ reason: "recent" }, 3, ["x"]).body, /most recently changed/)
  assert.match(L.notice({ reason: "journal", ids: ["x"] }, 2, []).title, /could not disable x/)
})
