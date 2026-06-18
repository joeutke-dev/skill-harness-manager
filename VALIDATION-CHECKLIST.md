# Skill Layer — Validation Checklist (M10 tabs + M11 slim settings)

All work below was gated (tsc/eslint/build), **cross-reviewed by codex (different
vendor than the implementer), BLOCKING 0**, smoke-tested **246/246**, deployed,
and backed up. Deployed `main.js` md5 == the reviewed source build. `data.json`
preserved on every deploy.

## Before you start
- [ ] **Cmd-R** in Obsidian to reload the plugin.

## M10 — Tabbed UI + Agents tab
- [ ] Open the Skill Layer pane → there's a **Skills | Agents** tab bar; default is **Skills**.
- [ ] **Skills tab** works exactly as before: search, tag filters, skill rows, and the per-skill **Run with** agent dropdown.
- [ ] Click **Agents** → **vault-agent** is listed (with its description).
- [ ] Agents → **Open file** on vault-agent → opens its `config.yaml`.
- [ ] Agents → **Launch session** → a UI-visible `omnigent run <vault-agent>` session opens (appears in your omnigent UI).
- [ ] Agents → **Copy invocation** → clipboard holds: `omnigent run '<abs-path>' -p "<your prompt here>"` (path is single-quoted).
- [ ] Switch Agents → Skills and back → tab state holds; Skills content intact.

## M11 — Slim settings
- [ ] Settings → Skill Layer shows **only**: **Scan roots** (+ add/remove/enable), the external-path warning (if applicable), **Omnigent binary path**, **Append vault-anchor instruction** toggle.
- [ ] These are **gone**: plugin blurb, Invocation template, Launch paragraph, **Omnigent server URL**, the **Agents section + Refresh button**, Pinned ribbon icons, Tagging section, **Pinned skills / Unpin** list.
- [ ] Scan roots still add/remove/toggle correctly.
- [ ] Your existing settings survived the upgrade: per-skill agent choices, pinned skills, right-click-menu skills are all still set (migration preserved them; only the removed fields were stripped).

## Behavior changes to confirm (by design)
- [ ] **No more `--server`**: launches now defer entirely to your omnigent `config.yaml` for server routing. Confirm a skill/agent launch still appears in your omnigent UI (it should — your config has `server:` set).
- [ ] **Skill "Copy invocation"** now produces the fixed string `Use the <name> skill.` (the configurable template was removed).

## Judgment calls flagged for YOUR decision
- [ ] **"Append vault-anchor instruction" toggle** — I KEPT it, but it's launch-*behavior*, not install/storage config, so by your stated principle it arguably should go. Tell me to remove it or keep it.

## Open item (separate from M10/M11)
- [ ] **Vault Agent skills surfacing** — after the `os_env: {sandbox: {type: none}}` fix, please re-test from the vault:
  `cd ~/Documents/Obsidian/Vault && omnigent run .omnigent/agent-configs/vault-agent/ -p "Use the daily-note skill."`
  If the 9 skills surface / daily-note runs → done. If still empty, I'll chase the claude-sdk `setting_sources` angle (the last untested hypothesis).

## Provenance
- Milestones: M10 `b42c6d7`, M11 `b14ef40` (source repo `~/skill-layer`). Vault backup tip on push.
- main.js: 47,955 B (M10) → 42,665 B (M11, smaller — settings code removed).
