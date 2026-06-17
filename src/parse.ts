// Pure parsing helpers — no Obsidian or Node imports, so they are trivially
// testable and safe to use from every code path.

import { SkillTag } from "./types";

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  /** Raw tag strings from the `tags:` field, leading `#`/quotes stripped. */
  tags?: string[];
}

/**
 * Minimal YAML frontmatter reader for the only two keys we need (`name`,
 * `description`). Used on the adapter/external code paths where Obsidian's
 * `metadataCache` is unavailable. Handles `key: value`, single/double quotes,
 * and YAML block scalars (`>`/`|`). It is deliberately NOT a general YAML
 * parser — it extracts two scalar string fields and nothing else.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const block = match[1];
  const lines = block.split(/\r?\n/);
  const result: ParsedFrontmatter = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    if (key !== "name" && key !== "description" && key !== "tags") continue;

    let raw = kv[2].trim();

    // `tags:` — accept an inline list `[a, b]`, a YAML block list (following
    // `- item` lines), or a scalar (single value, or comma/space separated).
    if (key === "tags") {
      let items: string[];
      if (raw.startsWith("[")) {
        items = raw.replace(/^\[/, "").replace(/\]$/, "").split(",");
      } else if (raw !== "") {
        items = raw.split(/[,\s]+/);
      } else {
        // Block list: collect `- item` lines, skipping interleaved blank /
        // `#` comment lines, until the next top-level key.
        items = [];
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          if (line.trim() === "" || /^\s*#/.test(line)) continue;
          const li = /^\s*-\s+(.*)$/.exec(line);
          if (li) {
            items.push(li[1]);
            continue;
          }
          if (/^\s+\S/.test(line)) continue; // other indented continuation
          break; // top-level key
        }
      }
      result.tags = items
        .map((x) => stripQuotes(x.trim()).replace(/^#+/, "").trim())
        .filter((x) => x.length > 0);
      continue;
    }

    // Block scalar: `|`/`>` optionally followed by a chomping/keep indicator
    // (`-`/`+`) or an explicit indentation digit. Gather subsequent
    // indented/blank lines as the value.
    if (/^[|>][+-]?\d*$/.test(raw)) {
      const collected: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+\S/.test(lines[j]) || lines[j].trim() === "") {
          collected.push(lines[j].trim());
        } else {
          break;
        }
      }
      raw = collected.join(" ").trim();
    } else {
      raw = stripQuotes(raw);
    }

    if (key === "name") result.name = raw;
    else result.description = raw;
  }

  return result;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** First markdown heading (`# …`) in a document, or null. */
export function firstHeading(content: string): string | null {
  // Skip a leading frontmatter block before scanning for the heading.
  const body = content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) return h[1].trim();
  }
  return null;
}

/**
 * Infer a harness/source label from an absolute path. Order matters — more
 * specific patterns first.
 */
export function inferSourceLabel(absPath: string): string {
  const p = absPath.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/.claude/")) return ".claude";
  if (p.includes("/.codex/") || p.includes("/codex/skills")) return "codex";
  if (p.includes("/.agents/")) return ".agents";
  if (/\/(vibe|fe-[a-z0-9-]+)\//.test(p) || p.includes("/marketplace/")) {
    return "vibe-marketplace";
  }
  if (p.includes("/omnigent/") || p.includes("/skills/")) return "omnigent-bundle";
  return "vault";
}

/**
 * Basename without the `.md`/`.markdown` extension.
 */
export function fileBaseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base.replace(/\.(md|markdown)$/i, "");
}

/** Immediate parent folder name of a path, lowercased. */
export function parentFolderName(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = norm.split("/");
  return (parts.length >= 2 ? parts[parts.length - 2] : "").toLowerCase();
}

/** True if the file is a SKILL.md (case-insensitive). */
export function isSkillMd(path: string): boolean {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  return base.toLowerCase() === "skill.md";
}

/** True if the file is markdown. */
export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * True if a path could possibly be a skill — i.e. a SKILL.md, or markdown
 * directly under a folder named `skills/`. Used to gate expensive reads: a
 * non-candidate is skipped before any file read happens.
 */
export function isSkillCandidate(path: string): boolean {
  return isSkillMd(path) || parentFolderName(path) === "skills";
}

/**
 * Strip a trailing slash from an external (absolute) root so the same path
 * can't be added twice — but preserve POSIX root (`/`) and Windows drive roots
 * (`C:\`, `C:/`), which would be mangled by naive stripping.
 */
export function normalizeExternalRoot(p: string): string {
  if (p === "/") return p; // POSIX root
  if (/^[A-Za-z]:[\\/]*$/.test(p)) return p; // Windows drive root (e.g. C:\, C:/)
  const stripped = p.replace(/[/\\]+$/, "");
  return stripped === "" ? p : stripped;
}

// --- Tagging (read side) --------------------------------------------------

/** Folder names that are containers, not meaningful tag categories. */
const GENERIC_FOLDERS = new Set(["skills", "skill"]);

/**
 * Sanitize a raw token to a valid Obsidian tag string, or null if it can't be
 * one. Strips a leading `#`, keeps only `[A-Za-z0-9_/-]`, collapses/strips
 * stray slashes, and requires at least one non-numeric character (Obsidian
 * rejects all-numeric tags). Case is preserved (matching is case-insensitive).
 */
export function sanitizeTag(raw: string): string | null {
  let t = raw.trim().replace(/^#+/, "");
  t = t.replace(/[^A-Za-z0-9_/-]/g, "");
  t = t.replace(/\/{2,}/g, "/").replace(/^[/]+|[/]+$/g, "");
  if (!t) return null;
  // Must contain at least one char that is not a digit and not a slash.
  if (!/[^0-9/]/.test(t)) return null;
  return t;
}

/**
 * Extract `#tag` tokens from a description string, following Obsidian rules:
 * a `#` at line start or after whitespace, followed by valid tag chars, with
 * at least one non-numeric char; nested `parent/child` supported. Returns the
 * canonical tag strings (no leading `#`), order preserved, deduped.
 */
export function parseDescriptionTags(description: string | undefined): string[] {
  if (!description) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description)) !== null) {
    const t = sanitizeTag(m[2]);
    if (!t) continue;
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

/**
 * Coerce a frontmatter `tags` value (string, list, or undefined — e.g. from
 * Obsidian's metadataCache) into an array of canonical tag strings.
 */
export function coerceFrontmatterTags(value: unknown): string[] {
  let items: string[];
  if (Array.isArray(value)) {
    items = value.map((v) => String(v));
  } else if (typeof value === "string") {
    items = value.split(/[,\s]+/);
  } else {
    return [];
  }
  return items
    .map((x) => x.trim().replace(/^#+/, "").trim())
    .filter((x) => x.length > 0);
}

/**
 * Derive a virtual "folder" tag from a path: the immediate meaningful category
 * folder containing the skill. For a SKILL.md, the skill's own folder is
 * skipped; generic container folders (`skills`) are skipped while walking up.
 * Lowercased, leading dot stripped, sanitized. Returns null at vault root / no
 * meaningful parent. Pass the path RELATIVE to the scan root so absolute
 * prefixes (e.g. `/Users/...`) never leak in as tags.
 */
export function deriveFolderTag(relativePath: string): string | null {
  const norm = relativePath.replace(/\\/g, "/").replace(/\/+$/, "");
  const segs = norm.split("/").filter((s) => s.length > 0);
  if (segs.length < 2) return null; // bare filename — no parent folder

  const file = segs[segs.length - 1];
  let dirs = segs.slice(0, -1);
  if (isSkillMd(file)) {
    // Drop the skill's own containing folder (typically the skill name).
    dirs = dirs.slice(0, -1);
  }

  for (let k = dirs.length - 1; k >= 0; k--) {
    const cand = dirs[k].replace(/^\.+/, "").toLowerCase();
    if (!cand || GENERIC_FOLDERS.has(cand)) continue;
    const t = sanitizeTag(cand);
    if (t) return t;
  }
  return null;
}

/**
 * Resolve a skill's tags into a deduped (case-insensitive), alphabetically
 * sorted `SkillTag[]`, labeled by origin:
 *  - frontmatter `tags:` → `frontmatter` (authoritative; UI-editable),
 *  - `#tag` tokens in the description → `description` (read-only),
 *  - the derived folder tag → `folder` (read-only).
 * A tag present in more than one source resolves with the highest-priority
 * origin in that order (frontmatter > description > folder).
 */
export function resolveSkillTags(opts: {
  relativePath: string;
  description?: string;
  frontmatterTags?: string[];
}): SkillTag[] {
  const seen = new Set<string>();
  const out: SkillTag[] = [];
  const add = (raw: string, origin: SkillTag["origin"]) => {
    const t = sanitizeTag(raw);
    if (!t) return;
    const k = t.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ tag: t, origin });
  };

  // 1. Frontmatter tags — authoritative, win on duplicates.
  for (const t of opts.frontmatterTags ?? []) add(t, "frontmatter");
  // 2. Description #tags — read-only, only if not already in frontmatter.
  for (const t of parseDescriptionTags(opts.description)) add(t, "description");
  // 3. Derived folder tag — read-only, only if not already present.
  const folder = deriveFolderTag(opts.relativePath);
  if (folder) add(folder, "folder");

  out.sort((a, b) => a.tag.toLowerCase().localeCompare(b.tag.toLowerCase()));
  return out;
}
