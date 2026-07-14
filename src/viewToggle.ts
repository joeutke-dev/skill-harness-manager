// Pure decision logic for the ribbon toggle. Side-effect-free and free of any
// Obsidian imports so it is unit-testable in the smoke suite. The actual
// workspace mutations (open / reveal / detach) live in main.ts.

export type ToggleAction = "open" | "reveal" | "close";

/**
 * Decide what the Skill and Harness Manager ribbon should do, given:
 *  - `exists`: a SKILL_LAYER_VIEW leaf is currently open, and
 *  - `isActiveVisible`: that leaf is the active/focused (visible) leaf.
 *
 * - No leaf open            → "open"   (create + reveal)
 * - Open and active/visible → "close"  (detach all of its leaves)
 * - Open but not active     → "reveal" (bring it to the front / focus)
 */
export function decideToggleAction(
  exists: boolean,
  isActiveVisible: boolean,
): ToggleAction {
  if (!exists) return "open";
  return isActiveVisible ? "close" : "reveal";
}
