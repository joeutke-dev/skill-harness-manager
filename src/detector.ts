import * as fs from "fs";
import * as nodePath from "path";
import {
  App,
  FileSystemAdapter,
  Platform,
  TFile,
  normalizePath,
} from "obsidian";
import {
  coerceFrontmatterTags,
  fileBaseName,
  firstHeading,
  inferSourceLabel,
  isMarkdown,
  isSkillCandidate,
  isSkillMd,
  parentFolderName,
  parseFrontmatter,
  resolveSkillTags,
} from "./parse";
import { DetectionMethod, ScanRoot, Skill, SkillLayerSettings } from "./types";

// Defensive caps so a misconfigured root (e.g. `/`) can't hang the walk.
const MAX_DEPTH = 12;
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".trash",
  ".DS_Store",
]);

interface SkillFields {
  name: string;
  description: string;
}

/**
 * Apply the uniform "what counts as a skill" rules (PRD §3) to one file.
 * Returns the resolved name/description, or null if the file is not a skill.
 */
function evaluateSkill(
  relOrAbsPath: string,
  fm: { name?: string; description?: string },
  getFirstHeading: () => string | null,
): SkillFields | null {
  if (isSkillMd(relOrAbsPath)) {
    // Primary rule: SKILL.md MUST have frontmatter name + description.
    if (fm.name && fm.description) {
      return { name: fm.name, description: fm.description };
    }
    return null;
  }

  // Fallback rule: any markdown directly under a folder named `skills/`.
  if (isMarkdown(relOrAbsPath) && parentFolderName(relOrAbsPath) === "skills") {
    const name = fm.name || fileBaseName(relOrAbsPath);
    const description =
      fm.description || getFirstHeading() || "(no description)";
    return { name, description };
  }

  return null;
}

export class Detector {
  constructor(
    private app: App,
    private getSettings: () => SkillLayerSettings,
  ) {}

  /** True when external (absolute-path) roots can be scanned safely. */
  canScanExternal(): boolean {
    return (
      Platform.isDesktopApp && this.app.vault.adapter instanceof FileSystemAdapter
    );
  }

  /** Absolute path to the vault root, or null when unavailable. */
  vaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return null;
  }

  /** Run all enabled roots, dedupe by absolute path. */
  async scan(): Promise<Skill[]> {
    const settings = this.getSettings();
    const byPath = new Map<string, Skill>();

    for (const root of settings.scanRoots) {
      if (!root.enabled) continue;
      let found: Skill[] = [];
      try {
        if (root.kind === "vault") {
          found = await this.scanVaultRoot(root);
        } else if (root.kind === "adapter") {
          found = await this.scanAdapterRoot(root);
        } else if (root.kind === "external") {
          found = await this.scanExternalRoot(root);
        }
      } catch (err) {
        console.error(`[skill-layer] scan failed for root "${root.path}":`, err);
      }
      // Dedupe by absolute path — first writer wins (root order is the priority).
      for (const skill of found) {
        if (!byPath.has(skill.id)) byPath.set(skill.id, skill);
      }
    }

    return Array.from(byPath.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  // --- Path 1: Vault API + metadataCache (non-dot folders) ---------------
  private async scanVaultRoot(root: ScanRoot): Promise<Skill[]> {
    const base = this.vaultBasePath();
    const prefix = normalizePath(root.path).replace(/^\/+|\/+$/g, "");
    const files = this.app.vault.getMarkdownFiles();
    const skills: Skill[] = [];

    for (const file of files) {
      if (prefix && !(file.path === prefix || file.path.startsWith(prefix + "/"))) {
        continue;
      }
      // Candidate gate FIRST — only SKILL.md files or markdown directly under a
      // `skills/` folder can ever be skills. Skip everything else with NO read,
      // so ordinary vault notes never trigger a cachedRead/parse.
      if (!isSkillCandidate(file.path)) continue;

      // Read fresh file content for candidates and parse name/description/tags
      // from it, so EXTERNAL / in-editor edits are reflected immediately. The
      // metadataCache can lag a `modify` event (it re-parses asynchronously),
      // which would otherwise serve stale tags. The candidate gate keeps this
      // cheap, and `cachedRead` is itself cached + invalidated on change. The
      // metadataCache is only a fallback if the read fails.
      let name: string | undefined;
      let description: string | undefined;
      let fmTags: string[] = [];
      let getFirstHeading: () => string | null = () => null;
      try {
        const content = await this.app.vault.cachedRead(file);
        const fm = parseFrontmatter(content);
        name = fm.name;
        description = fm.description;
        fmTags = fm.tags ?? [];
        getFirstHeading = () => firstHeading(content);
      } catch (err) {
        console.error(`[skill-layer] cachedRead failed for ${file.path}:`, err);
        const cache = this.app.metadataCache.getFileCache(file);
        name = cache?.frontmatter?.name as string | undefined;
        description = cache?.frontmatter?.description as string | undefined;
        fmTags = coerceFrontmatterTags(cache?.frontmatter?.tags);
        getFirstHeading = () => cache?.headings?.[0]?.heading ?? null;
      }

      const fields = evaluateSkill(file.path, { name, description }, getFirstHeading);
      if (!fields) continue;

      const absPath = base ? normalizePath(`${base}/${file.path}`) : file.path;
      skills.push(
        this.makeSkill(fields, absPath, file.path, root.path, "vault", fmTags, file.path),
      );
    }
    return skills;
  }

  // --- Path 2: dot-folders (.claude/, .codex/, …) ------------------------
  private async scanAdapterRoot(root: ScanRoot): Promise<Skill[]> {
    const base = this.vaultBasePath();
    // On desktop, walk dot-folders with Node `fs`. Obsidian's `adapter.list()`
    // does NOT surface hidden dot-folders (e.g. `.claude/`) on Windows the way it
    // does on macOS (Windows marks dot-prefixed folders hidden), so relying on it
    // silently drops those skills. `fs` lists them on every OS. The adapter path
    // remains as a fallback for environments without filesystem access.
    if (base && this.canScanExternal()) {
      return this.scanAdapterRootViaFs(root, base);
    }
    return this.scanAdapterRootViaAdapter(root, base);
  }

  /** Desktop dot-folder walk via Node `fs` (cross-platform, sees hidden dirs). */
  private async scanAdapterRootViaFs(
    root: ScanRoot,
    base: string,
  ): Promise<Skill[]> {
    const skills: Skill[] = [];
    const absStart = nodePath.join(base, root.path);
    let rootReal: string;
    try {
      rootReal = await fs.promises.realpath(absStart);
    } catch {
      return []; // root folder absent — nothing to scan
    }
    const files: string[] = [];
    await this.walkFs(absStart, rootReal, 0, files, new Set<string>());
    for (const abs of files) {
      if (!isMarkdown(abs)) continue;
      let content: string;
      try {
        content = await fs.promises.readFile(abs, "utf8");
      } catch (err) {
        console.error(`[skill-layer] fs.readFile failed for ${abs}:`, err);
        continue;
      }
      // Vault-relative, forward-slash path (matches adapter ids for dedupe).
      const rel = nodePath.relative(base, abs).split(nodePath.sep).join("/");
      const fm = parseFrontmatter(content);
      const fields = evaluateSkill(rel, fm, () => firstHeading(content));
      if (!fields) continue;
      skills.push(
        this.makeSkill(fields, normalizePath(abs), rel, root.path, "adapter", fm.tags ?? [], rel),
      );
    }
    return skills;
  }

  /** Fallback dot-folder walk via Obsidian's adapter (non-desktop). */
  private async scanAdapterRootViaAdapter(
    root: ScanRoot,
    base: string | null,
  ): Promise<Skill[]> {
    const start = normalizePath(root.path);
    const skills: Skill[] = [];
    const adapter = this.app.vault.adapter;

    const files: string[] = [];
    await this.walkAdapter(start, 0, files);

    for (const rel of files) {
      if (!isMarkdown(rel)) continue;
      let content: string;
      try {
        content = await adapter.read(rel);
      } catch (err) {
        console.error(`[skill-layer] adapter.read failed for ${rel}:`, err);
        continue;
      }
      const fm = parseFrontmatter(content);
      const fields = evaluateSkill(rel, fm, () => firstHeading(content));
      if (!fields) continue;

      // Normalize in both branches so adapter ids match the Vault-API path's
      // normalization and dedupe stays consistent (Windows / same root twice).
      const absPath = normalizePath(base ? `${base}/${rel}` : rel);
      skills.push(
        this.makeSkill(fields, absPath, rel, root.path, "adapter", fm.tags ?? [], rel),
      );
    }
    return skills;
  }

  /** `adapter.list()` is non-recursive — descend `folders` ourselves. */
  private async walkAdapter(
    dir: string,
    depth: number,
    out: string[],
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const adapter = this.app.vault.adapter;
    let listed;
    try {
      listed = await adapter.list(dir);
    } catch {
      return; // missing/unreadable folder — skip quietly
    }
    for (const f of listed.files) out.push(f);
    for (const sub of listed.folders) {
      const name = sub.replace(/\/+$/, "").split("/").pop() ?? "";
      if (IGNORED_DIRS.has(name) || name === this.app.vault.configDir) continue;
      await this.walkAdapter(sub, depth + 1, out);
    }
  }

  // --- Path 3: external absolute roots via Node fs (desktop-gated) -------
  private async scanExternalRoot(root: ScanRoot): Promise<Skill[]> {
    if (!this.canScanExternal()) return [];
    // `fs`/`path` are node builtins kept external by esbuild and provided by
    // the Electron runtime (desktop-only plugin).
    const skills: Skill[] = [];
    const files: string[] = [];
    // Resolve the configured root's real path once; the walk is confined to
    // this subtree so a symlink inside it can't escape to unintended trees.
    let rootReal: string;
    try {
      rootReal = await fs.promises.realpath(root.path);
    } catch (err) {
      console.error(`[skill-layer] external root unreadable ${root.path}:`, err);
      return [];
    }
    await this.walkFs(root.path, rootReal, 0, files, new Set<string>());

    for (const abs of files) {
      if (!isMarkdown(abs)) continue;
      let content: string;
      try {
        content = await fs.promises.readFile(abs, "utf8");
      } catch (err) {
        console.error(`[skill-layer] fs.readFile failed for ${abs}:`, err);
        continue;
      }
      const fm = parseFrontmatter(content);
      const fields = evaluateSkill(abs, fm, () => firstHeading(content));
      if (!fields) continue;

      const relForTag = this.relativeToRoot(abs, root.path);
      skills.push(
        this.makeSkill(fields, abs, null, root.path, "external", fm.tags ?? [], relForTag),
      );
    }
    return skills;
  }

  private async walkFs(
    dir: string,
    rootReal: string,
    depth: number,
    out: string[],
    seen: Set<string>,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    // Resolve symlinks and skip already-visited real directories to avoid
    // cycles (e.g. a symlink pointing back up the tree).
    let real: string;
    try {
      real = await fs.promises.realpath(dir);
    } catch {
      return;
    }
    // Confinement: the resolved path must be the root itself or under it.
    // A symlink that escapes outside the configured root is skipped.
    if (real !== rootReal && !real.startsWith(rootReal + nodePath.sep)) return;
    if (seen.has(real)) return;
    seen.add(real);

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name === this.app.vault.configDir) {
          continue;
        }
        // Stat through symlinks so we descend into linked directories too.
        let isDir = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            isDir = (await fs.promises.stat(full)).isDirectory();
          } catch {
            isDir = false;
          }
        }
        if (isDir) await this.walkFs(full, rootReal, depth + 1, out, seen);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  private makeSkill(
    fields: SkillFields,
    absPath: string,
    vaultPath: string | null,
    sourceRoot: string,
    detection: DetectionMethod,
    frontmatterTags: string[],
    relForTag: string,
  ): Skill {
    return {
      id: absPath,
      name: fields.name,
      description: fields.description,
      path: absPath,
      vaultPath,
      sourceRoot,
      sourceLabel: inferSourceLabel(absPath),
      detection,
      tags: resolveSkillTags({
        relativePath: relForTag,
        description: fields.description,
        frontmatterTags,
      }),
    };
  }

  /** Best relative path for folder-tag derivation: vault path, else root-relative. */
  relativeForTag(skill: Skill): string {
    if (skill.vaultPath) return skill.vaultPath;
    return this.relativeToRoot(skill.path, skill.sourceRoot);
  }

  /** Path relative to a configured root (for folder-tag derivation). */
  private relativeToRoot(abs: string, root: string): string {
    const a = abs.replace(/\\/g, "/");
    const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (r && (a === r || a.startsWith(r + "/"))) {
      return a.slice(r.length).replace(/^\/+/, "");
    }
    return a.split("/").pop() ?? a;
  }

  /** Resolve a vault-relative path to a TFile, or null (dot/external files). */
  resolveTFile(vaultPath: string | null): TFile | null {
    if (!vaultPath) return null;
    const af = this.app.vault.getAbstractFileByPath(vaultPath);
    return af instanceof TFile ? af : null;
  }
}
