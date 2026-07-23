# Skill and Harness Manager

**Consolidate, organize, and manage your AI skills — right inside your vault.**

If you've collected AI *skills* (`SKILL.md` files), commands, and agents across
different tools — `.claude/`, `.codex/`, `.cursor/`, `.agents/`, marketplace
folders, loose notes — they end up scattered and hard to actually use. This
plugin gathers them into one place, lets you organize, filter, and tag them, and
makes each one runnable with a click.

> No bundled model, no inference, no network calls of its own. It finds,
> organizes, and launches; the actual work runs in whatever AI CLI you point it
> at (Claude Code, Codex, omnigent, or your own).

## What you can do with it

Run AI where you already work:

- **Reformat a markdown note with one click** — pin a "clean up markdown" skill
  to the sidebar and run it on the current file.
- **Process an audio file** — right-click a recording and run a
  transcribe/summarize skill against it.
- **Trigger daily automations** — kick off a daily-note or digest skill from a
  ribbon button.
- …and anything else you can capture as a skill.

## How you launch skills

Skills can be run from wherever is most convenient:

- **Right-click a file** in the file explorer → run a skill *targeting that file*
  (great for "reformat this note", "transcribe this audio", "summarize this").
- **Sidebar buttons** — pin any skill to its own ribbon icon (with a custom
  Lucide icon) to create one-click launchers for the skills you use most.
- **Command palette** — every pinned skill also registers a command.
- **The browser view** — open it and launch anything from there.

## The browser

A single view (`brain-circuit` ribbon icon) with tabs:

- **Skills** / **Commands** — everything discovered across your scan roots,
  grouped into a collapsible source-folder tree, each with its description and
  tags. Multi-select filters by agent, harness, tag, and access, plus search.
- **Scripts** — your own bash scripts (add a name, description, and body right in
  the tab). Each script runs on click, in a terminal or headless, per its own
  setting — handy for maintenance commands like updating or launching a harness.
- **Sessions** — the launches you've started, with a **Connect** button that
  reopens the session in your terminal. Auto-pruned after 12h.
- **Agents** / **Harnesses** — the agents you can run skills as, and the
  launchers that actually run them.

The plugin also seeds one **example skill** into `.agents/skills/` on first run
(tagged `#example`) so a fresh install has something to explore. Editing or
deleting it is safe — it is never recreated.

## Launch modes: headless or terminal

Every skill/command can run one of two ways:

- **Headless** — spawned in the background (omnigent or a custom harness);
  progress surfaces via notices and the Sessions tab.
- **Terminal** — runs the *same* harness command, but visibly in a terminal
  window in the vault so you can watch it and interact.

Set the **default launch mode** and your **preferred terminal** in Settings →
*General*. The preferred-terminal list is autodetected from the emulators you
have installed (Terminal, iTerm, Ghostty, kitty, WezTerm, Warp, tmux); *Auto*
uses your OS default terminal. Override the mode per skill in its ⚙ Configure
panel.

## Harnesses (how skills get run)

A **harness** is the command that actually executes a skill — usually an AI CLI.
omnigent is supported out of the box; you can add your own for Claude Code,
Codex, or anything else.

**Add one manually:** Settings → *Skill and Harness Manager* → **Custom
harnesses** → give it a name and a one-line command whose first token is the
absolute path to the binary and which contains the `{prompt}` placeholder, e.g.:

```
/opt/homebrew/bin/claude -p {prompt}
```

The plugin substitutes the skill's prompt into `{prompt}` and runs it (no shell,
array arguments). Optionally set a **Resume command** so the Sessions tab's
*Connect* can reopen a session.

**Let the model add itself:** run this prompt inside your CLI (Claude Code,
Codex, omnigent, …) and it will register itself as a harness. The same prompt is
available with a copy button in the plugin's settings.

```
Register yourself as a launch harness in my Obsidian "Skill and Harness Manager" plugin.

1. Open the plugin config JSON at:
   <vault>/.obsidian/plugins/skill-harness-manager/data.json
2. Parse it as JSON and ensure it has a top-level "harnesses" array (create it if missing).
3. Append ONE entry describing how to run YOU non-interactively with a single prompt:
     {
       "id": "<short-kebab-id>",
       "label": "<your product name>",
       "command": ["<absolute path to your CLI>", "<non-interactive flags>", "{prompt}"]
     }
   Rules: command[0] must be an absolute path; exactly one element must contain the
   literal token {prompt}; leave every other key in the file unchanged; write back valid JSON.
   Optional: add "resumeCommand": ["<absolute CLI>", "<resume flags>"] (no {prompt}) to enable
   the Sessions tab's "Connect" button.
4. Tell me to reload the plugin (Settings → Community plugins → toggle it off and on),
   after which the new harness appears in the plugin.
```

## Requirements

Desktop only — it scans folders and launches local CLIs. Launching a skill needs
whatever CLI you configure; browsing, organizing, tagging, and filtering work
without one.

## Install

**From Obsidian:** Settings → Community plugins → Browse → search
**"Skill and Harness Manager"** → Install → Enable. No Node, no building.

**Manual / pre-release:** download `main.js`, `manifest.json`, and `styles.css`
from the [latest release](https://github.com/joeutke-dev/skill-harness-manager/releases)
into `<vault>/.obsidian/plugins/skill-harness-manager/`, then enable it.

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run smoke
npm run build
```

Releases are automated: push a tag (`git tag 0.1.2 && git push --tags`) and
`.github/workflows/release.yml` builds and publishes the assets.

## License

MIT
