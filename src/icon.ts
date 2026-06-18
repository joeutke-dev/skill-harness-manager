// Pure icon-resolution helpers — no Obsidian / DOM imports, so they are
// testable. The "is this id renderable" check is injected as a predicate
// (backed by Obsidian's `setIcon` at runtime; mockable in tests).

/** Last-resort fallback icon when no per-skill or global default is set. */
export const DEFAULT_PINNED_ICON = "play";

/**
 * True if an element (just populated by `setIcon`) contains an `<svg>` child.
 * Extracted from the runtime icon validator so the SVG-presence rule is
 * unit-testable without a DOM. Guards against a non-SVG child false-positive.
 */
export function elementHasSvg(el: { querySelector(sel: string): unknown }): boolean {
  return el.querySelector("svg") !== null;
}

/**
 * Decide what happens when the user clicks "Pin to ribbon" for a skill that is
 * not currently pinned. If a remembered per-skill icon exists AND still
 * resolves, pin immediately with it (no picker). Otherwise open the picker.
 */
export function pinAction(opts: {
  remembered?: string;
  isValid: (id: string) => boolean;
}): { kind: "pin"; icon: string } | { kind: "picker" } {
  if (opts.remembered && opts.isValid(opts.remembered)) {
    return { kind: "pin", icon: opts.remembered };
  }
  return { kind: "picker" };
}

/**
 * Resolve which Lucide icon a pinned skill should use. Priority:
 *   1. per-skill stored icon (the new authoritative choice),
 *   2. the legacy global icon (migration fallback for pre-existing pins),
 *   3. the built-in default.
 * Each candidate must pass `isValid`; the first valid one wins. If none is
 * valid, the default is returned regardless (a last-resort glyph).
 */
export function resolvePinnedIcon(opts: {
  perSkill?: string;
  legacyGlobal?: string;
  isValid: (id: string) => boolean;
}): string {
  const candidates = [opts.perSkill, opts.legacyGlobal, DEFAULT_PINNED_ICON];
  for (const c of candidates) {
    if (c && opts.isValid(c)) return c;
  }
  return DEFAULT_PINNED_ICON;
}
