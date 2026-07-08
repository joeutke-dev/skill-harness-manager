// Reveal hidden dot-folders (e.g. `.claude/`) in Obsidian's file explorer (M15).
//
// ⚠️ PRIVATE-API DEPENDENCY. Obsidian hides dot-prefixed files/folders at the
// adapter layer and exposes NO public API to reveal them. This mirrors the
// proven technique of the `show-hidden-files` community plugin: patch the
// FileSystemAdapter's private `reconcileDeletion` so that, when a hidden path
// that actually exists on disk is about to be dropped from the explorer, we
// instead surface it via the private `reconcileFileInternal`; suppress the
// "bad dotfile" i18n warning; and `listRecursive("")` to repopulate. These are
// UNDOCUMENTED internals and may break on an Obsidian upgrade — this is the
// plugin's first private-API surface (see the M15 PRD). Everything is fully
// reverted on toggle-off and on unload (function references restored
// synchronously first, so teardown is safe even fire-and-forget).
//
// Scope note: this reveals hidden dot-FOLDERS/files only. It intentionally does
// NOT touch the `showUnsupportedFiles` vault config (that governs non-markdown
// file EXTENSIONS — a separate concern from hidden dotfiles).

import { App, FileSystemAdapter } from "obsidian";

/** Folders that stay hidden even when the toggle is on. */
const NEVER_SHOW = new Set([".trash"]);

/**
 * Should `path` (a vault-relative path) be revealed when the toggle is on? True
 * when ANY segment starts with a dot, EXCEPT the vault's own config dir
 * (`.obsidian`, passed as `configDir`) and `.trash`, which always stay hidden.
 * Pure / unit-testable — the only piece of this module that can be tested
 * without a live Obsidian adapter.
 */
export function isRevealableHiddenPath(path: string, configDir: string): boolean {
  return path
    .split("/")
    .some(
      (seg) => seg.startsWith(".") && seg !== configDir && !NEVER_SHOW.has(seg),
    );
}

/** The subset of the private FileSystemAdapter surface this controller touches. */
interface PatchableAdapter {
  reconcileDeletion(realPath: string, path: string): Promise<unknown>;
  reconcileFileInternal?(realPath: string, path: string): Promise<unknown>;
  getRealPath(path: string): string;
  getFullPath(path: string): string;
  _exists(fullPath: string, path: string): Promise<boolean>;
  listRecursive(path: string): Promise<unknown>;
}

/** The i18next global Obsidian uses for UI strings. */
interface I18next {
  t(key: string, ...args: unknown[]): string;
}

/** Vault config get/set (private, used to read the config dir name only). */
type OriginalReconcile = (realPath: string, path: string) => Promise<unknown>;

/**
 * Owns the hidden-file reveal patch lifecycle. `enable()`/`disable()` are
 * idempotent; `teardown()` is the unload path (restores internals without the
 * explicit re-hide loop, matching the reference plugin).
 */
export class HiddenFilesController {
  private originalReconcileDeletion: OriginalReconcile | null = null;
  private originalI18nT: I18next["t"] | null = null;
  private readonly hiddenPaths = new Set<string>();
  private active = false;

  constructor(private readonly app: App) {}

  /** Only works on desktop with a real FileSystemAdapter. */
  canPatch(): boolean {
    return this.app.vault.adapter instanceof FileSystemAdapter;
  }

  private adapter(): PatchableAdapter {
    return this.app.vault.adapter as unknown as PatchableAdapter;
  }

  private get configDir(): string {
    return this.app.vault.configDir;
  }

  /** Reveal hidden files: patch the adapter, suppress the warning, rescan. */
  async enable(): Promise<void> {
    if (this.active || !this.canPatch()) return;
    this.active = true;
    this.patchAdapter();
    this.suppressDotfileWarning();
    await this.rescan();
  }

  /** Re-hide the revealed files and restore all patched internals. */
  async disable(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    for (const path of this.hiddenPaths) await this.hideFile(path);
    this.hiddenPaths.clear();
    await this.restoreAdapter();
    this.restoreDotfileWarning();
  }

  /** Unload path: restore internals (function swap is synchronous → safe). */
  teardown(): void {
    void this.restoreAdapter();
    this.restoreDotfileWarning();
    this.active = false;
  }

  private patchAdapter(): void {
    if (this.originalReconcileDeletion) return; // already patched
    const adapter = this.adapter();
    const original = adapter.reconcileDeletion.bind(adapter) as OriginalReconcile;
    this.originalReconcileDeletion = original;
    adapter.reconcileDeletion = async (realPath: string, path: string) => {
      if (isRevealableHiddenPath(path, this.configDir)) {
        const fullPath = adapter.getFullPath(path);
        if (await adapter._exists(fullPath, path)) {
          // Obsidian wants to drop this hidden-but-existing path from the view;
          // surface it instead and remember it so we can re-hide on disable.
          this.hiddenPaths.add(path);
          await this.showFile(path);
          return;
        }
        this.hiddenPaths.delete(path);
      }
      return original(realPath, path);
    };
  }

  private async restoreAdapter(): Promise<void> {
    if (!this.originalReconcileDeletion) return;
    const adapter = this.adapter();
    // Restore the original FIRST (synchronous), so the patch is gone even if the
    // async re-hide below is abandoned (fire-and-forget teardown).
    adapter.reconcileDeletion = this.originalReconcileDeletion;
    this.originalReconcileDeletion = null;
    for (const path of this.hiddenPaths) {
      await adapter.reconcileDeletion(adapter.getRealPath(path), path);
    }
    this.hiddenPaths.clear();
  }

  private async showFile(path: string): Promise<void> {
    const adapter = this.adapter();
    if (!adapter.reconcileFileInternal) return;
    await adapter.reconcileFileInternal(adapter.getRealPath(path), path);
  }

  private async hideFile(path: string): Promise<void> {
    if (!this.originalReconcileDeletion) return;
    const adapter = this.adapter();
    await this.originalReconcileDeletion(adapter.getRealPath(path), path);
  }

  private async rescan(): Promise<void> {
    await this.adapter().listRecursive("");
  }

  private suppressDotfileWarning(): void {
    const w = window as unknown as { i18next?: I18next };
    if (!w.i18next || this.originalI18nT) return;
    const orig = w.i18next.t.bind(w.i18next);
    this.originalI18nT = orig;
    w.i18next.t = ((...args: unknown[]) => {
      if (args[0] === "plugins.file-explorer.msg-bad-dotfile") return "";
      return orig(...(args as [string, ...unknown[]]));
    }) as I18next["t"];
  }

  private restoreDotfileWarning(): void {
    if (!this.originalI18nT) return;
    const w = window as unknown as { i18next?: I18next };
    if (w.i18next) w.i18next.t = this.originalI18nT;
    this.originalI18nT = null;
  }
}
