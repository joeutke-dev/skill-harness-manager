---
name: setup-ghostty
description: Configure the Ghostty terminal so the Skill and Harness Manager Obsidian plugin opens skill runs and session Connects as tabs in your existing Ghostty window. Checks the Ghostty version (1.3+ is needed for tabs via AppleScript; older versions open a separate Ghostty copy per run), offers to upgrade, makes sure AppleScript isn't disabled in the Ghostty config, and checks macOS folder access to the vault. Use when the user says "set up Ghostty", "configure Ghostty for Obsidian", or "the plugin keeps opening new Ghostty windows".
tags:
  - setup
  - terminal
---

# Set up Ghostty for Skill and Harness Manager

On macOS the `ghostty` command-line tool can't open terminal windows. Before
Ghostty 1.3 the plugin's only option was `open -na Ghostty --args -e …`, which
starts a **separate copy of Ghostty for every run**. Ghostty 1.3 added AppleScript
support, which lets the plugin open each run as a **tab** in your existing
window, in the vault folder, titled with the skill name.

Work through the steps in order and report what you find. **Ask before
upgrading or editing config.**

## 1. Find Ghostty and its version

```bash
for d in /Applications "$HOME/Applications"; do
  [ -d "$d/Ghostty.app" ] && echo "$d/Ghostty.app" && \
    defaults read "$d/Ghostty.app/Contents/Info.plist" CFBundleShortVersionString
done
```

- Not found → offer `brew install --cask ghostty` (or https://ghostty.org/download).
- **1.3.0 or newer** → go to step 3.
- **Older than 1.3.0** → step 2.

## 2. Upgrade to 1.3+ (ask first)

Upgrading restarts Ghostty, which closes its open windows. Make sure the user
has nothing running in Ghostty that they need.

```bash
brew list --cask ghostty >/dev/null 2>&1 && echo "installed via Homebrew"
```

- Installed via Homebrew → `brew upgrade --cask ghostty`.
- Otherwise → ask the user to use **Ghostty → Check for Updates…** from the menu bar.

Re-run step 1 to confirm the new version.

## 3. Make sure AppleScript isn't disabled

AppleScript is on by default, but the config can turn it off:

```bash
grep -Hn "macos-applescript" "$HOME/.config/ghostty/config" \
  "$HOME/Library/Application Support/com.mitchellh.ghostty/config" 2>/dev/null
```

If a line sets `macos-applescript = false`, ask whether to remove it. Back the
file up first (`cp -p <file> <file>.$(date +%Y%m%d-%H%M%S).bak`), then delete
that line and restart Ghostty.

Then check scripting responds:

```bash
osascript -e 'tell application "Ghostty" to get version'
```

macOS may ask whether the app running this skill can control Ghostty. That
prompt is for *this* terminal, not Obsidian; Obsidian gets its own prompt later.

## 4. Check Ghostty can read the vault (macOS privacy)

If the vault is under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive,
macOS may block Ghostty from reading it.

```bash
VAULT="$(pwd)"   # this skill runs with the vault as its working directory
osascript <<EOF
tell application "Ghostty"
  set cfg to new surface configuration
  set initial working directory of cfg to "$VAULT"
  set initial input of cfg to "ls >/dev/null && echo VAULT-READABLE || echo VAULT-BLOCKED" & linefeed
  new tab in front window with configuration cfg
end tell
EOF
```

Ask the user what the new tab printed. `VAULT-BLOCKED` or `Operation not
permitted` → **System Settings → Privacy & Security → Files and Folders →
Ghostty → Documents Folder** (or add Ghostty to **Full Disk Access**), then
restart Ghostty.

## 5. Point the plugin at Ghostty

Tell the user to finish in Obsidian:

1. **Settings → Skill and Harness Manager → Preferred terminal → Ghostty.**
2. In the **Ghostty** section, check it says runs open **as tabs** (1.3+), and
   choose **Open runs in: New tab / New window**.
3. Run any skill in terminal mode. The first time, macOS asks **"Obsidian wants
   to control Ghostty"**. Click **Allow**. If it was denied earlier, re-enable it
   in **System Settings → Privacy & Security → Automation → Obsidian → Ghostty**.

## Undo

Restore any config backup made in step 3. Upgrades aren't rolled back. The
plugin falls back to one Ghostty copy per run on versions older than 1.3.
