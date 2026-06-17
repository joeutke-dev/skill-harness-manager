// Pure, idempotent frontmatter `tags:` write transforms for the raw
// (adapter / external / dot-folder) code path. Frontmatter `tags:` is the
// single authoritative place the UI writes — the plugin no longer edits the
// description for tagging, so all the prior description/quoting/block-scalar
// machinery is gone (and with it that whole corruption class).
//
// No Obsidian / Node imports — operates on raw content strings only, so it is
// identical and testable for the adapter and external paths. (Vault files use
// Obsidian's `processFrontMatter` instead; see main.ts.)

import { parseFrontmatter } from "./parse";

interface SplitContent {
  bom: string;
  eol: string;
  hasFm: boolean;
  fmLines: string[];
  bodyLines: string[];
}

function splitContent(content: string): SplitContent {
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const c = bom ? content.slice(1) : content;
  const eol = /\r\n/.test(c) ? "\r\n" : "\n";
  const lines = c.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { bom, eol, hasFm: false, fmLines: [], bodyLines: lines };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) {
    return { bom, eol, hasFm: false, fmLines: [], bodyLines: lines };
  }
  return {
    bom,
    eol,
    hasFm: true,
    fmLines: lines.slice(1, close),
    bodyLines: lines.slice(close + 1),
  };
}

function rebuild(split: SplitContent, fmLines: string[]): string {
  const all = ["---", ...fmLines, "---", ...split.bodyLines];
  return split.bom + all.join(split.eol);
}

/** Rewrite (or insert/remove) the `tags:` field as a compact inline list. */
function setTagsInFmLines(fmLines: string[], tags: string[]): string[] {
  let start = -1;
  for (let i = 0; i < fmLines.length; i++) {
    // TOP-LEVEL `tags:` only — an indented (nested) `tags:` must never match,
    // or we'd hoist a nested key to the top level and destroy its structure.
    if (/^tags\s*:/i.test(fmLines[i])) {
      start = i;
      break;
    }
  }

  const replacement = tags.length ? [`tags: [${tags.join(", ")}]`] : [];

  if (start < 0) {
    // No TOP-LEVEL tags: — append one before the close (nested `tags:` under
    // another key are intentionally never matched, so they stay untouched).
    if (tags.length) fmLines.push(...replacement);
    return fmLines;
  }

  // Determine the FULL extent of the existing top-level declaration.
  const valuePart = fmLines[start].replace(/^tags\s*:/i, "").trim();
  let last = start; // index of the last line belonging to this declaration
  if (valuePart === "") {
    // Block list (or empty `tags:`): extend through indented `- item` /
    // continuation lines, INCLUDING interleaved blank / `#` comment lines,
    // until the next TOP-LEVEL key or the frontmatter close. Trailing blank /
    // comment lines after the last item are left in place (not swallowed).
    let i = start + 1;
    while (i < fmLines.length) {
      const line = fmLines[i];
      if (line.trim() === "" || /^\s*#/.test(line)) {
        i++; // interleaved blank/comment — tentative, don't extend `last`
      } else if (/^\s+\S/.test(line)) {
        last = i; // indented content line belongs to the block
        i++;
      } else {
        break; // next top-level key
      }
    }
  }
  fmLines.splice(start, last - start + 1, ...replacement);
  return fmLines;
}

function mergeTag(existing: string[], tag: string): string[] {
  const want = tag.toLowerCase();
  if (existing.some((t) => t.toLowerCase() === want)) return existing.slice();
  return [...existing, tag];
}

function dropTag(existing: string[], tag: string): string[] {
  const want = tag.toLowerCase();
  return existing.filter((t) => t.toLowerCase() !== want);
}

/**
 * ADD a tag to frontmatter `tags:`, creating the list — or the whole
 * frontmatter block — if absent. Idempotent. The description is never touched.
 * Returns the new content (unchanged when the tag was already present).
 */
export function addTagToContent(content: string, tag: string): string {
  const split = splitContent(content);
  if (!split.hasFm) {
    // No frontmatter — create a minimal block; existing content is the body.
    return rebuild(split, [`tags: [${tag}]`]);
  }
  const fmLines = split.fmLines.slice();
  setTagsInFmLines(fmLines, mergeTag(parseFrontmatter(content).tags ?? [], tag));
  return rebuild(split, fmLines);
}

/**
 * REMOVE a tag from frontmatter `tags:` (cleaning up an emptied list).
 * Idempotent. The description is never touched.
 */
export function removeTagFromContent(content: string, tag: string): string {
  const split = splitContent(content);
  if (!split.hasFm) return content;
  const fmLines = split.fmLines.slice();
  setTagsInFmLines(fmLines, dropTag(parseFrontmatter(content).tags ?? [], tag));
  // If dropping `tags:` left the frontmatter with no keys at all, remove the
  // whole block rather than emitting an empty `---\n---`.
  if (fmLines.every((l) => l.trim() === "")) {
    return split.bom + split.bodyLines.join(split.eol);
  }
  return rebuild(split, fmLines);
}
