# AI Skill Manager

A desktop-only Obsidian plugin that discovers, browses, and launches the AI
**skills, commands, and agents** scattered across your vault and your coding
tools' dot-folders (`.claude/`, `.codex/`, `.cursor/`, `.agents/`, …) — in one
place, with a ribbon icon and command-palette access.

> No bundled model, no inference, no network calls. It *discovers, displays, and
> launches* — the actual work runs in whatever AI CLI you point it at.

## What it does

- **Unified browser** (`brain-circuit` ribbon icon) with tabs:
  - **Skills** / **Commands** — every `SKILL.md` / command file found across your
    scan roots, grouped into a collapsible source-folder tree, each shown with its
    description and tags.
  - **Sessions** — the launches you've started, with a **Connect** button that
    reopens the session in your terminal (per-tool resume). Auto-pruned after 12h.
  - **Agents** / **Harnesses** — discovered agents and the launchers you can run
    skills through.
- **Filter bar** — multi-select dropdowns for agent, harness, tag, and access
  (right-click / ribbon), plus free-text search.
- **Launch** — run a skill through omnigent or a custom harness you define (any
  absolute binary with a `{prompt}` token). Spawned with `shell: false` and array
  arguments; the plugin passes only the invocation, never your file contents.
- **Pin to ribbon** — pin any skill to its own ribbon icon (searchable Lucide
  picker) and register a command for it.
- **Right-click launch** — enable a skill in the file-explorer context menu to run
  it against the clicked file.
- **Tagging** — resolves tags from frontmatter, description `#tags`, and folder
  location; the only writes the plugin makes are explicit tag add/remove on the
  frontmatter `tags:` field.

## Requirements

Desktop only (uses Node/Electron to scan folders and launch CLIs). Launching a
skill requires the external CLI you configure (e.g. `omnigent`); browsing,
filtering, and tagging work without one.

## Settings

- **Scan roots** — the directories to discover skills/commands/agents in
  (vault-relative or absolute). Sensible defaults are pre-seeded.
- **Omnigent binary path** and **Omnigent server** — optional launch config.
- **Custom harnesses** — define your own launch command (and an optional resume
  command used by the Sessions tab).
- **Show hidden folders** — optionally reveal dot-folders in the file explorer.

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm run smoke       # pure-logic smoke tests
npm run build       # tsc + esbuild production → main.js
```

## Install manually

Copy `main.js`, `styles.css`, and `manifest.json` into
`<vault>/.obsidian/plugins/ai-skill-manager/`, then enable **AI Skill Manager**
in *Settings → Community plugins*.

## License

MIT
