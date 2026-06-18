# Skill Layer M8 — Per-skill AGENT selector (replaces the harness selector)

**Branch:** `m8-per-skill-agent` (off the deployed M7 tip `5090e81`)
**Commit:** `f331044`

## What

Replace the M1–M7 harness selector with a per-skill **"Run with" AGENT**
selector. A skill is tied to a specific omnigent agent; **omnigent picks the
harness**. All harness UI + machinery is removed; the scaffolding (per-skill
state map, centered dropdown styling, fail-closed resolution) is reused.

### Dropdown options (per skill)
1. **Default** (always first, unchanged behavior) → `omnigent run -p "<invocation>"`
2. **Built-in agents** (hardcoded allowlist `{polly, debby}`) → `omnigent <name> -p "..."` (subcommand form, **not** `run`)
3. **Custom agents (dynamic)** — scanned from `<vault>/.omnigent/agent-configs/*.yaml|*.yml`; label = top-level `name:` (else filename stem), tooltip = `description:` → `omnigent run <abs config.yaml> -p "..."`

### Per-skill stored value (security-critical)
Discriminated union persisted under `skillAgent[skillId]`:
`{kind:'default'}` | `{kind:'builtin', name}` | `{kind:'custom', path}`.
Resolved **fail-closed** at launch by `resolveAgentLaunch`:
- **builtin** — name must be in the hardcoded allowlist → emitted as the subcommand token; else Default.
- **custom** — path must be absolute, a **direct child** of the scan dir, end in `.yaml`/`.yml`, **and still exist** → emitted as a **single inert positional after `run`** (absolute ⇒ never a flag, never split); else Default.
- unknown / missing → Default.

The display label/description **never** reach argv — only the validated path does.

### Migration
On load, `skillHarness`, `discoveredHarnesses`, `customHarnesses`, and
`omnigentHarness` are stripped from `data.json` (plain `delete`, cannot throw).
A skill that had a harness selected reverts to Default. Everything else is preserved.

## Security invariants (byte-identical)
spawn allowlist, `shell:false`, `stdio` ignore, single `-p` prompt element,
natural-language invocation. The harness-discovery spawn (`omnigent run --help`)
is **removed entirely** — no new network/auth surface. The `launchSkill` spawn
block and binary allowlist/PATH hardening are untouched (verified by diff).

## Gates
- `tsc` = 0, `eslint` = 0, `build` = 0
- smoke: **138 passed / 0 failed**
- `main.js` = **42,485 bytes**
- Harness machinery: **0 functional refs** (only doc comments + migration key-strings remain)

This pull request and its description were written by Isaac.
