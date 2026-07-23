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
