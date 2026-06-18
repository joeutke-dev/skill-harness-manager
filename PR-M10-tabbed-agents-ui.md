# Skill Layer M10 — tabbed UI + Agents tab

Branch: `m10-tabbed-agents-ui` (off the deployed M9 tip `a1a1a3c`). No git remote
is configured for a hosted PR, so this file is the PR description.

## Why

The browser view rendered a single skills list. M10 splits it into a two-tab
layout — **Skills** | **Agents** — and adds an Agents tab that surfaces the
custom omnigent agents M9 taught the plugin to discover, with Open / Launch /
Copy-invocation actions. The Settings "Refresh agents" button moves onto this tab
(Settings loses it next milestone), so agents are managed where they're shown.

## What changed

### `src/tabs.ts` (new, pure — no Obsidian)
Tab set + default (`DEFAULT_TAB = "skills"`), a fail-safe `normalizeTab` (anything
but `"agents"` → `"skills"`), `AGENTS_EMPTY_TEXT`, and `buildAgentsTabModel` — the
Agents-tab render model (empty-state vs. N rows, preserving discovery order;
description → subtitle). Unit-testable; the smoke suite bundles it directly like
`viewToggle.ts`.

### `src/view.ts` (major)
- A **tab bar** (Skills | Agents) below the unchanged title + Rescan control;
  `activeTab` tracked in view state, default Skills. Clicking a tab re-renders so
  both the active-tab highlight and the content update.
- **Skills tab** = the EXISTING browser, moved verbatim under the tab. The search
  box, active-filter bar, tag facet, and skill rows (Open, Launch, Copy
  invocation, right-click toggle, "Run with" agent dropdown, pin/change-icon) are
  unchanged — every skill-row method (`renderList`, `renderRow`, `renderFacet`,
  `matches`, …) is byte-identical to M9 (the only move is the search input from
  the view root into the Skills tab container). `refresh()` now re-renders the
  active tab.
- **Agents tab** = a Refresh control + the discovered custom agents. Each row
  shows the display name + description (subtitle and a name tooltip) with three
  actions wired to new plugin methods.

### `src/main.ts`
- `launchSkill` refactored to call two extracted helpers — `resolveBinaryOrNotice`
  (binary allowlist/resolution) and `spawnOmnigent` (the single hardened spawn
  surface). Behavior + Notices unchanged; this keeps ONE spawn block shared by
  skill and agent launch.
- New: `validateAgentPath` (re-validates via `safeCustomAgentRealPath`),
  `openCustomAgent`, `launchCustomAgent`, `copyCustomAgentInvocation`.

### `src/launch.ts`
- `AGENT_SESSION_PROMPT` (default non-interactive opening prompt),
  `AGENT_INVOCATION_PLACEHOLDER`, and `buildAgentInvocation` (the copyable CLI
  string). Pure additions only.

### `styles.css`
Tab-bar styling (active/inactive states, accent underline on active) + an
Agents-tab toolbar; rows reuse the existing skill-row action-button styling.

## Agents-tab actions

1. **Open file** — `.omnigent/` is a dot-folder outside the Vault API index, so
   (exactly like `openSkill`'s non-indexed branch) the config is opened with
   Electron `shell.openPath`; a bundle's launch path is the DIRECTORY, so we open
   `<dir>/config.yaml`, a loose agent path is the file itself. If it can't be
   opened, a Notice shows the absolute path.
2. **Launch session** — `omnigent run <validated-real-path> -p "<default prompt>"`
   in the vault (cwd = vaultBasePath) via the shared hardened `spawnOmnigent`. The
   path is re-validated through `safeCustomAgentRealPath`; on failure it Notices
   and does NOT spawn. The spawn is non-interactive (stdio ignored), so the
   default prompt opens a visible session.
3. **Copy invocation** — copies
   `omnigent run <validated-abs-agent-path> -p "<your prompt here>"` (validated
   absolute path) with a confirmation Notice.

## Security (unchanged invariants)

- `safeCustomAgentRealPath` is reused for BOTH launch and copy-invocation path
  resolution (a path failing validation → no spawn / nothing copied).
- The spawn block (`spawn(argv[0], argv.slice(1))`, `shell:false`,
  `stdio:[ignore,ignore,pipe]`) is grep-proven **byte-identical** to M9 and now
  exists exactly ONCE (shared). The binary allowlist/resolution
  (`isAllowedOmnigentPath`, `resolveOmnigentBinary`) are byte-identical.
- The agent path reaching argv is a single inert validated real-path element.
- No new network/auth surface.

## Gates

- `tsc --noEmit` = 0, `eslint src` = 0, `npm run build` = 0
- smoke: **225 passed, 0 failed** (195 pre-existing + 30 new in section `[p]`:
  tab-switch state, Agents-tab render model for N agents + empty state, agent
  launch argv shape, copy-invocation format, and launch-path validation
  rejection)
- `main.js` = 47955 bytes
- Grep-proven byte-identical: spawn hardening, binary allowlist + resolution.

Sample agent-launch argv:
`[bin, "run", "<vault>/.omnigent/agent-configs/vault-agent", "-p", "Hi — what can you help with in this vault?"]`

Sample copy-invocation:
`omnigent run <vault>/.omnigent/agent-configs/vault-agent -p "<your prompt here>"`
