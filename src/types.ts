// Shared types for the Skill and Harness Manager plugin.

import type { CustomHarness, SkillAgent } from "./launch";
import type { LaunchedSession } from "./sessions";

/**
 * How a skill/command/script is launched:
 * - `headless` — spawned detached (the prior behavior); output surfaces only via
 *   Notices and the Sessions tab.
 * - `terminal` — opens the user's default terminal running the preferred CLI (or,
 *   for a script, the script body) interactively in the vault.
 */
export type LaunchMode = "headless" | "terminal";

/**
 * A user-defined bash script (Bash Scripts tab). Stored plugin-local in data.json;
 * `body` is a full shell script authored by the user and run ONLY on an explicit
 * click (same trust model as custom harnesses). `launchMode` is per-script.
 */
export interface BashScript {
  /** Stable id (generated from the label). */
  id: string;
  /** Display name. */
  label: string;
  /** Optional one-line description shown on the row. */
  description?: string;
  /** The shell script body (multi-line allowed). */
  body: string;
  /** headless (detached, Notices only) or terminal (visible, live output). */
  launchMode: LaunchMode;
}

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
   * host URL like `https://your-omnigent-host`) is passed as
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
   * Sessions the plugin has launched (M20), newest-appended. Each is a resumable
   * omnigent/claude/codex conversation shown in the Sessions tab. Pruned on view
   * (dropped when older than 12h or no longer resumable). Plugin-local state.
   */
  sessions: LaunchedSession[];
  /**
   * Preferred TERMINAL EMULATOR id (a `KNOWN_TERMINALS` id from `terminal.ts`)
   * used for TERMINAL launches — which terminal app opens to run the skill's
   * harness command. Blank / "auto" = the OS default terminal. Re-validated
   * fail-closed at launch by `resolvePreferredTerminal` against the
   * actually-detected set, so a stale/uninstalled id falls back to auto.
   * Plugin-local state.
   */
  preferredTerminal: string;
  /**
   * Global default launch mode for skills/commands (headless or terminal). A
   * per-item override in `skillLaunchMode` wins when present. Default `headless`
   * (the prior behavior). Plugin-local state.
   */
  defaultLaunchMode: LaunchMode;
  /**
   * Per-item launch-mode OVERRIDE, keyed by skill/command id (the same stable
   * path used across the other per-skill maps). Absent key = use
   * `defaultLaunchMode`. Plugin-local state; never written into any SKILL.md.
   */
  skillLaunchMode: Record<string, LaunchMode>;
  /**
   * User-defined bash scripts (Bash Scripts tab). Each is `{id,label,description?,
   * body,launchMode}`; the body runs only on explicit click. Managed from the
   * tab's add/edit form. Plugin-local state — never written into any SKILL.md.
   */
  bashScripts: BashScript[];
  /**
   * Preferred width (px) the browser side panel opens at, so the ribbon/command
   * open always uses a consistent "proper" width rather than whatever the user
   * last dragged the sidebar to. Applied best-effort to the right sidebar's
   * container on open (undocumented layout internals; no-ops if unavailable).
   */
  panelWidth: number;
  /**
   * True once the bundled example skill has been seeded to
   * `<vault>/.agents/skills/`. Set after the first successful seed so deleting the
   * example never recreates it. Plugin-local state.
   */
  seededExample?: boolean;
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
  sessions: [],
  preferredTerminal: "",
  defaultLaunchMode: "headless",
  skillLaunchMode: {},
  bashScripts: [],
  panelWidth: 520,
};
