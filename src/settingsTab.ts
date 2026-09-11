import { App, PluginSettingTab, Setting, setIcon } from "obsidian";
import type SkillLayerPlugin from "./main";

/**
 * The Skill and Harness Manager settings page: general preferences only (toggles,
 * terminal / launch mode, panel width, pinned icon, vault anchor). Skill folders
 * are managed in the Skills tab and harnesses in the Harnesses tab of the skills
 * browser, not here.
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

    const settings = this.plugin.settings;

    // Per Obsidian's settings guidelines the first/default section is UNLABELED
    // (no heading — and never a "General" heading). Skill folders are managed in
    // the Skills tab and harnesses in the Harnesses tab, so this page is a single
    // unlabeled section of general preferences.

    // --- Show hidden folders (M15, placed first) --------------------------
    // Reveals dot-folders (e.g. .claude/) in Obsidian's file explorer via a
    // private-adapter patch (see hiddenFiles.ts). Applied live on toggle.
    const hiddenSetting = new Setting(containerEl)
      .setName("Show hidden folders")
      .setDesc(
        "Reveal hidden dot-folders (e.g. .claude/) in the file explorer. " +
          "Uses Obsidian internals; fully reverted when turned off.",
      )
      .addToggle((toggle) =>
        toggle
          .setDisabled(!this.plugin.canRevealHiddenFolders())
          .setValue(settings.showHiddenFolders)
          .onChange(async (value) => {
            await this.plugin.setShowHiddenFolders(value);
          }),
      );
    if (!this.plugin.canRevealHiddenFolders()) {
      hiddenSetting.setDesc(
        "Requires the desktop app with filesystem access — unavailable here.",
      );
    }

    // --- Native menus -----------------------------------------------------
    // Obsidian's native OS context menus (on by default on macOS) can't render
    // the plugin's Lucide icons in the right-click "Run …" items. This mirrors
    // Obsidian's own `nativeMenus` setting so the user can turn it off from here
    // for a better experience — the brain icon then shows next to each skill.
    // Applied live via Obsidian's config. Desktop-only.
    if (this.plugin.canControlNativeMenus()) {
      new Setting(containerEl)
        .setName("Native menus")
        .setDesc(
          "Obsidian's native menus (default on macOS) can't show this plugin's " +
            "icons in right-click menus. Turn this OFF for a better Skill and " +
            "Harness Manager experience.",
        )
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.nativeMenusEnabled()).onChange((value) => {
            this.plugin.setNativeMenus(value);
            this.display();
          }),
        );
    }

    // --- Preferred terminal (terminal launches) ---------------------------
    // Which terminal emulator opens when a skill/command/script runs in
    // "terminal" launch mode. It runs the SAME command headless mode would (the
    // skill's harness / the script body), just visibly. Options are the terminals
    // detected on disk (macOS app bundles + tmux); Auto uses the OS default.
    const terminals = this.plugin.getDetectedTerminals();
    const resolvedTerm = this.plugin.resolvePreferredTerminal();
    new Setting(containerEl)
      .setName("Preferred terminal")
      .setDesc(
        `Which terminal opens for terminal-mode launches. Auto uses your OS default. ` +
          `Resolved: ${resolvedTerm.def.label}.`,
      )
      .addDropdown((d) => {
        for (const t of terminals) d.addOption(t.def.id, t.def.label);
        d.setValue(settings.preferredTerminal || "auto");
        d.onChange(async (v) => {
          settings.preferredTerminal = v === "auto" ? "" : v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    // --- Default launch mode ----------------------------------------------
    new Setting(containerEl)
      .setName("Default launch mode")
      .setDesc(
        "How Run launches skills/commands by default. Headless runs in the " +
          "background; Terminal opens your preferred CLI in a terminal. Override " +
          "per-skill in its Configure panel.",
      )
      .addDropdown((d) => {
        d.addOption("headless", "Headless");
        d.addOption("terminal", "Terminal");
        d.setValue(settings.defaultLaunchMode);
        d.onChange(async (v) => {
          settings.defaultLaunchMode = v === "terminal" ? "terminal" : "headless";
          await this.plugin.saveSettings();
        });
      });

    // --- Panel width ------------------------------------------------------
    // The width (px) the browser side panel opens at from the ribbon/command, so
    // it's consistent regardless of how the sidebar was last dragged.
    new Setting(containerEl)
      .setName("Panel width")
      .setDesc(
        "Width (in pixels) the skills browser opens at when launched from the " +
          "ribbon or command. 520 fits all the tabs comfortably.",
      )
      .addText((text) =>
        text
          .setPlaceholder("520")
          .setValue(String(settings.panelWidth || 520))
          .onChange(async (value) => {
            const n = Number.parseInt(value.trim(), 10);
            if (Number.isFinite(n) && n >= 200 && n <= 1200) {
              settings.panelWidth = n;
              await this.plugin.saveSettings();
            }
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

    // Skill folders (add tool folders / external scan roots) and harnesses are
    // managed in the skills browser — its Skills and Harnesses tabs — not here.
  }
}
