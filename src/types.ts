// Shared types for the Skill and Harness Manager plugin.

import type { CustomHarness, SkillAgent } from "./launch";
import type { LaunchedSession } from "./sessions";
import type { Schedule } from "./schedules";

/**
 * How a skill/command/script is launched:
 * - `headless` — spawned detached (the prior behavior); output surfaces only via
 *   Notices and the Sessions tab.
 * - `terminal` — opens the user's default terminal running the preferred CLI (or,
 *   for a script, the script body) interactively in the vault.
 */
export type LaunchMode = "headless" | "terminal";

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
   * Absolute paths (= skill ids) whose skill is exposed in the EDITOR selection
   * right-click menu (editor-menu) as `Run "<name>"`. Membership
   * models the per-skill `editorMenuEnabled` toggle (default off = absent). At
   * launch the selected text and the current file's path are embedded as inert
   * prompt text (see `buildLaunchPrompt`), never as their own argv elements.
   * ORTHOGONAL to `rightClickSkillIds` — a skill can be in either, both, or
   * neither. Plugin-local state only — never written into any SKILL.md.
   */
  editorMenuSkillIds: string[];
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
  /**
   * Id (into `harnesses`) of the custom harness used when a skill's harness is
   * "Default". Blank/unset or a stale id means no default is configured, in
   * which case launching a skill with no explicit harness shows a Notice instead
   * of running. Set from Settings → Harnesses.
   */
  defaultHarnessId?: string;
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
   * Scheduled skill / prompt runs (Schedules tab). They fire only while Obsidian
   * is open; missed runs can be caught up on wake. Validated on load by
   * `normalizeSchedules`. Plugin-local state.
   */
  schedules: Schedule[];
  /**
   * Session monitoring: flag a headless run as STALLED after this many minutes
   * with no output (it may be hung on a login, an MCP server, or a long command).
   * The launch popup can override it per run.
   */
  stallMinutes: number;
  /** Flag a headless run as LONG-RUNNING once it passes this many minutes. */
  longRunMinutes: number;
  /**
   * Append the `NEEDS INPUT:` instruction to headless prompts, so a run that
   * can't continue without the user says so explicitly (and is flagged).
   */
  needsInputInstruction: boolean;
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
   * cmux integration: name of the cmux workspace that terminal-mode runs and
   * session Connects open into (as new tabs). Created on first use when absent.
   * Blank = the default ("Obsidian Sessions"). Plugin-local state.
   */
  cmuxWorkspaceName: string;
  /** cmux integration: bring cmux to the front (and select the workspace) on each open. */
  cmuxFocus: boolean;
  /**
   * cmux integration: post a cmux notification (to the plugin's workspace) when a
   * headless run finishes, fails or needs input — in addition to the Obsidian
   * notice. Only used when cmux is installed and reachable.
   */
  cmuxNotify: boolean;
  /**
   * Ghostty integration (Ghostty ≥ 1.3, AppleScript): open runs as a new TAB in
   * the front Ghostty window, or as a new WINDOW.
   */
  ghosttyOpenIn: "tab" | "window";
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
   * Preferred width (px) the browser side panel opens at, so the ribbon/command
   * open always uses a consistent "proper" width rather than whatever the user
   * last dragged the sidebar to. Applied best-effort to the right sidebar's
   * container on open (undocumented layout internals; no-ops if unavailable).
   */
  panelWidth: number;
  /**
   * When true, the plugin's UI (browser view + its modals) uses the font chosen
   * in Obsidian → Settings → Appearance → Text font (`--font-text`) instead of
   * the interface font. Applied as a body class (`skill-layer-inherit-font`);
   * monospace fields (script bodies, args) stay monospace.
   */
  inheritTextFont: boolean;
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
  editorMenuSkillIds: [],
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
  schedules: [],
  stallMinutes: 5,
  longRunMinutes: 30,
  needsInputInstruction: true,
  preferredTerminal: "",
  cmuxWorkspaceName: "",
  cmuxFocus: true,
  cmuxNotify: false,
  ghosttyOpenIn: "tab",
  defaultLaunchMode: "headless",
  skillLaunchMode: {},
  panelWidth: 520,
  inheritTextFont: false,
};
