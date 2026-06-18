import { App, PluginSettingTab, Setting, normalizePath, setIcon } from "obsidian";
import type SkillLayerPlugin from "./main";
import { normalizeExternalRoot } from "./parse";
import { RootKind, ScanRoot } from "./types";

/** Guess the right code path for a freshly added root from its path string. */
function inferKind(path: string): RootKind {
  const trimmed = path.trim();
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return "external"; // absolute filesystem path
  }
  // A leading-dot segment anywhere means the Vault API can't see it.
  if (trimmed.split("/").some((seg) => seg.startsWith("."))) {
    return "adapter";
  }
  return "vault";
}

/**
 * The Skill Layer settings page (M11: slimmed to install/storage config only).
 * In order:
 *   1. Scan roots — the discovery dirs (enable/remove + add a root).
 *   2. Omnigent binary path — the install location.
 *   3. Default pinned ribbon icon — the global fallback glyph for pins that
 *      haven't chosen their own (per-skill picker still wins).
 *   4. Append vault-anchor instruction — the one launch-behavior toggle.
 * Everything explanatory or duplicative of omnigent's own config / the M10
 * Agents tab / the browser view (plugin description, invocation template,
 * server URL, the Agents section, tagging + pinned-skills text) was removed.
 */
export class SkillLayerSettingTab extends PluginSettingTab {
  private plugin: SkillLayerPlugin;

  constructor(app: App, plugin: SkillLayerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Scan roots -------------------------------------------------------
    new Setting(containerEl)
      .setName("Scan roots")
      .setHeading()
      .setDesc(
        "Vault-relative paths (\"\" = vault root, .claude/skills, skills) or " +
          "absolute desktop paths. The code path is inferred automatically.",
      );

    const settings = this.plugin.settings;

    settings.scanRoots.forEach((root, index) => {
      const setting = new Setting(containerEl)
        .setName(root.path === "" ? "(vault root)" : root.path)
        .setDesc(`Detection: ${root.kind}`);

      setting.addToggle((toggle) =>
        toggle
          .setTooltip("Enable / disable this root")
          .setValue(root.enabled)
          .onChange(async (value) => {
            root.enabled = value;
            await this.plugin.saveSettings();
            await this.plugin.rescan();
          }),
      );

      setting.addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Remove root")
          .onClick(async () => {
            settings.scanRoots.splice(index, 1);
            await this.plugin.saveSettings();
            await this.plugin.rescan();
            this.display();
          }),
      );
    });

    // Add-a-root row.
    let pendingPath = "";
    new Setting(containerEl)
      .setName("Add scan root")
      .setDesc("Type a path and click Add.")
      .addText((text) =>
        text
          .setPlaceholder(".claude/skills or /Users/me/skills")
          .onChange((value) => {
            pendingPath = value;
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            const raw = pendingPath.trim();
            if (raw === "") return;
            const kind = inferKind(raw);
            // Normalize vault-relative paths; for external paths strip trailing
            // slashes so the same root can't be added twice ("/a/skills" vs
            // "/a/skills/") — but never mangle filesystem roots.
            const path =
              kind === "external" ? normalizeExternalRoot(raw) : normalizePath(raw);
            const exists = settings.scanRoots.some(
              (r) => r.path === path && r.kind === kind,
            );
            if (!exists) {
              const newRoot: ScanRoot = { path, kind, enabled: true };
              settings.scanRoots.push(newRoot);
              await this.plugin.saveSettings();
              await this.plugin.rescan();
            }
            this.display();
          }),
      );

    if (!this.plugin.canScanExternal()) {
      containerEl.createEl("p", {
        cls: "setting-item-description skill-layer-warn",
        text:
          "External absolute-path roots require the desktop app with filesystem " +
          "access; they will be skipped in the current environment.",
      });
    }

    // --- Omnigent binary path ---------------------------------------------
    new Setting(containerEl)
      .setName("Omnigent binary path")
      .setDesc(
        "Absolute path to the omnigent binary. Blank = auto-detect " +
          "(~/.local/bin, /usr/local/bin, /opt/homebrew/bin).",
      )
      .addText((text) =>
        text
          .setPlaceholder("(auto-detect)")
          .setValue(settings.omnigentBinaryPath)
          .onChange(async (value) => {
            settings.omnigentBinaryPath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // --- Default pinned ribbon icon ---------------------------------------
    // A pinned skill normally picks its OWN icon ("Pin to ribbon…" / "Change
    // icon" on a skill row, stored in skillIcons[id]). This global default is the
    // fallback used when a pin has no per-skill icon (e.g. older/migrated pins).
    const currentIcon = this.plugin.defaultPinnedIcon();
    const isCustom = Boolean(settings.pinnedIcon);
    new Setting(containerEl)
      .setName("Default pinned ribbon icon")
      .setDesc(
        `Fallback Lucide icon for pinned skills without their own choice. ` +
          `Current: ${currentIcon}${isCustom ? "" : " (built-in default)"}.`,
      )
      .addButton((btn) => {
        btn.setTooltip("Choose a Lucide icon").onClick(() => {
          this.plugin.openDefaultIconPicker(() => this.display());
        });
        // Preview the current glyph inside the button (icon-only).
        setIcon(btn.buttonEl, currentIcon);
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("rotate-ccw")
          .setTooltip("Reset to the built-in default")
          .setDisabled(!isCustom)
          .onClick(async () => {
            await this.plugin.clearDefaultPinnedIcon();
            this.display();
          }),
      );

    // --- Append vault-anchor instruction ----------------------------------
    new Setting(containerEl)
      .setName("Append vault-anchor instruction")
      .setDesc(
        "Append a generic instruction to the launch prompt telling the run to " +
          "operate in and write into this vault (no git worktree).",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.appendVaultAnchor).onChange(async (value) => {
          settings.appendVaultAnchor = value;
          await this.plugin.saveSettings();
        }),
      );
  }
}
