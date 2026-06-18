// Pure icon-resolution helpers — no Obsidian / DOM imports, so they are
// testable. The "is this id renderable" check is injected as a predicate
// (backed by Obsidian's `setIcon` at runtime; mockable in tests).

/** The icon the now-removed global setting used to default to. */
export const DEFAULT_PINNED_ICON = "play";

/**
 * Custom icon id for the plugin's BRAND glyph — a squid. Registered once via
 * Obsidian's `addIcon` in onload (Lucide ships no cephalopod), then used for the
 * ribbon toggle, the view tab, the empty state, and the file-menu action.
 */
export const SKILL_LAYER_ICON = "skill-layer-squid";

/**
 * SVG inner content for the squid brand icon. Obsidian's `addIcon` wraps this in
 * an `<svg viewBox="0 0 100 100">`, so coordinates are on a 0–100 canvas. Strokes
 * use `currentColor` and Lucide-like round caps/joins so it inherits the theme
 * color and sits well beside the bundled Lucide icons. Anatomy (mantle tip up):
 * a pointed mantle, two caudal fins flanking the tip, two eyes at the head base,
 * and five arms — the outer pair curling outward — so it reads as a squid (not a
 * ghost) down to ribbon size.
 */
export const SKILL_LAYER_ICON_SVG = [
  '<g fill="none" stroke="currentColor" stroke-width="6.5"',
  ' stroke-linecap="round" stroke-linejoin="round">',
  '<path d="M34 54 C34 30 40 10 50 9 C60 10 66 30 66 54"/>',
  '<path d="M40 22 C28 18 24 28 35 34"/>',
  '<path d="M60 22 C72 18 76 28 65 34"/>',
  '<path d="M37 54 C30 66 28 78 22 85"/>',
  '<path d="M44 55 C42 70 42 83 39 93"/>',
  '<path d="M50 56 C50 74 50 86 50 96"/>',
  '<path d="M56 55 C58 70 58 83 61 93"/>',
  '<path d="M63 54 C70 66 72 78 78 85"/>',
  '</g>',
  '<circle cx="42" cy="47" r="3.8" fill="currentColor"/>',
  '<circle cx="58" cy="47" r="3.8" fill="currentColor"/>',
].join("");

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
