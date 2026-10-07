# Release notes

## 0.1.0

- First version: records shell starts, spots two crashed starts in a row and disables the third-party plugin the journal blames (or the most recently changed one), with a notification saying how to turn it back on.
- `bin/omarchy-safe-mode off|restore|status` for when the shell gave up and nothing runs.

Unit and CLI tests pass locally. Live desktop validation is pending.
