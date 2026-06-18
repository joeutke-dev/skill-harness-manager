// Shared types for the Skill Layer plugin.

import type { SkillAgent } from "./launch";

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

/** A single discovered skill. */
export interface Skill {
  /** Stable id = the normalized absolute path. Used for pins, commands, dedupe. */
  id: string;
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
   * Template for the skill invocation string (the `-p` prompt for launch, and
   * the "Copy invocation" clipboard text). Placeholders: {name} {path} {label}.
   */
  invocationTemplate: string;
  /** Absolute path to the omnigent binary; blank = auto-detect by probing. */
  omnigentBinaryPath: string;
  /** Omnigent server URL; blank = local daemon (omit --server). */
  omnigentServerUrl: string;
  /** Append the generic vault-anchor instruction to the launch prompt. */
  appendVaultAnchor: boolean;
  /**
   * @deprecated Legacy global pinned-ribbon icon. No longer set by the UI;
   * retained ONLY as a one-time migration fallback for pins created before
   * per-skill icons existed. Optional so new installs omit it.
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
  invocationTemplate: "/{name}",
  omnigentBinaryPath: "",
  omnigentServerUrl: "",
  appendVaultAnchor: true,
};
