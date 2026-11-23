// Pure helpers for keeping persisted skill ids valid after a skill's path moves
// (e.g. `.claude/skills/<name>` became a symlink into `.agents/skills/<name>`,
// so the scanner now reports the skill under its `.agents` path). No Obsidian,
// no filesystem — the caller supplies the old→new id mapping.

/** The id-bearing slices of the settings that `remapSkillIds` rewrites. */
export interface RemappableSettings {
  pinnedSkillIds: string[];
  rightClickSkillIds: string[];
  editorMenuSkillIds: string[];
  skillIcons: Record<string, unknown>;
  skillAgent: Record<string, unknown>;
  skillHarness: Record<string, unknown>;
  skillClaudeAgent: Record<string, unknown>;
  skillLaunchMode: Record<string, unknown>;
  schedules: { task: { kind: string; skillId?: string } }[];
}

const MAP_KEYS = [
  "skillIcons",
  "skillAgent",
  "skillHarness",
  "skillClaudeAgent",
  "skillLaunchMode",
] as const;

const LIST_KEYS = ["pinnedSkillIds", "rightClickSkillIds", "editorMenuSkillIds"] as const;

/** Every skill id referenced anywhere in the remappable settings (deduped). */
export function collectSkillIds(s: RemappableSettings): string[] {
  const ids = new Set<string>();
  for (const k of LIST_KEYS) for (const id of s[k] ?? []) ids.add(id);
  for (const k of MAP_KEYS) for (const id of Object.keys(s[k] ?? {})) ids.add(id);
  for (const sch of s.schedules ?? []) {
    if (sch.task.kind === "skill" && sch.task.skillId) ids.add(sch.task.skillId);
  }
  return [...ids];
}

/**
 * Rewrite every occurrence of an old id to its new id, in place. Lists keep
 * their order and are deduped (if both old and new ids were present). In maps
 * an existing value under the NEW id wins over the old one. Returns the number
 * of individual rewrites (0 = nothing changed, no save needed).
 */
export function remapSkillIds(s: RemappableSettings, mapping: Map<string, string>): number {
  if (mapping.size === 0) return 0;
  let changes = 0;
  for (const k of LIST_KEYS) {
    const list = s[k];
    if (!Array.isArray(list)) continue;
    const out: string[] = [];
    for (const id of list) {
      const next = mapping.get(id);
      if (next !== undefined) changes++;
      const v = next ?? id;
      if (!out.includes(v)) out.push(v);
    }
    s[k] = out;
  }
  for (const k of MAP_KEYS) {
    const map = s[k];
    if (!map) continue;
    for (const [oldId, newId] of mapping) {
      if (!(oldId in map)) continue;
      if (!(newId in map)) map[newId] = map[oldId];
      delete map[oldId];
      changes++;
    }
  }
  for (const sch of s.schedules ?? []) {
    const t = sch.task;
    if (t.kind !== "skill" || !t.skillId) continue;
    const next = mapping.get(t.skillId);
    if (next !== undefined) {
      t.skillId = next;
      changes++;
    }
  }
  return changes;
}

/**
 * A readable name for a skill id whose file isn't currently detected. A skill
 * file is almost always `<folder>/SKILL.md`, so the folder is the useful part;
 * any other file falls back to its basename without the extension.
 */
export function placeholderSkillName(id: string): string {
  const parts = id.replace(/\\/g, "/").split("/").filter(Boolean);
  const base = parts.pop() ?? id;
  if (/^skill\.md$/i.test(base) && parts.length > 0) return parts[parts.length - 1];
  return base.replace(/\.md$/i, "") || base;
}
