import { App, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type SkillLayerPlugin from "./main";
import { normalizeExternalRoot } from "./parse";
import { BUILTIN_HARNESSES, RootKind, ScanRoot } from "./types";

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

export class SkillLayerSettingTab extends PluginSettingTab {
  private plugin: SkillLayerPlugin;

  constructor(app: App, plugin: SkillLayerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Skill Layer" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Discover, browse, and pin AI skills (SKILL.md files) across your vault, " +
        "dot-folders like .claude/skills, and external desktop directories.",
    });

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

    // --- Launch behavior --------------------------------------------------
    new Setting(containerEl).setName("Launch").setHeading();

    new Setting(containerEl)
      .setName("Invocation template")
      .setDesc(
        "The skill invocation string for the “Copy invocation” action (for manual " +
          "REPL paste). Launch uses a natural-language prompt instead. " +
          "Placeholders: {name} {path} {label}.",
      )
      .addText((text) =>
        text
          .setPlaceholder("/{name}")
          .setValue(settings.invocationTemplate)
          .onChange(async (value) => {
            settings.invocationTemplate = value || "/{name}";
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Launch (the ribbon icon and a skill row’s “Launch”) spawns a one-shot, " +
        "UI-visible omnigent run in the vault directory — view it in the omnigent " +
        "UI. The plugin spawns only the omnigent binary, with array arguments and " +
        "no shell. “Copy invocation” and “Open file” are unchanged.",
    });

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

    new Setting(containerEl)
      .setName("Omnigent server URL")
      .setDesc(
        "Blank = local daemon (no --server). If set, the run is sent to this " +
          "server so it appears in your remote omnigent UI.",
      )
      .addText((text) =>
        text
          .setPlaceholder("(local daemon)")
          .setValue(settings.omnigentServerUrl)
          .onChange(async (value) => {
            settings.omnigentServerUrl = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Harness")
      .setDesc("Blank = omnigent default. If set, passed as --harness.")
      .addText((text) =>
        text
          .setPlaceholder("(default)")
          .setValue(settings.omnigentHarness)
          .onChange(async (value) => {
            settings.omnigentHarness = value.trim();
            await this.plugin.saveSettings();
          }),
      );

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

    // --- Harnesses --------------------------------------------------------
    this.renderHarnessesSection(containerEl);

    // The former global "Pinned ribbon icon" setting is gone — each pinned
    // skill now picks its own Lucide icon from the Skill Layer browser ("Pin to
    // ribbon…" / "Change icon"). Any old global value is read only as a
    // one-time migration fallback for pre-existing pins.
    new Setting(containerEl)
      .setName("Pinned ribbon icons")
      .setDesc(
        "Each pinned skill chooses its own icon from the Skill Layer view — " +
          'use "Pin to ribbon…" or "Change icon" on a skill row.',
      );

    // --- Tagging ----------------------------------------------------------
    new Setting(containerEl).setName("Tagging").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Each skill shows tags from three sources: its frontmatter tags: field, " +
        "#tag tokens in its description, and a dimmed virtual tag auto-derived " +
        "from its folder. Click any chip to filter.",
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Frontmatter tags: is the single authoritative place the UI writes. Only " +
        "frontmatter chips have a remove ×; description and folder chips are " +
        "read-only (edit the note to change a description #tag). “+ tag” adds to " +
        "frontmatter — if a tag currently exists only in the description, adding " +
        "it promotes it to the authoritative, natively-indexed frontmatter list.",
    });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Writes happen ONLY on an explicit add/remove and never touch the " +
        "description. In-vault frontmatter tags appear in Obsidian's native tag " +
        "pane and search; external and dot-folder skills (e.g. .claude/skills) " +
        "live outside the vault index, so only this plugin's tag layer applies " +
        "to them. The body, line endings, and other frontmatter are preserved; " +
        "the tags: field is normalized to a compact inline list.",
    });

    // --- Pinned skills ----------------------------------------------------
    new Setting(containerEl).setName("Pinned skills").setHeading();
    if (settings.pinnedSkillIds.length === 0) {
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No skills pinned. Pin skills from the Skill Layer browser view.",
      });
    } else {
      for (const id of [...settings.pinnedSkillIds]) {
        const skill = this.plugin.getSkillById(id);
        new Setting(containerEl)
          .setName(skill?.name ?? "(missing skill)")
          .setDesc(id)
          .addButton((btn) =>
            btn
              .setButtonText("Unpin")
              .setWarning()
              .onClick(async () => {
                await this.plugin.unpinById(id);
                this.display();
              }),
          );
      }
    }
  }

  /**
   * The "Harnesses" settings section: refresh-from-omnigent (discovery), an
   * add-custom-token control, and a read-only view of the current effective
   * list. The per-skill selector in the browser view renders from the same
   * effective list, so anything surfaced here appears there too.
   */
  private renderHarnessesSection(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    new Setting(containerEl).setName("Harnesses").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "Per-skill harness tokens for the launch dropdown. The list is the " +
        "built-ins, plus any tokens discovered from omnigent and any custom " +
        "tokens you add. The “omnigent (default)” choice omits --harness; every " +
        "other choice launches as run --harness <token>. A token reaches the " +
        "command line only after passing a strict charset check; this is " +
        "plugin-local and never written into any SKILL.md.",
    });

    new Setting(containerEl)
      .setName("Refresh from omnigent")
      .setDesc(
        "Run `omnigent run --help` and cache the harness tokens it advertises. " +
          "Built-ins remain available if discovery fails.",
      )
      .addButton((btn) =>
        btn
          .setButtonText("Refresh from omnigent")
          .setCta()
          .onClick(async () => {
            const count = await this.plugin.discoverHarnesses();
            if (count > 0) {
              new Notice(
                `Skill Layer: discovered ${count} harness${
                  count === 1 ? "" : "es"
                } from omnigent.`,
              );
            }
            this.display();
          }),
      );

    // Add a custom harness token.
    let pendingToken = "";
    new Setting(containerEl)
      .setName("Add custom harness")
      .setDesc("A harness token (letters, digits, . _ -; no leading dash).")
      .addText((text) =>
        text.setPlaceholder("my-harness").onChange((value) => {
          pendingToken = value;
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("Add").onClick(async () => {
          const result = await this.plugin.addCustomHarness(pendingToken);
          if (result === "invalid") {
            new Notice(
              "Skill Layer: invalid harness token (use letters, digits, . _ - and no leading dash).",
            );
            return;
          }
          if (result === "duplicate") {
            new Notice("Skill Layer: that harness is already in the list.");
            return;
          }
          this.display();
        }),
      );

    // Custom tokens each get a Remove control.
    if (settings.customHarnesses.length > 0) {
      for (const token of [...settings.customHarnesses]) {
        new Setting(containerEl)
          .setName(token)
          .setDesc("Custom harness")
          .addExtraButton((b) =>
            b
              .setIcon("trash")
              .setTooltip("Remove custom harness")
              .onClick(async () => {
                await this.plugin.removeCustomHarness(token);
                this.display();
              }),
          );
      }
    }

    // Read-only view of the current effective list (default sentinel + tokens),
    // labeled by origin so the user sees exactly what's available.
    const builtinSet = new Set<string>(BUILTIN_HARNESSES);
    const discoveredSet = new Set(settings.discoveredHarnesses);
    const tokens = this.plugin.effectiveHarnessTokens();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Effective list (shown in each skill's harness dropdown):",
    });
    const chips = containerEl.createDiv({ cls: "skill-layer-harness-chips" });
    // The default sentinel always leads the dropdown.
    chips.createSpan({
      cls: "skill-layer-chip skill-layer-harness-chip",
      text: "omnigent (default)",
    });
    for (const token of tokens) {
      const origin = builtinSet.has(token)
        ? "is-builtin"
        : discoveredSet.has(token)
          ? "is-discovered"
          : "is-frontmatter";
      const originLabel = builtinSet.has(token)
        ? "built-in"
        : discoveredSet.has(token)
          ? "discovered"
          : "custom";
      const chip = chips.createSpan({
        cls: `skill-layer-chip skill-layer-harness-chip ${origin}`,
        attr: { title: `${token} (${originLabel})` },
      });
      chip.setText(token);
    }
  }
}
