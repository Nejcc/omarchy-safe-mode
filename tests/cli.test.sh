#!/usr/bin/env bash
# check() evals its single-quoted conditions, so they expand there, later.
# shellcheck disable=SC2016,SC2034
# Tests bin/omarchy-safe-mode against a throwaway HOME with stubbed
# omarchy-shell / omarchy-restart-shell, so the real desktop is never touched.
#   bash tests/cli.test.sh
set -uo pipefail

BIN=$(cd "$(dirname "$0")/.." && pwd)/bin/omarchy-safe-mode
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME=$T/home XDG_STATE_HOME=$T/state PATH=$T/stub:$PATH
STATE=$XDG_STATE_HOME/omarchy-safe-mode
CFG=$HOME/.config/omarchy/shell.json
pass=0 fail=0
check() {
  if eval "$2"; then
    echo "PASS  $1"
    pass=$((pass + 1))
  else
    echo "FAIL  $1"
    fail=$((fail + 1))
  fi
}

mkdir -p "$T/stub" "$HOME/.config/omarchy/plugins"
# The shell is "down": ping fails, setPluginEnabled answers ok and is logged.
cat >"$T/stub/omarchy-shell" <<'EOF'
#!/bin/bash
echo "$*" >>"$HOME/ipc.log"
[[ $2 == setPluginEnabled ]] && echo ok && exit 0
exit 1
EOF
printf '#!/bin/bash\necho restarted >>"$HOME/ipc.log"\n' >"$T/stub/omarchy-restart-shell"
chmod +x "$T/stub/"*

plugin() {
  mkdir -p "$HOME/.config/omarchy/plugins/$1"
  printf '{"id": "%s"}\n' "$2" >"$HOME/.config/omarchy/plugins/$1/manifest.json"
}
plugin acme.weather acme.weather
plugin some-dir someone.bar
plugin omarchy-safe-mode nejcc.safe-mode
plugin broken broken
echo '{' >"$HOME/.config/omarchy/plugins/broken/manifest.json"

cat >"$CFG" <<'EOF'
{"version": 1,
 "bar": {"id": "someone.bar", "layout": {"left": [{"id": "omarchy.menu"}, {"id": "acme.weather", "units": "metric"}], "right": ["omarchy.clock"]}},
 "plugins": [{"id": "nejcc.safe-mode"}, {"id": "acme.weather"}, {"id": "omarchy.lock"}]}
EOF
ORIG=$(cat "$CFG")

out=$(bash "$BIN" off 2>&1)
check "off succeeds" '[[ $? -eq 0 ]]'
check "off names what it disabled" '[[ $out == *"acme.weather, someone.bar"* ]]'
check "backup holds the original" '[[ "$(cat "$STATE/shell.json.before-safe-mode")" == "$ORIG" ]]'
check "third-party layout entries gone" '[[ $(jq -c "[.bar.layout[][] | if type == \"object\" then .id else . end]" "$CFG") == "[\"omarchy.menu\",\"omarchy.clock\"]" ]]'
check "third-party bar falls back" '[[ $(jq -r ".bar.id // \"none\"" "$CFG") == none ]]'
check "safe mode and first-party stay" '[[ $(jq -c "[.plugins[].id]" "$CFG") == "[\"nejcc.safe-mode\",\"omarchy.lock\"]" ]]'
check "a dead shell gets restarted" 'grep -qx restarted "$HOME/ipc.log"'
check "logged" 'grep -q "manual off" "$STATE/safe-mode.log"'

out=$(bash "$BIN" off 2>&1)
check "second off changes nothing and keeps the backup" '[[ $out == *"No third-party plugins are enabled"* && "$(cat "$STATE/shell.json.before-safe-mode")" == "$ORIG" ]]'

bash "$BIN" restore >/dev/null 2>&1
check "restore puts the original back" '[[ "$(cat "$CFG")" == "$ORIG" ]]'
check "restore keeps the replaced file and drops the backup" '[[ -f $STATE/shell.json.before-restore && ! -e $STATE/shell.json.before-safe-mode ]]'
bash "$BIN" restore >/dev/null 2>&1
check "restore without a backup fails" '[[ $? -ne 0 ]]'

# A dotfiles-managed, symlinked shell.json stays a symlink.
mv "$CFG" "$T/real.json" && ln -s "$T/real.json" "$CFG"
bash "$BIN" off >/dev/null 2>&1
check "symlink survives off" '[[ -L $CFG && $(jq -r ".plugins | length" "$T/real.json") == 2 ]]'
bash "$BIN" restore >/dev/null 2>&1
check "symlink survives restore" '[[ -L $CFG && "$(cat "$T/real.json")" == "$ORIG" ]]'

echo '{not json' >"$T/real.json"
bash "$BIN" off >/dev/null 2>&1
check "refuses to edit invalid JSON" '[[ $? -ne 0 && $(cat "$T/real.json") == "{not json" ]]'
echo "$ORIG" >"$T/real.json"

facts=$(bash "$BIN" _facts)
check "_facts is JSON with this process as pid" '[[ $(jq -r .pid <<<"$facts") == "$$" ]]'
check "_facts has boot id, uptime and start ticks" '[[ $(jq -r "(.bootId | length > 0) and (.uptime > 0) and (.startTicks | test(\"^[0-9]+$\"))" <<<"$facts") == true ]]'
check "_facts lists plugins with valid manifests by dir" '[[ $(jq -c "[.plugins[] | .dir + \"=\" + .id] | sort" <<<"$facts") == "[\"acme.weather=acme.weather\",\"omarchy-safe-mode=nejcc.safe-mode\",\"some-dir=someone.bar\"]" ]]'
check "_facts carries shell.json raw" '[[ $(jq -r .config <<<"$facts" | jq -r .version) == 1 && $(jq -r .state <<<"$facts") == "" ]]'

bash "$BIN" _save '{"version":1,"boots":[]}'
check "_save writes boots.json" '[[ $(jq -r .version "$STATE/boots.json") == 1 ]]'
bash "$BIN" _save ''
check "_save refuses empty" '[[ $? -ne 0 && $(jq -r .version "$STATE/boots.json") == 1 ]]'
check "status runs" 'bash "$BIN" status | grep -q "Backup: none"'

: >"$HOME/ipc.log"
out=$(bash "$BIN" _disable acme.weather omarchy.clock nejcc.safe-mode someone.bar)
check "_disable skips first-party and itself" '[[ $out == $'"'"'acme.weather\nsomeone.bar'"'"' && $(grep -c setPluginEnabled "$HOME/ipc.log") == 2 ]]'
check "_journal ignores non-numeric pids" '[[ -z $(bash "$BIN" _journal "1;rm" x) ]]'

echo "$pass passed, $fail failed"
((fail == 0))
