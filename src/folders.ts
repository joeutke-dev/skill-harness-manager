// Canonical per-tool folder mapping (M18), adapted from the Agentfiles plugin's
// "Supported Tools" table (https://community.obsidian.md/plugins/agentfiles).
// Each coding assistant keeps its skills / commands / agents in a conventional
// dot-folder. We use this to PRE-SEED scan roots (so a user's skills across all
// tools are discovered automatically) and to source agents/commands per tool —
// while the user can still add custom scan roots (existing behavior).
//
// Pure / no Obsidian imports so it is unit-testable. Paths here are the
// vault-relative / home-relative SEGMENT (no leading `~/`); callers materialize
// them as vault-relative `adapter` roots and/or absolute `external` roots under
// the home directory.

import type { ScanRoot } from "./types";

/** One tool's conventional folders (relative segments; "" = not applicable). */
export interface ToolFolders {
  tool: string;
  /** e.g. ".claude/skills" */
  skills: string;
  /** e.g. ".claude/commands" / ".codex/prompts"; "" when the tool has none. */
  commands: string;
  /** e.g. ".claude/agents"; "" when the tool has none. */
  agents: string;
}

/** The canonical mapping. Order = discovery/scan-root priority. */
export const TOOL_FOLDERS: readonly ToolFolders[] = [
  { tool: "Claude Code", skills: ".claude/skills", commands: ".claude/commands", agents: ".claude/agents" },
  { tool: "Cursor", skills: ".cursor/skills", commands: "", agents: ".cursor/agents" },
  { tool: "Codex", skills: ".codex/skills", commands: ".codex/prompts", agents: ".codex/agents" },
  { tool: "Windsurf", skills: ".codeium/windsurf/memories", commands: "", agents: "" },
  { tool: "Copilot", skills: ".copilot/skills", commands: "", agents: "" },
  { tool: "Amp", skills: ".config/amp/skills", commands: "", agents: "" },
  { tool: "OpenCode", skills: ".config/opencode/skills", commands: "", agents: "" },
  { tool: "Global", skills: ".agents/skills", commands: "", agents: "" },
];

/** Distinct non-empty skills folder segments across all tools (deduped, ordered). */
export function skillFolderSegments(): string[] {
  return dedupe(TOOL_FOLDERS.map((t) => t.skills).filter(Boolean));
}

/** Distinct non-empty command folder segments across all tools. */
export function commandFolderSegments(): string[] {
  return dedupe(TOOL_FOLDERS.map((t) => t.commands).filter(Boolean));
}

/** Distinct non-empty agents folder segments across all tools. */
export function agentFolderSegments(): string[] {
  return dedupe(TOOL_FOLDERS.map((t) => t.agents).filter(Boolean));
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/** Every known tool-folder segment (skills + commands + agents), deduped. */
export function allToolFolderSegments(): string[] {
  const all: string[] = [];
  for (const t of TOOL_FOLDERS) {
    if (t.skills) all.push(t.skills);
    if (t.commands) all.push(t.commands);
    if (t.agents) all.push(t.agents);
  }
  return dedupe(all);
}

/**
 * The actual tool folder an absolute path lives under (e.g. `.claude/skills`,
 * `.codex/prompts`, `.claude/agents`), or null when it matches no known tool
 * folder. Matches the LONGEST segment first so a nested segment like
 * `.codeium/windsurf/memories` wins over any shorter accidental match. The match
 * is on the path containing `/<segment>/` (works for both in-vault and home-dir
 * paths). Case-insensitive. Pure / unit-testable.
 */
export function toolFolderForPath(absPath: string): string | null {
  const p = absPath.replace(/\\/g, "/").toLowerCase();
  const segments = allToolFolderSegments().sort((a, b) => b.length - a.length);
  for (const seg of segments) {
    if (p.includes(`/${seg.toLowerCase()}/`)) return seg;
  }
  return null;
}

/**
 * The default SKILL scan roots pre-seeded from the tool map: each tool's skills
 * folder as a vault-relative `adapter` root AND (when a home dir is given) an
 * absolute `external` root under home. `homedir` is injected (null to omit the
 * home roots) so this stays pure / testable. Vault-relative roots are enabled by
 * default. Home-directory (global) skill folders are intentionally NOT added —
 * a machine can have hundreds of global tool skills, and mixing them with the
 * user's in-vault skills is confusing. Users can add a custom scan root if they
 * want to browse global skills.
 */
export function defaultSkillScanRoots(): ScanRoot[] {
  const roots: ScanRoot[] = [
    // The vault itself (non-dot markdown / SKILL.md anywhere) — unchanged M1 root.
    { path: "", kind: "vault", enabled: true },
  ];
  for (const seg of skillFolderSegments()) {
    roots.push({ path: seg, kind: "adapter", enabled: true });
  }
  return roots;
}

/** The absolute home-dir skill-folder paths M18 previously auto-added (external,
 *  disabled). Used to clean them out of existing settings. */
export function homeSkillRootPaths(homedir: string): string[] {
  return skillFolderSegments().map((seg) => joinHome(homedir, seg));
}

/** Join a home dir and a relative segment with a single forward slash. */
export function joinHome(homedir: string, seg: string): string {
  return homedir.replace(/\/+$/, "") + "/" + seg.replace(/^\/+/, "");
}

// --- External-file open bridge (M-EXT) ------------------------------------
// "View file" on a skill whose file lives OUTSIDE the vault (an absolute
// `external` scan root) can't open in Obsidian, because Obsidian only indexes
// files under the vault root — so today it falls back to the OS default app
// (VS Code, …). To open it IN OBSIDIAN we bridge: symlink the external skill's
// containing FOLDER into a hidden, plugin-managed directory inside the vault,
// which makes the file a real (indexable) vault path. The existing
// temporary-reveal open path then opens it in a tab. These helpers are pure /
// unit-testable; the actual symlink + open (impure) live in main.ts.

/**
 * The hidden, plugin-managed vault directory that holds the external-skill
 * bridge symlinks. Dot-prefixed so it stays out of the file explorer by default
 * (the temporary-reveal path surfaces it only while a bridged file is open),
 * and EXCLUDED from skill discovery so bridged skills never double-count.
 */
export const EXTERNAL_BRIDGE_DIR = ".shm-external";

/**
 * Stable, filesystem-safe directory name for one external skill folder's bridge
 * symlink. Combines a short FNV-1a hash of the absolute source folder (so two
 * different sources never collide) with a sanitized basename (so the name is
 * still human-recognizable in the explorer). Pure / deterministic.
 */
export function bridgeLinkName(absFolderPath: string): string {
  const norm = absFolderPath.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = norm.split("/").pop() || "skill";
  const safeBase = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").slice(0, 40) || "skill";
  return `${fnv1aHex(norm)}-${safeBase}`;
}

/** 32-bit FNV-1a hash of a string, as 8 lowercase hex chars. Pure. */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit range via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 → unsigned; pad to a fixed 8-char width.
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A resolved plan for bridging one external skill file into the vault. */
export interface ExternalOpenPlan {
  /** Absolute path of the source FOLDER to symlink (the skill file's parent). */
  sourceFolderAbs: string;
  /** Absolute path of the symlink to create, `<vault>/<bridgeDir>/<linkName>`. */
  linkAbs: string;
  /** Vault-relative path of the symlink DIRECTORY (forward-slash). */
  linkVaultRel: string;
  /** Vault-relative path of the skill FILE THROUGH the symlink (forward-slash). */
  fileVaultRel: string;
}

/**
 * Compute the bridge plan for opening an external skill file in Obsidian, or
 * null when the inputs can't produce a valid in-vault path. `fileAbs` is the
 * skill file's absolute path; `vaultBase` the vault root. The symlink points at
 * the file's PARENT folder (so sibling scripts/references come along), and the
 * file is addressed through the link by its basename. Pure — no filesystem
 * access; the caller creates the link and opens `fileVaultRel`.
 *
 * `sep` is the platform path separator (injected for testability; defaults to
 * the POSIX "/").
 */
export function buildExternalOpenPlan(
  fileAbs: string,
  vaultBase: string,
  sep = "/",
): ExternalOpenPlan | null {
  if (!fileAbs || !vaultBase) return null;
  const normFile = fileAbs.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normFile.lastIndexOf("/");
  if (slash <= 0) return null;
  const fileBase = normFile.slice(slash + 1);
  const sourceFolderAbs = normFile.slice(0, slash);
  if (!fileBase || !sourceFolderAbs) return null;

  const linkName = bridgeLinkName(sourceFolderAbs);
  const linkVaultRel = `${EXTERNAL_BRIDGE_DIR}/${linkName}`;
  const normBase = vaultBase.replace(/\\/g, "/").replace(/\/+$/, "");
  const linkAbs = `${normBase}${sep}${EXTERNAL_BRIDGE_DIR}${sep}${linkName}`.split("/").join(sep);
  return {
    sourceFolderAbs,
    linkAbs,
    linkVaultRel,
    fileVaultRel: `${linkVaultRel}/${fileBase}`,
  };
}
