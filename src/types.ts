// Shared types for the Skill Layer plugin.

import type { CustomHarness, SkillAgent } from "./launch";

/** How a scan root is walked. Determines which of the two+1 code paths runs. */
export type RootKind = "vault" | "adapter" | "external";

/** How a given skill was discovered (mirrors the root kind that found it). */
export type DetectionMethod = "vault" | "adapter" | "external";

/**
 * Where a resolved tag came from.
 * - `frontmatter` — the YAML `tags:` field. This is the SINGLE authoritative
 *   place the UI writes; only these chips are removable.
 * - `description` — a `#tag` token in the description text. READ-ONLY in the
 *   UI (edit the note to change it).
 * - `folder` — derived/virtual from the file's location. Never written, READ-ONLY.
 */
export type TagOrigin = "frontmatter" | "description" | "folder";

/** A resolved tag attached to a skill, labeled by origin for the UI. */
export interface SkillTag {
  tag: string;
  origin: TagOrigin;
}

/** A configurable directory the detector scans for skills. */
export interface ScanRoot {
  /**
   * For `vault`/`adapter` roots: a vault-relative path (`""` = vault root,
   * `.claude/skills`, `skills`, …). For `external` roots: an absolute
   * filesystem path.
   */
  path: string;
  kind: RootKind;
  enabled: boolean;
}

/** A discovered browsable item: a skill (default) or a command (M18). Both share
 *  the same shape and reuse the same row UI / per-item state (pins, right-click,
 *  harness, agent) keyed by `id`; only discovery + launch wording differ. */
export type ItemKind = "skill" | "command";

/** A single discovered skill (or command — see `kind`). */
export interface Skill {
  /** Stable id = the normalized absolute path. Used for pins, commands, dedupe. */
  id: string;
  /** "skill" (default/absent) or "command" (M18). */
  kind?: ItemKind;
  name: string;
  description: string;
  /** Absolute filesystem path to the skill markdown file. */
  path: string;
  /** Vault-relative path when the file lives inside the vault, else null. */
  vaultPath: string | null;
  /** The configured root (its `path`) that surfaced this skill. */
  sourceRoot: string;
  /** Inferred harness/source label, e.g. `.claude`, `codex`, `vault`. */
  sourceLabel: string;
  detection: DetectionMethod;
  /** Resolved, deduped, sorted tags from description + frontmatter + folder. */
  tags: SkillTag[];
}

export interface SkillLayerSettings {
  scanRoots: ScanRoot[];
  /** Absolute paths (= skill ids) pinned to their own ribbon icon. */
  pinnedSkillIds: string[];
  /**
   * Absolute paths (= skill ids) whose skill is exposed in the file explorer
   * right-click (file-menu) as `Run "<name>" here`. Per-skill `rightClickEnabled`
   * is modeled as membership here (default off = absent). Plugin-local state
   * only — never written into any SKILL.md.
   */
  rightClickSkillIds: string[];
  /**
   * Per-skill Lucide icon for the pinned ribbon icon, keyed by skill id (the
   * same stable path used in `pinnedSkillIds`). Plugin-local state only — never
   * written into any SKILL.md.
   */
  skillIcons: Record<string, string>;
  /**
   * Per-skill AGENT choice, keyed by skill id (the same stable path used in
   * `skillIcons`/`pinnedSkillIds`). The value is a discriminated object
   * (`{kind:'default'}` | `{kind:'builtin',name}` | `{kind:'custom',path}`); an
   * absent key = the Default agent. At launch the stored value is re-validated
   * fail-closed by `resolveAgentLaunch` (built-in name must be in the hardcoded
   * allowlist; custom path must still exist inside the scan dir and end in
   * .yaml/.yml), so any unrecognized or stale value resolves to Default. Plugin-
   * local state only — never written into any SKILL.md.
   */
  skillAgent: Record<string, SkillAgent>;
  /**
   * Per-skill omnigent HARNESS choice (M15), keyed by skill id (same stable path
   * used in `skillAgent`/`skillIcons`). The value is a harness NAME string; an
   * absent key = no `--harness` (omnigent uses its own configured default).
   * ORTHOGONAL to `skillAgent` — a skill can pin both an agent and a harness. At
   * launch the value is re-validated fail-closed by `resolveHarness` against the
   * hardcoded `OMNIGENT_HARNESSES` allowlist, so any unrecognized or stale value
   * (incl. a legacy object shape from the removed M4–M7 harness selector) simply
   * emits no `--harness`. Plugin-local state only — never written into any
   * SKILL.md.
   */
  skillHarness: Record<string, string>;
  /**
   * Per-skill CLAUDE SUBAGENT choice (M17), keyed by skill id. The value is a
   * `.claude/agents/*.md` subagent NAME. Applies ONLY when the skill's harness is
   * a claude-based CUSTOM harness (omnigent agents live in `skillAgent`); it is
   * substituted into the harness command's `{agent}` token at launch. An absent
   * key = no agent. Re-validated against the discovered subagents before use, so
   * a stale name degrades to none. Plugin-local; never written into any SKILL.md.
   */
  skillClaudeAgent: Record<string, string>;
  /**
   * User-defined custom harnesses (M15.3) — arbitrary external commands the
   * per-skill Harness dropdown can select instead of an omnigent `--harness`.
   * Each is `{id, label, command[]}` where `command[0]` is an absolute binary
   * and one token holds `{prompt}`. This is the plugin's only non-omnigent spawn
   * target; every launch re-validates fail-closed (`resolveSkillHarness` +
   * `isValidCustomHarnessCommand` + an existence check on the binary). Managed
   * from the Harnesses tab. Plugin-local state — never written into any SKILL.md.
   */
  harnesses: CustomHarness[];
  /** Absolute path to the omnigent binary; blank = auto-detect by probing. */
  omnigentBinaryPath: string;
  /**
   * Omnigent `--server` target for launches (M19). Blank = omit `--server` so
   * omnigent uses its own config/default routing. A value (e.g. `local` or a
   * host URL like `https://<app>.cloud.databricks.com`) is passed as
   * `--server <value>` on every omnigent launch: with a host URL this selects
   * omnigent's local-runner + remote-server topology (work runs LOCALLY in the
   * vault, models come from the host), which sends a RELATIVE cwd the multi-
   * tenant server accepts — avoiding the absolute-cwd rejection that occurs when
   * omnigent falls back to connecting directly to a remote server. The host URL
   * changes over time, so this is user-editable in Settings. Passed as a single
   * inert argv element (shell:false); a value with whitespace is ignored.
   */
  omnigentServerUrl: string;
  /** Append the generic vault-anchor instruction to the launch prompt. */
  appendVaultAnchor: boolean;
  /**
   * Reveal hidden dot-folders (e.g. `.claude/`) in Obsidian's file explorer
   * (M15). When on, the plugin patches the vault adapter's private reconcile
   * path to surface dotfiles and suppresses the "bad dotfile" warning; when off
   * (default), the explorer behaves normally. Cleanly reverted on toggle-off and
   * on unload. NOTE: relies on undocumented Obsidian internals (see
   * `hiddenFiles.ts`).
   */
  showHiddenFolders: boolean;
  /**
   * Global default pinned-ribbon icon — the fallback used by any pinned skill
   * that has no per-skill icon in `skillIcons`. Set via the settings selector
   * (also the migration fallback for pins created before per-skill icons).
   * Optional so new installs omit it and fall back to DEFAULT_PINNED_ICON.
   */
  pinnedIcon?: string;
}

export const DEFAULT_SETTINGS: SkillLayerSettings = {
  scanRoots: [
    { path: "", kind: "vault", enabled: true },
    { path: ".claude/skills", kind: "adapter", enabled: true },
  ],
  pinnedSkillIds: [],
  rightClickSkillIds: [],
  skillIcons: {},
  skillAgent: {},
  skillHarness: {},
  skillClaudeAgent: {},
  harnesses: [],
  omnigentBinaryPath: "",
  omnigentServerUrl: "",
  appendVaultAnchor: true,
  showHiddenFolders: false,
};
