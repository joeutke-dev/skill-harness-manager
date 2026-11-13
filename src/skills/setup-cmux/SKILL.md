---
name: setup-cmux
description: Configure the cmux terminal so the Skill and Harness Manager Obsidian plugin can open skill runs and session Connects as tabs in an "Obsidian Sessions" cmux workspace. Checks cmux is installed and running, switches cmux's socket control from "cmux processes only" to password mode (or allow-all if the user prefers), verifies access from outside cmux, and checks macOS folder access to the vault. Use when the user says "set up cmux", "configure cmux for Obsidian", "cmux refused the connection", or "make the plugin open tabs in cmux".
tags:
  - setup
  - terminal
---

# Set up cmux for Skill and Harness Manager

The plugin drives cmux through cmux's command-line tool, which talks to the
running cmux app over a local socket. By default cmux only accepts socket
connections from processes started *inside* cmux, so Obsidian is refused with
`Access denied - only processes started inside cmux can connect`. This skill
changes that one setting, verifies it, and checks the vault is readable from
cmux. Using cmux is optional; the plugin works with any terminal.

Work through the steps in order. Tell the user what you found at each step.
**Ask before changing anything**, and never print the socket password.

## 1. Find cmux and its CLI

```bash
for d in /Applications "$HOME/Applications"; do
  [ -x "$d/cmux.app/Contents/Resources/bin/cmux" ] && echo "$d/cmux.app/Contents/Resources/bin/cmux"
done
```

- Use the first path printed as `CMUX` for every later command (the copy inside
  the app bundle always matches the running app). A `cmux` on PATH also works.
- Nothing printed → cmux isn't installed. Offer `brew install --cask cmux` (or
  the download from https://cmux.com) and stop until it's installed.
- Print the version: `defaults read "<app>/Contents/Info.plist" CFBundleShortVersionString`.

## 2. Make sure cmux is running

```bash
pgrep -f "cmux.app/Contents/MacOS/cmux" >/dev/null || open -a cmux
```

Wait a few seconds after opening it.

## 3. Check the current socket mode

```bash
CMUX_QUIET=1 "$CMUX" config get automation.socketControlMode
```

| Mode | Meaning | Action |
|---|---|---|
| `cmuxOnly` (default) | Only processes inside cmux can connect | Change it (step 4) |
| `password` | Any process that presents the password | Already fine; go to step 5 |
| `allowAll` / `openAccess` | Any local process | Already fine; go to step 5 |
| `off` | Socket disabled | Change it (step 4) |

## 4. Change the socket mode (ask first)

Explain the two options and ask which the user wants:

- **Password (recommended).** cmux requires a password on the socket. cmux's own
  CLI reads the saved password from cmux's config, so the plugin needs no
  password setting and nothing secret is stored in the vault.
- **Allow all.** No password; any program running as this user can control cmux
  (open tabs, type into terminals). Simpler, but a wider opening.

Back up the config first (cmux recommends a timestamped copy), then apply the
choice with `cmux config set`, which keeps comments and other keys:

```bash
CFG="$HOME/.config/cmux/cmux.json"
[ -f "$CFG" ] && cp -p "$CFG" "$CFG.$(date +%Y%m%d-%H%M%S).bak"

# Password mode. Output is silenced so the password never appears in the transcript.
CMUX_QUIET=1 "$CMUX" config set automation.socketControlMode password >/dev/null
CMUX_QUIET=1 "$CMUX" config set automation.socketPassword "$(openssl rand -hex 16)" >/dev/null

# …or allow-all instead:
# CMUX_QUIET=1 "$CMUX" config set automation.socketControlMode allowAll >/dev/null

CMUX_QUIET=1 "$CMUX" config doctor
CMUX_QUIET=1 "$CMUX" reload-config
```

If `reload-config` itself is refused (it uses the socket), ask the user to quit
and reopen cmux once instead.

## 5. Verify access from outside cmux

The check has to run as an *outside* process. If this session is itself running
in a cmux terminal (`CMUX_WORKSPACE_ID` is set), cmux would let it in regardless,
so strip the cmux variables:

```bash
env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID -u CMUX_TAB_ID -u CMUX_PANEL_ID \
  CMUX_QUIET=1 "$CMUX" capabilities --json | grep '"access_mode"'
env -u CMUX_WORKSPACE_ID -u CMUX_SURFACE_ID -u CMUX_TAB_ID -u CMUX_PANEL_ID \
  CMUX_QUIET=1 "$CMUX" workspace list >/dev/null && echo "socket OK"
```

Expect `"access_mode" : "password"` (or `allowAll`) and `socket OK`. `Access
denied` means the mode didn't take; re-run `reload-config` or restart cmux.

## 6. Check cmux can read the vault (macOS privacy)

If the vault is under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive,
macOS may block cmux from reading it until it's granted access. Open a test tab
in the plugin's workspace and look for `Operation not permitted`:

```bash
VAULT="$(pwd)"   # this skill runs with the vault as its working directory
WS=$(CMUX_QUIET=1 "$CMUX" new-workspace --name "Obsidian Sessions" --cwd "$VAULT" \
      --command "ls >/dev/null && echo VAULT-READABLE || echo VAULT-BLOCKED" | grep -o 'workspace:[0-9A-Za-z-]*')
sleep 3
CMUX_QUIET=1 "$CMUX" read-screen --workspace "$WS" --lines 20 | grep -E "VAULT-(READABLE|BLOCKED)|not permitted"
```

- `VAULT-READABLE` → done. Leave the "Obsidian Sessions" workspace; the plugin
  reuses it.
- `VAULT-BLOCKED` / `Operation not permitted` → ask the user to open **System
  Settings → Privacy & Security → Files and Folders → cmux** and enable
  **Documents Folder** (or the relevant folder), or add cmux under **Full Disk
  Access**. Then quit and reopen cmux and re-check.

If an "Obsidian Sessions" workspace already existed, this creates a second one
with the same name. Close the test one afterwards with
`"$CMUX" close-workspace --workspace "$WS"`.

## 7. Point the plugin at cmux

Tell the user to finish in Obsidian:

1. **Settings → Skill and Harness Manager → Preferred terminal → cmux.**
2. In the **cmux** section, click **Test connection**. It should report the
   socket mode and the workspace runs will open into.
3. Optional: rename the workspace, turn **Bring cmux to front** on or off, and
   turn on **cmux notifications** to get a cmux notification when a headless run
   finishes, fails or needs input.

The first time the plugin opens a tab, macOS may ask whether Obsidian can access
files or control other apps. Allow it.

## Undo

Restore the backup from step 4 (`cp -p ~/.config/cmux/cmux.json.<timestamp>.bak
~/.config/cmux/cmux.json`), or run
`"$CMUX" config unset automation.socketControlMode` and
`"$CMUX" config unset automation.socketPassword`, then `"$CMUX" reload-config`.
