# M11 — Slim the Skill Layer settings page to install/storage config only

**Branch:** `m11-slim-settings` (off the deployed M10 tip `b42c6d7`)

## Summary

M11 reduces the settings page to install/storage configuration only. Everything
explanatory, or duplicative of omnigent's own config, or now living in the M10
Agents tab / the browser view, is removed. This milestone is almost entirely
**surface removal** — plus one robustness fix carried over from the M10 review
(shell-quoting the copyable agent invocation).

The final settings page is exactly three controls, in order:

1. **Scan roots** — heading + description, the roots list (enable toggle /
   remove), and the "Add scan root" row (`inferKind` unchanged). The conditional
   external-path warning paragraph (`!canScanExternal()`) is kept.
2. **Omnigent binary path** — the `omnigentBinaryPath` text setting.
3. **Append vault-anchor instruction** — the `appendVaultAnchor` toggle (kept
   as-is).

## Removed

From `settingsTab.ts`:

- The top plugin-description paragraph ("Discover, browse, and pin…").
- The **Invocation template** Setting (and the `invocationTemplate` field). The
  skill-row "Copy invocation" action stays, but now uses a **fixed**
  natural-language format — `Use the <name> skill.` — consistent with how launch
  prompts are built. There is no user-configurable template anywhere.
- The "Launch" explanatory paragraph.
- The **Omnigent server URL** Setting (and the `omnigentServerUrl` field), the
  `--server` branch in `buildOmnigentArgv`, and the `serverUrl` argument at both
  launch call sites. **The plugin no longer passes `--server` at all** —
  omnigent's own `config.yaml` decides server routing (`omnigent run <agent>`
  with no `--server` already routes via the user's omnigent config). This
  removes the overlap with omnigent's own configuration.
- The entire **Agents** section (`renderAgentsSection`: heading, descriptions,
  built-in chips, custom chips, the "Refresh agents" button) — it lives in the
  M10 Agents tab now. Method + call removed; the now-unused `BUILTIN_AGENTS` and
  `Notice` imports dropped.
- The "Pinned ribbon icons" descriptive Setting.
- The entire **Tagging** section (heading + 3 paragraphs).
- The entire **Pinned skills** section (heading + per-skill Unpin buttons +
  empty-state paragraph). Pin/unpin is done from the browser view.

## Migration (fail-closed)

`loadSettings` now also strips `invocationTemplate` and `omnigentServerUrl` from
`data.json` (added to the existing legacy-key strip loop). A plain `delete`
cannot throw on absent/odd shapes, so existing installs load cleanly. Every
other setting — `scanRoots`, `pinnedSkillIds`, `rightClickSkillIds`,
`skillIcons`, the per-skill `skillAgent` map, `omnigentBinaryPath`,
`appendVaultAnchor` — is preserved by the `Object.assign` over defaults.

## Robustness fix (from M10 review)

`buildAgentInvocation` now **shell-quotes** the agent path (POSIX single-quote
wrap, escaping embedded single quotes as `'\''`) via a new pure
`shellSingleQuote` helper, so a path containing spaces or shell metacharacters
pastes safely into a shell as one argument. The fixed skill copy-invocation
embeds no path, so it needs no quoting.

## Security

This milestone only **removes** surface. `buildOmnigentArgv` loses its `--server`
branch but keeps everything else byte-identical: the spawn allowlist,
`shell:false`, `stdio`, the single `-p` element, and the validated skill/agent
positional path. The shared `spawnOmnigent` and `safeCustomAgentRealPath` are
**byte-identical** to `b42c6d7` (grep-proven via `diff`). No new network/auth
surface; shell-quoting only affects clipboard text, never argv (argv is spawned
with `shell:false`).

## Gates

- **tsc** = 0
- **eslint** = 0
- **build** = 0 (`main.js` = 42,665 bytes, down from M10's 47,955)
- **smoke** = 246 passed / 0 failed

New smoke coverage:

- Migration strips `invocationTemplate` + `omnigentServerUrl` and preserves
  every other setting; the empty-`data.json` case is a clean no-op.
- `buildOmnigentArgv` never emits `--server` in any launch form, even when a
  stale `serverUrl` value is passed.
- Skill copy-invocation `== "Use the <name> skill."` (and matches the
  launch-prompt base, no leading slash).
- Agent copy-invocation path is shell-quoted (incl. a spaces+metachars path and
  an embedded-single-quote path).

## Files

- `src/settingsTab.ts` — major: slimmed to the three-control page.
- `src/types.ts` — drop `invocationTemplate` + `omnigentServerUrl` (interface +
  `DEFAULT_SETTINGS`).
- `src/main.ts` — migration strip; fixed `copyInvocation` via
  `buildSkillInvocation`; drop `serverUrl` at both `buildOmnigentArgv` sites.
- `src/launch.ts` — drop `--server` from `buildOmnigentArgv`; add
  `buildSkillInvocation` + `shellSingleQuote`; shell-quote `buildAgentInvocation`.
- `test/smoke.mjs` — new/updated cases above.
