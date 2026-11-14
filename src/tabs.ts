// Pure (no-Obsidian) view-state helpers for the M10 tabbed browser: the tab set
// + default, a fail-safe tab normalizer, and the Agents-tab render model
// (empty-state text vs. a list of agent rows). Kept side-effect-free and free of
// Obsidian imports so it is unit-testable (the smoke suite bundles it directly,
// like viewToggle.ts). The view (src/view.ts) consumes these to decide what to
// render; no behavior lives here.

import type { CustomAgent } from "./launch";
import { SKILL_TAB_ICON_ID } from "./icon";

/** The browser tabs. "skills" is the combined Skills & Commands browser (one
 *  tab, a section per kind); "config" holds the rarely-used Harnesses (M15.3)
 *  and Agents (M10) lists as two collapsible sections. */
export type SkillLayerTab = "skills" | "sessions" | "schedules" | "config";

/** The tab shown on first open. */
export const DEFAULT_TAB: SkillLayerTab = "skills";

/** Tab bar definition (id + label + icon), in display order. The icon sits left
 *  of the label; in a narrow panel the labels hide and only icons show. */
export const TABS: ReadonlyArray<{ id: SkillLayerTab; label: string; icon: string }> = [
  { id: "skills", label: "Skills", icon: SKILL_TAB_ICON_ID },
  { id: "sessions", label: "Sessions", icon: "list" },
  { id: "schedules", label: "Schedules", icon: "clock" },
  { id: "config", label: "Config", icon: "settings" },
];

/** Empty-state copy for the Agents tab when discovery returns nothing. */
export const AGENTS_EMPTY_TEXT =
  "No custom agents found in .omnigent/agent-configs/. " +
  "Create one with the create-custom-agent skill.";

/** A single Agents-tab row's display fields. `path` is the discovered launch path. */
export interface AgentRowModel {
  /** Display name (top-level `name:`, else filename stem / dir name). */
  title: string;
  /** Optional description (top-level `description:`); "" when absent. */
  subtitle: string;
  /** The discovered launch path (loose `.yaml` file or bundle directory). */
  path: string;
}

/** The Agents-tab render decision: empty-state text, or N rows to render. */
export type AgentsTabModel =
  | { empty: true; text: string }
  | { empty: false; rows: AgentRowModel[] };

/**
 * Build the Agents-tab render model from the discovered custom agents: the empty
 * state (with {@link AGENTS_EMPTY_TEXT}) when there are none, else one row per
 * agent preserving discovery order. Pure / unit-testable.
 */
export function buildAgentsTabModel(agents: CustomAgent[]): AgentsTabModel {
  if (!Array.isArray(agents) || agents.length === 0) {
    return { empty: true, text: AGENTS_EMPTY_TEXT };
  }
  return {
    empty: false,
    rows: agents.map((a) => ({
      title: a.name,
      subtitle: a.description ?? "",
      path: a.path,
    })),
  };
}
