# Safe mode

Spots an Omarchy shell crash loop, disables the third-party plugin behind it, and tells you which one and how to turn it back on.

## The problem

Every plugin runs inside the one `omarchy-shell` process. One bad install or update can take the whole desktop down: no bar, no menu, no lock screen, the shell relaunching over and over. Getting out means finding the culprit and editing `~/.config/omarchy/shell.json` by hand.

## Install

```bash
omarchy plugin add https://github.com/Nejcc/omarchy-safe-mode.git --enable
```

It starts right away. It's a `keepLoaded` service so other plugins' hot reloads don't restart it, which also means its own updates apply on the next `omarchy-restart-shell`.

Put the escape hatch on your PATH for the day the shell doesn't come back at all (or run it by its full path):

```bash
ln -s ~/.config/omarchy/plugins/nejcc.safe-mode/bin/omarchy-safe-mode ~/.local/bin/
```

## Usage

Nothing to do. When the shell crashes twice in a row and comes back a third time, you get a notification like:

> **Safe mode disabled acme.weather**
> The shell crashed 2 times in a row. Disabled acme.weather (named in the crash errors).
> Re-enable with: omarchy plugin enable acme.weather

Disabling a bar widget takes it off the bar, so re-enabling it puts it back in its default section with default settings.

From any terminal or a TTY (Ctrl+Alt+F3), even with no shell running:

```bash
omarchy-safe-mode off       # disable every third-party plugin (shell.json backed up first)
omarchy-safe-mode restore   # put the backed-up shell.json back, exactly as it was
omarchy-safe-mode status    # recorded shell starts, what safe mode did, backup
```

`off` keeps Safe mode itself and every built-in plugin, writes `shell.json` atomically (it follows a symlinked one), and then restarts the shell if it isn't running. Running `off` twice keeps the first backup. `restore` saves the file it replaces as `shell.json.before-restore`.

## How it works

- On load it records the shell process (kernel boot id, PID, process start time, uptime) in `$XDG_STATE_HOME/omarchy-safe-mode/boots.json` (default `~/.local/state`). A shell that lives 60 seconds is marked healthy.
- When the two starts before this one both died before 60 seconds, in the same kernel boot and within 10 minutes, it reads those starts' own lines from the journal (`journalctl -b -t omarchy-shell`, matched by PID).
- A start that ended with Quickshell's `Exiting due to IPC request.` was `omarchy-restart-shell`, not a crash, so it ends the streak. A restart after 60 seconds is healthy anyway.
- Suspects, best evidence first: enabled third-party plugins whose files show up in error lines of the crashed starts (the most crashed starts, then the latest mention, up to three). Errors the last healthy start also logged are dropped as background noise, and so are the duplicate-IPC-handler warnings every start prints. With no named plugin, it takes the most recently changed enabled third-party plugin.
- It disables them with `omarchy-shell shell setPluginEnabled <id> false`, logs to the journal and `safe-mode.log`, and shows a notification. Those crashes are then handled: it takes two fresh crashes to act again, and after three rounds without a healthy start it stops and points you at `omarchy-safe-mode off`.
- It never disables a built-in plugin or itself. If the errors point at Safe mode, the notification says so and how to disable it.

Times come from kernel uptime, not the wall clock, so NTP jumps at boot or a changed clock can't fake or hide a crash loop.

## Runtime deps

`jq`, `journalctl`, `omarchy-notification-send`, all part of a stock Omarchy install.

## Limits

- It can only act once it has loaded. If a plugin kills the shell before Safe mode loads, those starts are never recorded, and the launcher gives up after 5 relaunches in a minute. That's what `omarchy-safe-mode off` from a TTY is for.
- A crash later than 60 seconds after start isn't treated as a crash loop.
- A shell that's stopped twice in under a minute some other way (logging out right after logging in, twice) looks the same as two crashes.
- The fallback guess (most recently changed plugin) is just a guess when nothing in the journal names a plugin, for example a crash in a Qt or GPU library. The notification says which kind of evidence it used.
- A plugin that errors on every start, healthy or not, can be named when there's no healthy start in the same kernel boot to compare against.

## Tests

```bash
node --test tests/*.test.mjs   # decision logic, with journal and boot-history fixtures
bash tests/cli.test.sh         # off/restore/_facts against a throwaway HOME, stubbed shell
```

## License

MIT
