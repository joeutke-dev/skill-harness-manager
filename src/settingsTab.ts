import { App, Notice, PluginSettingTab, Setting, normalizePath, setIcon } from "obsidian";
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
 * The AI Skill Manager settings page (M11: slimmed to install/storage config only).
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

    const settings = this.plugin.settings;

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

    // --- Scan roots -------------------------------------------------------
    new Setting(containerEl)
      .setName("Scan roots")
      .setHeading()
      .setDesc(
        "Vault-relative paths (\"\" = vault root, .claude/skills, skills) or " +
          "absolute desktop paths. The code path is inferred automatically.",
      );

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

    // --- Omnigent server (--server target) --------------------------------
    new Setting(containerEl)
      .setName("Omnigent server")
      .setDesc(
        "Passed as `omnigent run --server <value>` on every launch. Blank = " +
          "omnigent's own default routing. Set a host URL (e.g. " +
          "https://your-omnigent-host) to use its models while work " +
          "runs LOCALLY in the vault — this avoids the 'os_env.cwd must be a " +
          "relative path' error from connecting directly to a remote server. " +
          "Update it when your host URL changes. Use `local` to force the " +
          "local server.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(omnigent default)")
          .setValue(settings.omnigentServerUrl)
          .onChange(async (value) => {
            settings.omnigentServerUrl = value.trim();
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

    // --- Harness (per-skill; informational) -------------------------------
    // The omnigent --harness set is fixed (no config needed); the per-skill
    // choice lives on each skill row in the browser, alongside "Run with".
    // --- Custom harnesses (M15.3) -----------------------------------------
    new Setting(containerEl)
      .setName("Custom harnesses")
      .setHeading()
      .setDesc(
        "Run skills through your own command instead of an omnigent --harness. " +
          "The harnesses omnigent already has configured are picked up " +
          "automatically (see the browser's Harnesses tab); add extra ones here. " +
          "Each skill row's Harness dropdown lists them.",
      );

    // Existing custom harnesses, each removable, each with an optional Resume
    // command used by the Sessions tab's Connect button (M20).
    settings.harnesses.forEach((h) => {
      new Setting(containerEl)
        .setName(h.label)
        .setDesc(h.command.join(" "))
        .addExtraButton((btn) =>
          btn
            .setIcon("trash")
            .setTooltip("Remove harness")
            .onClick(async () => {
              await this.plugin.removeCustomHarness(h.id);
              this.display();
            }),
        );
      new Setting(containerEl)
        .setName("↳ Resume command")
        .setDesc(
          "Optional. What the Sessions-tab Connect runs to reconnect to a " +
            "session from this harness (absolute binary, no {prompt}). Blank = " +
            "best-effort. Example: /usr/local/bin/isaac resume",
        )
        .addText((text) =>
          text
            .setPlaceholder("(best-effort)")
            .setValue((h.resumeCommand ?? []).join(" "))
            .onChange(async (v) => {
              const err = await this.plugin.setCustomHarnessResume(h.id, v);
              if (err) new Notice(`AI Skill Manager: ${err}`);
            }),
        );
    });

    // Add-a-harness row: a name + a single-line command containing {prompt}.
    let pendingHarnessLabel = "";
    let pendingHarnessCmd = "";
    new Setting(containerEl)
      .setName("Add harness")
      .setDesc(
        "Name + full command on one line. The first token must be an ABSOLUTE " +
          "binary path, and the command must include the {prompt} placeholder " +
          "(replaced with the skill prompt). Spawned with no shell. " +
          "Example (vibe): /usr/local/bin/isaac -p {prompt}",
      )
      .addText((text) =>
        text
          .setPlaceholder("Name (e.g. vibe)")
          .onChange((v) => {
            pendingHarnessLabel = v;
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/isaac -p {prompt}")
          .onChange((v) => {
            pendingHarnessCmd = v;
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            const err = await this.plugin.addCustomHarness(
              pendingHarnessLabel,
              pendingHarnessCmd,
            );
            if (err) {
              new Notice(`AI Skill Manager: ${err}`);
              return;
            }
            this.display();
          }),
      );
  }
}
