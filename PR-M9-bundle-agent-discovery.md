# Skill Layer M9 — bundle-directory custom-agent discovery

Branch: `m9-bundle-agent-discovery` (off M8 tip `c7e2322`). No git remote is
configured for a hosted PR, so this file is the PR description.

## Why

A full omnigent spec (one that declares `spec_version`) MUST live as a bundle
directory `<scanDir>/<name>/config.yaml`, not a loose `*.yaml`. M8's discovery
only enumerated loose `*.yaml`/`*.yml` direct children, so real bundle agents —
including this vault's own `.omnigent/agent-configs/vault-agent/` — never showed
up in the per-skill AGENT picker. This change teaches discovery, launch, and the
security validator to handle BOTH forms.

## What changed (`src/launch.ts`, `src/main.ts`)

- **Discovery (`discoverCustomAgents`)** now enumerates two kinds of DIRECT
  children of the scan dir:
  1. LOOSE FILE — a child ending `.yaml`/`.yml`; launch path is the FILE.
  2. BUNDLE DIR — a child directory that directly contains a regular
     `config.yaml`; launch path is the DIRECTORY (`omnigent run <dir>` is
     canonical — never the `config.yaml` inside it).
  Subdirs without `config.yaml` and non-yaml files are ignored. Display label is
  the top-level `name:` (read from the file, or from `<dir>/config.yaml`), with a
  filename-stem (loose) / directory-name (bundle) fallback. Bundle detection
  requires the injected `isDirectory` callback; without it only loose files are
  enumerated (the pre-M9 behavior, so existing tests are unaffected).

- **Validator (`safeCustomAgentRealPath`, still fail-closed, never throws)** — a
  custom path resolves ONLY if, in addition to the existing checks (raw `..`
  rejected pre-resolve; absolute; realpath a REAL DIRECT CHILD of the real scan
  dir), the realpath is EITHER (a) a regular FILE ending `.yaml`/`.yml`, OR (b) a
  DIRECTORY directly containing a regular file `config.yaml`. Anything else →
  `null` → caller falls back to Default. The emitted argv element is the
  validated real path (file or dir). The lexical gate (`isValidCustomAgentPath`)
  now also accepts an extension-less direct child (a candidate bundle dir) while
  still rejecting any other extension (e.g. `.txt`) and all `..` traversal.

- **Launch (`buildOmnigentArgv`)** unchanged in shape: the custom path is still a
  single inert positional after `run`; no `--harness`. It is now either a loose
  file or a bundle directory.

- **Stored value** unchanged: `{kind:'custom', path}` where `path` is now either
  a loose yaml file or a bundle directory. builtin/default unchanged.

- **Settings** — the discovered list + Refresh now show both loose and bundle
  agents (e.g. `vault-agent`) with no other UI change (the section already renders
  whatever discovery returns).

## Unchanged (grep-proven byte-identical)

Spawn hardening (`spawn(argv[0], argv.slice(1))`, `shell:false`, stdio, binary
allowlist `isAllowedOmnigentPath`), the builtin allowlist (`BUILTIN_AGENTS` /
`isAllowedBuiltinAgent`), and the minimal YAML scalar reader
(`parseAgentConfigYaml` / `unquoteScalar`, now also used to read
`<dir>/config.yaml`).

## Gates

- `tsc --noEmit` = 0, `eslint` = 0, `npm run build` = 0
- smoke: **188 passed, 0 failed** (158 pre-existing + 30 new across sections
  `[m]` injected-fs and `[n]` real-fs bundle fixtures)
- `main.js` = 43441 bytes
- Verified end-to-end against the real vault: `vault-agent/` is discovered and
  resolves to `omnigent run <vault>/.omnigent/agent-configs/vault-agent`.
