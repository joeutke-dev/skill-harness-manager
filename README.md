# Skill Layer

A desktop-only Obsidian plugin that makes your vault a **visibility +
consolidation layer** for AI skills. It auto-detects `SKILL.md` files scattered
across your vault, dot-folders (`.claude/skills/`), and external desktop
directories, presents them with descriptions in one browser view, and lets you
**pin any skill to its own ribbon icon**.

> No bundled LLM, no inference. This plugin discovers, displays, and (minimally)
> launches skills — it never runs a model.

## Features

- **Two-path detection** (PRD §4):
  - **Vault API + `metadataCache`** for non-dot folders (`skills/`,
    `claude/skills`, …).
  - **DataAdapter recursive walk** for dot-folders the Vault API cannot see
    (e.g. `.claude/skills/`) — `adapter.list()` is non-recursive, so the walk is
    hand-rolled, with `adapter.read()` + a manual YAML frontmatter parse.
  - **Node `fs`** for external absolute-path roots, gated by
    `Platform.isDesktopApp` **and** `adapter instanceof FileSystemAdapter`.
- **What counts as a skill:** a `SKILL.md` with frontmatter `name` + `description`,
  or any markdown file directly under a folder named `skills/` (falls back to
  filename + first heading).
- **Skills browser** (`ItemView`): grouped by source, with search/filter and
  per-row *Open file*, *Launch*, and *Pin to ribbon* actions. Open from the
  ribbon (layers icon) or the command palette.
- **Per-skill ribbon pinning with a custom icon:** pin any skill to its own
  ribbon icon and pick that icon per skill from a searchable Lucide picker
  (built on Obsidian's bundled icon set — no extra dependency). Use **Pin to
  ribbon** to pin (the first time, choosing the icon *is* the pin), **Change
  icon** to re-icon an existing pin, and **Unpin** to remove it. Each pin also
  registers a `Skill Layer: Run <name>` command. Pins and icon choices persist
  across reloads in `data.json` — never written into any `SKILL.md`. Your icon
  choice is **remembered across unpin/re-pin**: re-pinning a skill reuses its
  last icon immediately (no picker) as long as that icon still resolves; if it
  doesn't (or you never chose one), the picker opens. (Pins created before
  per-skill icons existed keep working: they fall back to the old global default
  icon until you choose one.)
- **Launch (one-shot omnigent run):** clicking a pinned ribbon icon — or a skill
  row's **Launch** — spawns a UI-visible, one-shot `omnigent run` in the vault
  directory, invoking the skill via its invocation prompt. Desktop-only; the
  plugin spawns **only** the `omnigent` binary (auto-resolved to an absolute
  path), with array arguments and `shell: false`, and the invocation is passed
  as a single inert `-p` element. Any files the run writes land in the real
  vault (its `cwd`); the plugin itself writes nothing. Configure the binary
  path, server URL, harness, and vault-anchor suffix in settings.
- **Open file / Copy invocation:** a row's **Open file** opens the `SKILL.md`;
  **Copy invocation** copies the invocation string to the clipboard (the
  pre-launch behavior, kept as its own action).
- **Hot-reload:** Vault-API roots refresh live via `vault.on(...)` events;
  dot-folder / external roots refresh on view open and via the **Rescan**
  command.
- **Skill tagging:** each skill resolves a deduped, sorted tag set from three
  sources, rendered as chips in the browser and labeled by origin:
  1. the frontmatter `tags:` field (scalar or list, with/without leading `#`) —
     **authoritative**, the only chips with a remove **×**,
  2. `#tag` tokens in the `description:` value (Obsidian token rules; nested
     `parent/child`) — **read-only** (muted, dotted; edit the note to change),
  3. a **derived/virtual folder tag** from the file's location (e.g.
     `.claude/skills/bar/SKILL.md` → `claude`) — **read-only** (dimmed, "auto
     from folder" tooltip), never written to disk.
  A tag present in more than one source resolves with the highest-priority
  origin (frontmatter > description > folder). Click any chip (or the tag facet)
  to filter; tag filters AND-combine with the text search, with a clear-all.

## Tagging writes (frontmatter is the single source of truth)

This plugin is otherwise **read-only**. The *only* writes it performs happen
when you explicitly **add** or **remove** a tag, and they touch **only the
frontmatter `tags:` field** — never the description:

- **+ tag** adds to frontmatter `tags:` (creating the list, or the whole
  frontmatter block, if absent). It's a no-op (with an informative Notice) if
  the tag is already in frontmatter or is an auto folder tag; if the tag exists
  only in the description text, adding it **promotes** it into the authoritative,
  natively-indexed frontmatter list (and it then becomes removable).
- **×** (frontmatter chips only) removes the tag from `tags:`, cleaning up an
  emptied list. Description and folder chips have no × — to change a description
  `#tag`, edit the note.
- In-vault files use Obsidian's safe `processFrontMatter`; external / dot-folder
  files use an idempotent raw `tags:` rewrite via the adapter / Node `fs`.
- **Formatting:** the BOM, line endings (incl. CRLF), document body, the
  `description:`, and all other frontmatter keys are preserved. The `tags:`
  field is normalized to a compact inline list (`tags: [a, b]`) on the raw
  (external/dot-folder) path — tag tokens are flow-safe, so this is intentional
  and lossless for the tag set, not a round-trip of any original block-list style.

**Native integration:** because UI writes land in frontmatter `tags:`, *in-vault*
skills become visible to Obsidian's native tag pane and search. *External /
dot-folder* skills (e.g. `.claude/skills`) live outside the vault index, so
Obsidian doesn't index their tags — only this plugin's tag layer applies to them.

## Settings

- **Scan roots** — add/remove/enable. The code path (vault / adapter / external)
  is inferred from the path: absolute → external, leading-dot segment → adapter,
  otherwise vault. Defaults: vault root + `.claude/skills`.
- **Invocation template** — `{name}`, `{path}`, `{label}` placeholders
  (default `/{name}`).
- *(Removed)* the global **Pinned ribbon icon** setting — each pinned skill now
  picks its own icon from the Skill Layer view. Any old value is read only as a
  one-time migration fallback.
- **Tagging** — help text explaining the three tag sources, the explicit-only
  write posture, and that external/dot-folder skills aren't natively indexed by
  Obsidian (only the plugin's tag layer applies to them).

## Build

```bash
npm install
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm run build       # tsc + esbuild production → main.js
```

## Install into a vault

Copy this folder to `<vault>/.obsidian/plugins/skill-layer/` (it already
contains the built `main.js`, `styles.css`, and `manifest.json`), then enable
**Skill Layer** in *Settings → Community plugins*.

## Roadmap

- **F2 — CLI launch (M1 implemented).** Launch spawns a one-shot `omnigent run`
  (see **Launch** above). Process execution is **omnigent-only** (allowlist),
  array-args with `shell: false`, absolute auto-resolved binary, and the
  invocation passed as a single inert `-p` element. SKILL.md *content* is never
  passed as process input — only the invocation string and a fixed suffix.
  Broadening the allowlist beyond `omnigent` is out of scope and would need its
  own security review.
- **F1 — Publish/mirror (not implemented).** Mirror discovered skills into
  `~/.claude/skills`, `~/.codex/skills`, etc.

The plugin still writes **no** SKILL.md content of its own — the only file
writes it makes are frontmatter `tags:` on explicit user action; a launched
omnigent run may write files itself, but that is the run, not the plugin.

## License

MIT
