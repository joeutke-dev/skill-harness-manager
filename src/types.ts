// Shared types for the Skill Layer plugin.

/**
 * The harness tokens omnigent ships built-in, per `omnigent run --help`
 * (`'claude'` is documented as an alias for `'claude-sdk'`). These always
 * populate the per-skill selector even before a `--help` discovery has run, so
 * the dropdown is never empty. The "omnigent" DEFAULT is a SENTINEL (omit
 * `--harness` entirely) — NOT a token — and lives separately
 * (`OMNIGENT_HARNESS_SENTINEL` in launch.ts), so it is intentionally absent
 * here. Plugin-local state only — NEVER written into any SKILL.md.
 */
export const BUILTIN_HARNESSES = [
  "claude",
  "claude-sdk",
  "codex",
  "openai-agents",
  "open-responses",
  "pi",
] as const;

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
   * Per-skill harness choice, keyed by skill id (the same stable path used in
   * `skillIcons`/`pinnedSkillIds`). The value is a harness TOKEN (e.g. "codex");
   * absent key or the sentinel "omnigent" = default (preserves today's behavior,
   * usually omitting `--harness`). At launch the stored token is re-validated by
   * `resolveHarnessArg` against the effective allowed set and the strict charset,
   * so any unrecognized or stale value resolves fail-closed to the global
   * default. Plugin-local state only — never written into any SKILL.md.
   */
  skillHarness: Record<string, string>;
  /**
   * Harness tokens cached from the last successful `omnigent run --help` parse
   * (see `discoverHarnesses`). Refreshed on demand from Settings; never seeded
   * from user input. Plugin-local state only — never written into any SKILL.md.
   */
  discoveredHarnesses: string[];
  /**
   * Template for the skill invocation string (the `-p` prompt for launch, and
   * the "Copy invocation" clipboard text). Placeholders: {name} {path} {label}.
   */
  invocationTemplate: string;
  /** Absolute path to the omnigent binary; blank = auto-detect by probing. */
  omnigentBinaryPath: string;
  /** Omnigent server URL; blank = local daemon (omit --server). */
  omnigentServerUrl: string;
  /** Harness override; blank = omnigent default (omit --harness). */
  omnigentHarness: string;
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
  skillHarness: {},
  discoveredHarnesses: [],
  invocationTemplate: "/{name}",
  omnigentBinaryPath: "",
  omnigentServerUrl: "",
  omnigentHarness: "",
  appendVaultAnchor: true,
};
