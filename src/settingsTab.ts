import { App, Notice, PluginSettingTab, Setting, normalizePath, setIcon } from "obsidian";
import { defaultSkillScanRoots } from "./folders";
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
 * The Skill and Harness Manager settings page (M11: slimmed to install/storage config only).
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

  /**
   * Open a native folder picker and pass the chosen folder's ABSOLUTE path to
   * `onPick`. Uses a hidden `<input type="file" webkitdirectory>` — in Electron
   * the selected files expose an absolute `.path`, whose directory is the folder.
   * No Electron dialog/remote dependency. No-op (with a Notice) if unavailable.
   */
  private pickFolder(onPick: (absPath: string) => void): void {
    const input = createEl("input", {
      attr: { type: "file", webkitdirectory: "", multiple: "" },
    });
    input.style.display = "none";
    input.addEventListener("change", () => {
      const files = input.files;
      // Electron exposes an absolute `path` on the File; the folder is its dir.
      const first = files && files.length > 0
        ? (files[0] as File & { path?: string }).path
        : undefined;
      if (first) {
        // Strip the file name to get the picked directory (POSIX or Windows sep).
        const dir = first.replace(/[/\\][^/\\]*$/, "");
        onPick(dir || first);
      } else {
        new Notice("Skill and Harness Manager: could not read the chosen folder path.");
      }
      input.remove();
    });
    // Some platforms need the element in the DOM to fire the dialog.
    activeDocument.body.appendChild(input);
    input.click();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const settings = this.plugin.settings;

    // ============================ GENERAL ============================
    new Setting(containerEl).setName("General").setHeading();

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
          "per-skill in its ⚙ Configure panel.",
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

    // ============================ SCAN ROOTS =========================
    const scanHeading = new Setting(containerEl).setName("Scan roots").setHeading();

    // The built-in defaults are always scanned (no per-root toggles — they'd
    // clutter the settings). Both the intro and the always-scanned list live as
    // paragraphs inside the heading's description element, so they share the same
    // font/styling. Custom roots are shown as removable rows below.
    const defaultPaths = new Set(defaultSkillScanRoots().map((r) => r.path));
    const isDefault = (root: ScanRoot): boolean =>
      root.kind !== "external" && defaultPaths.has(root.path);

    scanHeading.descEl.createEl("p", {
      text:
        "The folders scanned for skills and commands. The built-in defaults cover " +
        "the standard tool folders; add your own below for custom or " +
        "outside-the-vault locations.",
    });
    const defaultLabels = settings.scanRoots
      .filter(isDefault)
      .map((r) => (r.path === "" ? "(vault root)" : r.path));
    const note = scanHeading.descEl.createEl("p");
    note.createSpan({ text: "Always scanned: " });
    defaultLabels.forEach((label, i) => {
      if (i > 0) note.createSpan({ text: ", " });
      note.createEl("code", { text: label });
    });

    // Custom (user-added) roots — each removable.
    settings.scanRoots.forEach((root, index) => {
      if (isDefault(root)) return;
      new Setting(containerEl)
        .setName(root.path === "" ? "(vault root)" : root.path)
        .setDesc(`Custom · ${root.kind}`)
        .addExtraButton((btn) =>
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

    // Shared add-a-root routine (used by both the text field and the folder picker).
    const addRoot = async (raw: string): Promise<void> => {
      const trimmed = raw.trim();
      if (trimmed === "") return;
      const kind = inferKind(trimmed);
      // Normalize vault-relative paths; for external paths strip trailing slashes
      // so the same root can't be added twice — but never mangle filesystem roots.
      const path =
        kind === "external" ? normalizeExternalRoot(trimmed) : normalizePath(trimmed);
      const exists = settings.scanRoots.some((r) => r.path === path && r.kind === kind);
      if (!exists) {
        settings.scanRoots.push({ path, kind, enabled: true });
        await this.plugin.saveSettings();
        await this.plugin.rescan();
      }
      this.display();
    };

    // Add-a-root row: a vault-relative OR absolute path, plus a folder picker for
    // choosing an outside-the-vault folder without typing its path.
    let pendingPath = "";
    new Setting(containerEl)
      .setName("Add scan root")
      .setDesc(
        "A vault-relative path (e.g. my-skills) or an absolute path to a folder " +
          "anywhere on disk (e.g. /Users/me/skills). The type is inferred.",
      )
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
          .onClick(() => void addRoot(pendingPath)),
      )
      .addButton((btn) =>
        btn
          .setButtonText("Browse folder…")
          .setTooltip("Pick a folder anywhere on disk (added as an external root)")
          .onClick(() => this.pickFolder((abs) => void addRoot(abs))),
      );

    if (!this.plugin.canScanExternal()) {
      containerEl.createEl("p", {
        cls: "setting-item-description skill-layer-warn",
        text:
          "External absolute-path roots require the desktop app with filesystem " +
          "access; they will be skipped in the current environment.",
      });
    }

    // ============================ OMNIGENT ===========================
    new Setting(containerEl).setName("Omnigent").setHeading();

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

    // --- Custom harnesses (M15.3) -----------------------------------------
    // ======================= CUSTOM HARNESSES ========================
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
              if (err) new Notice(`Skill and Harness Manager: ${err}`);
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
              new Notice(`Skill and Harness Manager: ${err}`);
              return;
            }
            this.display();
          }),
      );

    // Register-by-prompt: let an AI CLI add ITSELF as a harness. The user copies
    // this prompt (via the code-block copy button), runs it in their CLI, and the
    // model edits data.json; Reload then picks it up without a full plugin reload.
    const prompt = this.plugin.harnessRegistrationPrompt();
    new Setting(containerEl)
      .setName("Prompt a harness to register itself")
      .setDesc(
        "Copy this prompt and run it inside your AI CLI (Claude Code, Codex, " +
          "omnigent, …). It will add itself as a harness; then Reload to pick it up.",
      )
      .addButton((btn) =>
        btn.setButtonText("Reload").onClick(async () => {
          await this.plugin.reloadSettingsFromDisk();
          this.display();
        }),
      );
    this.renderCopyBlock(containerEl, prompt);
  }

  /**
   * A read-only code block with a hover copy button in the top-right corner,
   * mirroring Obsidian's own code-block copy affordance. Clicking the button (the
   * two-square "copy" glyph) copies the full text and briefly shows a check.
   */
  private renderCopyBlock(containerEl: HTMLElement, text: string): void {
    const wrap = containerEl.createDiv({ cls: "skill-layer-copyblock" });
    const copyBtn = wrap.createEl("button", {
      cls: "skill-layer-copyblock-btn",
      attr: { "aria-label": "Copy", title: "Copy" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
        setIcon(copyBtn, "check");
        copyBtn.addClass("is-copied");
        window.setTimeout(() => {
          setIcon(copyBtn, "copy");
          copyBtn.removeClass("is-copied");
        }, 1500);
      } catch {
        new Notice("Skill and Harness Manager: copy failed.");
      }
    });
    const pre = wrap.createEl("pre", { cls: "skill-layer-prompt-block" });
    pre.createEl("code", { text });
  }
}
