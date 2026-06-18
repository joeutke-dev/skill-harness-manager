// Pure decision logic for opening a custom-agent `config.yaml` in the "YAML
// Viewer" community plugin (id `yaml-viewer`) instead of the OS default app.
// Side-effect-free and free of any Obsidian/Electron imports so it is
// unit-testable in the smoke suite (same pattern as viewToggle.ts). The actual
// workspace mutation (`setViewState`) and TFile/FileSystemAdapter access live in
// main.ts, which injects those into these helpers.

/** YAML Viewer's manifest id AND the view type it registers (both `yaml-viewer`). */
export const YAML_VIEWER_PLUGIN_ID = "yaml-viewer";
export const YAML_VIEWER_VIEW_TYPE = "yaml-viewer";

/** YAML Viewer registers extensions ["yaml","yml"]; only these can open in it. */
export function isYamlFile(path: string): boolean {
  return /\.ya?ml$/i.test(path);
}

/**
 * True iff the YAML Viewer plugin is BOTH installed and enabled, read from the
 * untyped community-plugins API surface (`app.plugins`). Mirrors the documented
 * shape: an `enabledPlugins` Set plus a `plugins` registry keyed by id.
 */
export function detectYamlViewerEnabled(plugins: unknown): boolean {
  const p = plugins as
    | {
        enabledPlugins?: { has?: (id: string) => boolean };
        plugins?: Record<string, unknown>;
      }
    | null
    | undefined;
  return Boolean(
    p?.enabledPlugins?.has?.(YAML_VIEWER_PLUGIN_ID) &&
      p?.plugins?.[YAML_VIEWER_PLUGIN_ID],
  );
}

/** Filesystem path helpers main.ts injects (node `path`) so this stays pure. */
export interface PathDeps {
  relative: (from: string, to: string) => string;
  isAbsolute: (p: string) => boolean;
  sep: string;
}

/**
 * Map an absolute filesystem path to an in-vault path (forward slashes), or null
 * when the path is OUTSIDE the vault. A `rel` that is empty, starts with ".."
 * (parent traversal), or is itself absolute means out-of-vault → null. Dot-folder
 * paths (e.g. `.omnigent/...`) stay inside the vault here but won't resolve to a
 * TFile because Obsidian doesn't index them — that null comes from the lookup in
 * resolveVaultTFile, not from this path math.
 */
export function toVaultRelativePath(
  basePath: string,
  absPath: string,
  deps: PathDeps,
): string | null {
  const rel = deps.relative(basePath, absPath);
  if (rel === "" || rel.startsWith("..") || deps.isAbsolute(rel)) return null;
  return rel.split(deps.sep).join("/");
}

/** Lookup deps main.ts injects (the Vault API + an `instanceof TFile` check). */
export interface ResolveDeps<T> extends PathDeps {
  getAbstractFileByPath: (vaultPath: string) => T | null;
  isTFile: (f: T | null) => boolean;
}

/**
 * Resolve an absolute filesystem path to the in-vault TFile it names, or null.
 * Null when: there's no vault base path (adapter isn't a FileSystemAdapter), the
 * path is out-of-vault, or the vault-relative path doesn't index to a TFile
 * (covers non-indexed dot-folders and external scan roots).
 */
export function resolveVaultTFile<T>(
  basePath: string | null | undefined,
  absPath: string,
  deps: ResolveDeps<T>,
): T | null {
  if (basePath == null) return null;
  const vaultPath = toVaultRelativePath(basePath, absPath, deps);
  if (vaultPath == null) return null;
  const f = deps.getAbstractFileByPath(vaultPath);
  return deps.isTFile(f) ? f : null;
}

/**
 * The gate for routing an "Open file" click to the YAML Viewer: the viewer must
 * be enabled, the target must look like YAML, and it must resolve to an in-vault
 * TFile. Any false → caller falls back to the existing `shell.openPath` behavior.
 */
export function canOpenInYamlViewer(opts: {
  viewerEnabled: boolean;
  fileToOpen: string;
  hasTFile: boolean;
}): boolean {
  return opts.viewerEnabled && isYamlFile(opts.fileToOpen) && opts.hasTFile;
}
