import { spawn } from "child_process";
import { shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as nodePath from "path";
import {
  FileSystemAdapter,
  Menu,
  Notice,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Detector } from "./detector";
import {
  buildOpenerCommand,
  DetectedTerminal,
  detectInstalledTerminals,
  resolvePreferredTerminal,
  TMUX_SESSION,
} from "./terminal";
import { EXAMPLE_SKILL_BODY, EXAMPLE_SKILL_REL_PATH } from "./example";
import {
  DEFAULT_PINNED_ICON,
  elementHasSvg,
  pinAction,
  resolvePinnedIcon,
} from "./icon";
import { IconPickerModal } from "./iconPicker";
import {
  AGENT_CONFIG_SUBDIR,
  AGENT_SESSION_PROMPT,
  augmentPath,
  buildAgentInvocation,
  buildLaunchPrompt,
  buildOmnigentArgv,
  buildRightClickMenuItems,
  buildSkillCliInvocation,
  BUNDLE_CONFIG_NAME,
  ClaudeAgent,
  CustomAgent,
  buildCustomHarnessArgv,
  buildCustomHarnessCliInvocation,
  ConfiguredHarness,
  CustomHarness,
  decodeAgentChoice,
  discoverCustomAgents,
  encodeAgentChoice,
  parseClaudeAgentFrontmatter,
  encodeCustomHarnessChoice,
  HARNESS_DEFAULT_VALUE,
  isAllowedBuiltinAgent,
  isAllowedHarness,
  isValidCustomAgentPath,
  isValidCustomHarnessCommand,
  OMNIGENT_HARNESSES,
  parseConfiguredHarnesses,
  parseHarnessCommandLine,
  parseHarnessValue,
  resolveAgentLaunch,
  resolveOmnigentBinary,
  resolveSkillHarness,
  safeCustomAgentRealPath,
  SkillAgent,
  toInteractiveArgv,
} from "./launch";
import {
  agentFolderSegments,
  commandFolderSegments,
  defaultSkillScanRoots,
  homeSkillRootPaths,
  joinHome,
  skillFolderSegments,
} from "./folders";
import { HiddenFilesController, isRevealableHiddenPath } from "./hiddenFiles";
import {
  coerceFrontmatterTags,
  firstHeading,
  inferSourceLabel,
  parseFrontmatter,
  resolveSkillTags,
  sanitizeTag,
} from "./parse";
import { SkillLayerSettingTab } from "./settingsTab";
import {
  buildRawTerminalScript,
  buildResumeArgv,
  buildTerminalScript,
  LaunchedSession,
  SESSION_MAX_AGE_MS,
  sessionToolFromCommand,
  SessionTool,
} from "./sessions";
import { addTagToContent, removeTagFromContent } from "./tagEdit";
import {
  BashScript,
  DEFAULT_SETTINGS,
  LaunchMode,
  Skill,
  SkillLayerSettings,
} from "./types";
import { SKILL_LAYER_VIEW, SkillBrowserView } from "./view";
import { decideToggleAction } from "./viewToggle";
import {
  canOpenInYamlViewer,
  detectYamlViewerEnabled,
  resolveVaultTFile,
  YAML_VIEWER_VIEW_TYPE,
} from "./yamlViewer";

/** Internal (non-public) command registry surface used to unregister commands. */
interface CommandsApi {
  removeCommand?(id: string): void;
}

const RESCAN_DEBOUNCE_MS = 600;

export default class SkillLayerPlugin extends Plugin {
  settings!: SkillLayerSettings;
  private detector!: Detector;
  private skills: Skill[] = [];

  /** Tracked per-skill ribbon icons so we can `.remove()` them on unpin. */
  private ribbonIcons = new Map<string, HTMLElement>();
  /** Full command ids registered per pinned skill, for clean removal. */
  private pinnedCommandIds = new Map<string, string>();
  /** Local command ids currently in use, to guarantee no id collisions. */
  private usedCommandLocalIds = new Set<string>();

  /** Cached custom agents discovered from `<vault>/.omnigent/agent-configs`. */
  private customAgents: CustomAgent[] = [];

  /** Cached terminal emulators detected on disk (for the preferred-terminal dropdown). */
  private detectedTerminals: DetectedTerminal[] = [];

  /** Cached Claude subagents (M17) from `<vault>/.claude/agents` + `~/.claude/agents`. */
  private claudeAgents: ClaudeAgent[] = [];

  /** Cached commands (M18): `*.md` under each tool's commands folder (Skill-shaped, kind:"command"). */
  private commands: Skill[] = [];

  /** Cached harnesses discovered from `omnigent config list` (M15.3). */
  private configuredHarnesses: ConfiguredHarness[] = [];
  /** True once a discovery attempt has completed (success or empty). */
  private harnessesDiscovered = false;

  /** Controls the hidden-dot-folder reveal patch (M15); lazily constructed. */
  private hiddenFiles!: HiddenFilesController;

  /**
   * True when WE flipped the global hidden reveal ON temporarily (M16/M17): the
   * global toggle was off and the user opened a hidden-folder skill. The reveal
   * stays on while ANY open file is inside a hidden folder — so the user can move
   * freely between hidden folders — and is flipped back off only once no open
   * file is in a hidden folder (i.e. they opened a normal, visible file). Never
   * touched while the global toggle is on, so we don't fight the user's setting.
   */
  private tempRevealActive = false;
  /** Signature of currently-open skill files, so layout-change only re-renders
   *  the view when a skill's open/closed state actually changed. */
  private lastOpenSkillSig = "";

  private rescanTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.detector = new Detector(this.app, () => this.settings);
    this.hiddenFiles = new HiddenFilesController(this.app);

    this.registerView(
      SKILL_LAYER_VIEW,
      (leaf: WorkspaceLeaf) => new SkillBrowserView(leaf, this),
    );

    this.addRibbonIcon("brain-circuit", "Skill and Harness Manager: toggle skills browser", () => {
      void this.toggleView();
    });

    this.addCommand({
      id: "open-browser",
      name: "Open skills browser",
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new SkillLayerSettingTab(this.app, this));

    // Hot-reload for Vault-API (non-dot) roots. `vault.on('modify')` fires on
    // edit (incl. external edits Obsidian detects), but the metadataCache may
    // not be re-parsed yet at that moment — so we ALSO listen to
    // `metadataCache.on('changed')`, which fires after a fresh re-parse, and
    // the scan reads fresh file content anyway (see Detector.scanVaultRoot).
    // Dot-folder / external roots emit no events; they refresh on view open
    // and via the in-view Rescan / Refresh buttons.
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on("modify", () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRescan()));
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRescan()));
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.scheduleRescan()),
    );

    // M3: file-explorer right-click. For each right-click-enabled skill, add a
    // `Run "<name>" here` item that launches it one-shot with the clicked
    // file/folder as context. Fires for both files and folders (TAbstractFile).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) =>
        this.addFileMenuItems(menu, file),
      ),
    );

    // Initial scan + restore pinned ribbon icons once the layout is ready.
    this.app.workspace.onLayoutReady(async () => {
      await this.rescan();
      this.recreatePinnedRibbons();
      // Reveal hidden dot-folders if the toggle is on (deferred to layout-ready,
      // like the reference plugin, so the file explorer exists to repopulate).
      if (this.settings.showHiddenFolders) {
        void this.hiddenFiles.enable();
      }
      // Discover omnigent-configured harnesses (best-effort, non-blocking) so the
      // per-skill Harness dropdown + Harnesses tab reflect the user's omnigent.
      void this.discoverConfiguredHarnesses();
      // Detect installed terminal emulators for the preferred-terminal setting.
      this.detectTerminals();
      // Seed the bundled example skill on first run (no-op after the first seed
      // or if the file already exists). Non-blocking; never throws.
      void this.seedExampleSkill();
    });

    // Keep the Open/Close-file button labels accurate and tear down a temporary
    // hidden reveal when its skill's tab is closed (by our button or by hand).
    this.registerEvent(
      this.app.workspace.on("layout-change", () => void this.onLayoutChange()),
    );
  }

  onunload(): void {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    // Restore the hidden-file adapter patch (function swap is synchronous).
    this.hiddenFiles?.teardown();
    // Explicitly remove tracked ribbon icons (Obsidian also cleans these, but
    // we own the Map so we leave nothing dangling).
    for (const el of this.ribbonIcons.values()) el.remove();
    this.ribbonIcons.clear();
    // Symmetric teardown: clear the command-tracking maps too. (Commands are
    // unregistered by Obsidian on unload; this just drops our in-memory state.)
    this.pinnedCommandIds.clear();
    this.usedCommandLocalIds.clear();
  }

  // --- Settings ----------------------------------------------------------
  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      (await this.loadData()) as Partial<SkillLayerSettings> | null,
    );
    // Migration: the harness selector (the M1 global `--harness` plus the M4–M7
    // per-skill harness machinery) is replaced by the per-skill AGENT selector;
    // omnigent now picks the harness itself. Strip every legacy harness key
    // fail-closed (a plain `delete` cannot throw) so a stale data.json can never
    // reintroduce harness behavior. A skill that had a harness selected simply
    // reverts to the Default agent (it has no `skillAgent` entry). Everything
    // else in data.json is preserved by the Object.assign above.
    const raw = this.settings as unknown as Record<string, unknown>;
    for (const key of [
      // NOTE (M15): `skillHarness` is NO LONGER stripped — it is repurposed as
      // the per-skill omnigent `--harness` map (string values). Any stale value
      // from the removed M4–M7 harness selector (a different shape) is made safe
      // by `resolveHarness`, which fails closed against the hardcoded harness
      // allowlist, so a non-member simply emits no `--harness`.
      "discoveredHarnesses",
      "customHarnesses",
      "omnigentHarness",
      // M11: the user-configurable invocation template is gone — the "Copy
      // invocation" action now uses a FIXED natural-language form
      // (`Use the <name> skill.`). Strip it fail-closed so a stale data.json can
      // never reintroduce it; every OTHER setting (scanRoots, pins, skillAgent,
      // omnigentBinaryPath, omnigentServerUrl, appendVaultAnchor, …) is preserved
      // by the Object.assign above. NOTE (M19): `omnigentServerUrl` is BACK as a
      // real setting (per-launch `--server` target), so it is NOT stripped.
      "invocationTemplate",
    ]) {
      delete raw[key];
    }

    // M18: remove the home-directory (global) skill roots an earlier build
    // auto-added (external kind, disabled) — they cluttered settings and mixed
    // machine-global skills with the user's in-vault skills. Only the exact
    // auto-added paths are dropped, so a user's own custom external roots stay.
    const homeRoots = new Set(homeSkillRootPaths(os.homedir()));
    this.settings.scanRoots = this.settings.scanRoots.filter(
      (r) => !(r.kind === "external" && homeRoots.has(r.path)),
    );
    // Union the per-tool VAULT skill scan roots (from the Agentfiles tool map)
    // into whatever's stored, so in-vault skills across Claude/Cursor/Codex/etc.
    // are discovered out of the box. Additive + idempotent: existing roots (incl.
    // the user's custom ones and their enabled state) are preserved.
    const havePaths = new Set(this.settings.scanRoots.map((r) => r.path));
    for (const root of defaultSkillScanRoots()) {
      if (!havePaths.has(root.path)) {
        this.settings.scanRoots.push(root);
        havePaths.add(root.path);
      }
    }
    // Migration: the earlier default panel width (420) was too narrow for all six
    // tabs; bump a still-default value up to the new 520. A width the user chose
    // themselves (anything other than the old default) is left untouched.
    if (this.settings.panelWidth === 420) this.settings.panelWidth = 520;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Seed the bundled example skill on first run. No-op when already seeded
   * (`seededExample`), when the vault base can't be resolved / isn't a desktop
   * filesystem, or when the file already exists (so a user who edited it isn't
   * clobbered and a deleted one isn't recreated). Writes via Node `fs` because
   * `.agents/` is a hidden dot-folder outside the Vault API index. Never throws.
   */
  private async seedExampleSkill(): Promise<void> {
    if (this.settings.seededExample) return;
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return;
    try {
      const abs = nodePath.join(base, EXAMPLE_SKILL_REL_PATH);
      if (!fs.existsSync(abs)) {
        await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, EXAMPLE_SKILL_BODY, "utf8");
      }
      // Mark seeded even if the file already existed, so we stop probing.
      this.settings.seededExample = true;
      await this.saveSettings();
      await this.rescan();
    } catch (err) {
      console.error("[skill-layer] example skill seed failed:", err);
    }
  }

  // --- Creating skills / commands / folders (Skills & Commands tabs) ------
  /**
   * The tool-folder segments a NEW skill or command folder can be added into
   * (`.claude/skills`, `.codex/prompts`, …), for the "add folder" picker. Skills
   * use the skills segments; commands use the command segments.
   */
  addableFolderSegments(kind: "skill" | "command"): string[] {
    return kind === "command" ? commandFolderSegments() : skillFolderSegments();
  }

  /**
   * The tool-folder segments (for `kind`) that currently EXIST on disk in the
   * vault — used to render empty sections so a freshly-created (still-empty)
   * folder shows up with its per-section "+". Desktop-gated; [] when unavailable.
   */
  existingToolFolders(kind: "skill" | "command"): string[] {
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return [];
    return this.addableFolderSegments(kind).filter((seg) => {
      try {
        return fs.statSync(nodePath.join(base, seg)).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /**
   * Create a tool folder (e.g. `.claude/skills`) in the vault if absent, then
   * rescan so its (empty) section appears. Returns a user-facing error string, or
   * null on success. Desktop-gated; `seg` must be one of the known segments.
   */
  async createToolFolder(seg: string): Promise<string | null> {
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return "Requires the desktop app.";
    if (!this.addableFolderSegments("skill").includes(seg) &&
        !this.addableFolderSegments("command").includes(seg)) {
      return "Unknown folder.";
    }
    try {
      await fs.promises.mkdir(nodePath.join(base, seg), { recursive: true });
      await this.rescan();
      return null;
    } catch (err) {
      console.error("[skill-layer] createToolFolder failed:", err);
      return "Could not create the folder.";
    }
  }

  /**
   * Create a new SKILL inside the tool folder `folderSeg`: `<folderSeg>/<name>/
   * SKILL.md` with a minimal frontmatter stub, then open it in Obsidian (like the
   * Open file button). Returns an error string, or null on success. The name is
   * sanitized to a safe folder name; refuses to overwrite an existing file.
   */
  async createSkillInFolder(folderSeg: string, rawName: string): Promise<string | null> {
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return "Requires the desktop app.";
    const name = this.sanitizeItemName(rawName);
    if (!name) return "Please enter a valid name.";
    const relPath = `${folderSeg}/${name}/SKILL.md`;
    const abs = nodePath.join(base, relPath);
    if (fs.existsSync(abs)) return `A skill named "${name}" already exists here.`;
    const body = `---\nname: ${name}\ndescription: \n---\n\n# ${name}\n\n`;
    try {
      await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, body, "utf8");
    } catch (err) {
      console.error("[skill-layer] createSkillInFolder failed:", err);
      return "Could not create the skill file.";
    }
    await this.rescan();
    await this.openCreatedFile(relPath, abs);
    return null;
  }

  /**
   * Create a new COMMAND inside the tool folder `folderSeg`: `<folderSeg>/
   * <name>.md` (any markdown in a commands folder is a command), then open it in
   * Obsidian. Returns an error string, or null on success.
   */
  async createCommandInFolder(folderSeg: string, rawName: string): Promise<string | null> {
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return "Requires the desktop app.";
    const name = this.sanitizeItemName(rawName);
    if (!name) return "Please enter a valid name.";
    const relPath = `${folderSeg}/${name}.md`;
    const abs = nodePath.join(base, relPath);
    if (fs.existsSync(abs)) return `A command named "${name}" already exists here.`;
    const body = `# ${name}\n\n`;
    try {
      await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, body, "utf8");
    } catch (err) {
      console.error("[skill-layer] createCommandInFolder failed:", err);
      return "Could not create the command file.";
    }
    await this.rescan();
    await this.openCreatedFile(relPath, abs);
    return null;
  }

  /** A safe folder/file base name from user input (kebab-ish, no path separators). */
  private sanitizeItemName(raw: string): string {
    return (raw ?? "")
      .trim()
      .replace(/[^A-Za-z0-9._ -]+/g, "")
      .replace(/\s+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60);
  }

  /**
   * Open a just-created vault file in Obsidian. Tool folders are hidden
   * dot-folders, so reuse the same temporary-reveal path as `openSkill`
   * (`openHiddenSkillTemporarily`); fall back to the OS app if it never indexes.
   */
  private async openCreatedFile(vaultPath: string, absPath: string): Promise<void> {
    const tfile = this.detector.resolveTFile(vaultPath);
    if (tfile instanceof TFile) {
      await this.openTFileAndRevealFolder(tfile);
      return;
    }
    if (this.canRevealHiddenFolders() && !this.settings.showHiddenFolders) {
      if (await this.openHiddenSkillTemporarily(vaultPath)) return;
    }
    try {
      const result = await shell.openPath(absPath);
      if (result) new Notice(`Could not open file: ${result}`);
    } catch (err) {
      console.error("[skill-layer] openCreatedFile failed:", err);
    }
  }

  // --- Preferred terminal + launch mode ----------------------------------
  /** Re-detect installed terminal emulators into the cache (app bundles + tmux). */
  private detectTerminals(): void {
    this.detectedTerminals = detectInstalledTerminals({
      homedir: os.homedir(),
      // Standard macOS app locations (system + per-user Applications).
      appDirs: ["/Applications", nodePath.join(os.homedir(), "Applications")],
      exists: (p) => fs.existsSync(p),
    });
  }

  /** The terminal emulators detected on disk (for the settings dropdown). */
  getDetectedTerminals(): DetectedTerminal[] {
    return this.detectedTerminals;
  }

  /**
   * The effective preferred terminal, resolved fail-closed to `auto` against the
   * actually-detected set (a stale/uninstalled `preferredTerminal` falls back to
   * the OS default terminal). Used by the terminal-launch path + settings UI.
   */
  resolvePreferredTerminal(): DetectedTerminal {
    return resolvePreferredTerminal(this.settings.preferredTerminal, this.detectedTerminals);
  }

  /** The effective launch mode for a skill/command: per-item override, else the global default. */
  effectiveLaunchMode(id: string): LaunchMode {
    const override = this.settings.skillLaunchMode[id];
    return override === "headless" || override === "terminal"
      ? override
      : this.settings.defaultLaunchMode;
  }

  /** The <select> value for a skill's launch mode ("" = Default/global). */
  launchModeOptionValue(id: string): string {
    const v = this.settings.skillLaunchMode[id];
    return v === "headless" || v === "terminal" ? v : "";
  }

  /** Persist a skill's launch-mode override; "" / unknown deletes the key (→ global default). */
  async setSkillLaunchMode(id: string, value: string): Promise<void> {
    if (value === "headless" || value === "terminal") {
      this.settings.skillLaunchMode[id] = value;
    } else {
      delete this.settings.skillLaunchMode[id];
    }
    await this.saveSettings();
    this.refreshViews();
  }

  /** Absolute path to this plugin's data.json (config lives outside the vault
   *  markdown, under the configured config dir). Used by the "register a harness
   *  by prompt" flow so a model can edit it directly. */
  dataJsonPath(): string {
    const base = this.detector.vaultBasePath() ?? "<vault>";
    return `${base}/${this.app.vault.configDir}/plugins/${this.manifest.id}/data.json`;
  }

  /** A copy-paste prompt the user runs inside their AI CLI (Claude Code, Codex,
   *  omnigent, …) so the model registers ITSELF as a custom harness by appending
   *  to `harnesses` in data.json. `dataPath` is embedded so no guesswork. */
  harnessRegistrationPrompt(): string {
    return [
      `Register yourself as a launch "harness" in my Obsidian "Skill and Harness Manager" plugin.`,
      ``,
      `1. Open this plugin config JSON file:`,
      `   ${this.dataJsonPath()}`,
      `2. Parse it as JSON and ensure it has a top-level "harnesses" array (create it if missing).`,
      `3. Append ONE entry describing how to run YOU non-interactively with a single prompt:`,
      `     {`,
      `       "id": "<short-kebab-id>",`,
      `       "label": "<your product name>",`,
      `       "command": ["<absolute path to your CLI>", "<non-interactive flags>", "{prompt}"]`,
      `     }`,
      `   Rules: command[0] must be an absolute path; exactly one element must contain the`,
      `   literal token {prompt}; leave every other key in the file unchanged; write valid JSON.`,
      `   Optional: add "resumeCommand": ["<absolute CLI>", "<resume flags>"] (no {prompt}) to`,
      `   enable the Sessions tab's "Connect" button.`,
      `4. Tell me to click "Reload" in the plugin settings (or reload the plugin) so the`,
      `   new harness appears.`,
    ].join("\n");
  }

  /** Re-read data.json from disk into memory + refresh the UI. Lets a harness the
   *  user registered via the prompt (which edits data.json directly) show up
   *  without a full plugin reload. */
  async reloadSettingsFromDisk(): Promise<void> {
    await this.loadSettings();
    this.refreshViews();
    new Notice("Skill and Harness Manager: reloaded settings from disk.");
  }

  // --- Detection ---------------------------------------------------------
  canScanExternal(): boolean {
    return this.detector.canScanExternal();
  }

  private scheduleRescan(): void {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    this.rescanTimer = window.setTimeout(() => {
      this.rescanTimer = null;
      void this.rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  /** Re-run detection and refresh any open browser view. */
  async rescan(notify = false): Promise<void> {
    this.skills = await this.detector.scan();
    // Keep the custom-agent dropdown in step with on-disk config changes.
    this.scanCustomAgents();
    this.scanClaudeAgents();
    this.scanCommands();
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      const view = leaf.view;
      if (view instanceof SkillBrowserView) view.refresh();
    }
    if (notify) new Notice(`Skill and Harness Manager: found ${this.skills.length} skills.`);
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getSkillById(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  // --- Browser view ------------------------------------------------------
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SKILL_LAYER_VIEW);
    if (existing.length > 0) {
      await workspace.revealLeaf(existing[0]);
      // Revealing an existing leaf does NOT re-fire onOpen, so refresh from
      // disk here to pick up external edits (incl. dot-folder / external roots).
      await this.rescan();
      this.applyPanelWidth();
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    // A freshly created leaf's onOpen() runs the rescan itself.
    await leaf.setViewState({ type: SKILL_LAYER_VIEW, active: true });
    await workspace.revealLeaf(leaf);
    this.applyPanelWidth();
  }

  /**
   * Open the browser side panel at the configured `panelWidth` so it always uses
   * a consistent width rather than whatever the sidebar was last dragged to. The
   * right-sidebar width has no public API, so this sets the width on the right
   * split's container element (undocumented internals) behind a guarded cast and
   * a `requestAnimationFrame` (so it lands after the reveal lays out). Best-effort
   * — silently no-ops if the internals aren't shaped as expected or on mobile.
   */
  private applyPanelWidth(): void {
    const width = this.settings.panelWidth;
    if (!width || width <= 0) return;
    const rightSplit = (this.app.workspace as unknown as {
      rightSplit?: { containerEl?: HTMLElement; collapsed?: boolean };
    }).rightSplit;
    const el = rightSplit?.containerEl;
    if (!el) return;
    window.requestAnimationFrame(() => {
      try {
        el.style.width = `${width}px`;
        // Nudge Obsidian to reconcile the split sizes to the new width.
        this.app.workspace.requestSaveLayout?.();
      } catch (err) {
        console.error("[skill-layer] applyPanelWidth failed:", err);
      }
    });
  }

  /**
   * Ribbon behavior: toggle the Skill and Harness Manager pane.
   * - Not open                → open + reveal (via activateView).
   * - Open but not active      → reveal/focus it (via activateView).
   * - Open AND active/visible  → close (detach its leaves).
   *
   * The command-palette "Open skills browser" entry stays on activateView
   * (pure open+reveal, never closes) — closing on a command named "Open"
   * would be surprising. Only the ribbon toggles.
   */
  async toggleView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(SKILL_LAYER_VIEW);
    const activeView = workspace.getActiveViewOfType(SkillBrowserView);
    const isActiveVisible =
      activeView !== null && existing.includes(activeView.leaf);
    const action = decideToggleAction(existing.length > 0, isActiveVisible);
    if (action === "close") {
      workspace.detachLeavesOfType(SKILL_LAYER_VIEW);
      return;
    }
    // "open" and "reveal" both funnel through activateView (open+reveal+rescan).
    await this.activateView();
  }

  // --- Pinning + per-skill icons -----------------------------------------
  isPinned(id: string): boolean {
    return this.settings.pinnedSkillIds.includes(id);
  }

  // --- Right-click (file-menu) per-skill toggle (M3) ---------------------
  /** True if this skill is exposed in the file-explorer right-click menu. */
  isRightClickEnabled(id: string): boolean {
    return this.settings.rightClickSkillIds.includes(id);
  }

  /** Flip a skill's `rightClickEnabled` membership and persist to data.json. */
  async toggleRightClick(skill: Skill): Promise<void> {
    const on = this.isRightClickEnabled(skill.id);
    if (on) {
      this.settings.rightClickSkillIds = this.settings.rightClickSkillIds.filter(
        (x) => x !== skill.id,
      );
    } else {
      this.settings.rightClickSkillIds.push(skill.id);
    }
    await this.saveSettings();
    this.refreshViews();
    new Notice(
      `Skill and Harness Manager: ${on ? "removed" : "added"} "${skill.name}" ${
        on ? "from" : "to"
      } the right-click menu.`,
    );
  }

  // --- Per-skill AGENT selector ------------------------------------------
  /**
   * The absolute custom-agent config directory (`<vault>/.omnigent/agent-configs`),
   * or null when the vault base path can't be resolved (e.g. mobile). This is
   * BOTH the scan dir for discovery and the containment boundary every stored
   * custom path is re-validated against at launch.
   */
  agentConfigDir(): string | null {
    const base = this.detector.vaultBasePath();
    if (!base) return null;
    return nodePath.join(base, AGENT_CONFIG_SUBDIR);
  }

  /** The cached, discovered custom agents (display metadata for the dropdown). */
  getCustomAgents(): CustomAgent[] {
    return this.customAgents;
  }

  /**
   * Re-scan `<vault>/.omnigent/agent-configs` for custom agents into the cache
   * (no view refresh): loose `*.yaml`/`*.yml` files AND bundle directories
   * (`<name>/config.yaml`). A missing directory yields zero agents (no error).
   * All filesystem access is wrapped so this never throws.
   */
  private scanCustomAgents(): void {
    this.customAgents = discoverCustomAgents({
      dir: this.agentConfigDir(),
      readdir: (d) => fs.readdirSync(d),
      readFile: (p) => fs.readFileSync(p, "utf8"),
      isFile: (p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      },
      isDirectory: (p) => {
        try {
          return fs.statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
    });
  }

  /** Re-scan custom agents AND refresh open views (the Settings "Refresh" path). */
  refreshCustomAgents(): void {
    this.scanCustomAgents();
    this.refreshViews();
  }

  /**
   * Unified refresh (M18): re-scan everything the browser shows — skills,
   * commands, custom agents, Claude subagents (all via `rescan`) — and kick a
   * best-effort re-discovery of omnigent harnesses. This is the single "Refresh"
   * action wired to every tab's refresh control (it subsumes the old Rescan
   * button). Harness discovery is fire-and-forget so a slow/unavailable omnigent
   * never blocks the filesystem rescan.
   */
  async refreshAll(): Promise<void> {
    await this.rescan();
    void this.refreshConfiguredHarnesses();
  }

  // --- Claude subagents (M17) --------------------------------------------
  /** The cached, discovered Claude subagents (for the per-skill Agent dropdown
   *  when a claude/custom harness is selected). */
  getClaudeAgents(): ClaudeAgent[] {
    return this.claudeAgents;
  }

  /**
   * Scan `<vault>/.claude/agents` and `~/.claude/agents` for `*.md` subagents
   * into the cache (no view refresh). Name = frontmatter `name:` (else filename
   * stem); project entries win over global on a name clash. Missing dirs yield
   * zero (no error); all fs access is wrapped so this never throws.
   */
  private scanClaudeAgents(): void {
    const base = this.detector.vaultBasePath();
    const home = os.homedir();
    // M18: scan EVERY tool's agents folder (.claude/agents, .cursor/agents,
    // .codex/agents, …) — project (vault-relative) first, then home — so agents
    // from any assistant appear. Project wins over global on a name clash.
    const dirs: { dir: string; source: "project" | "global" }[] = [];
    for (const seg of agentFolderSegments()) {
      if (base) dirs.push({ dir: nodePath.join(base, seg), source: "project" });
    }
    for (const seg of agentFolderSegments()) {
      dirs.push({ dir: joinHome(home, seg), source: "global" });
    }

    const byName = new Map<string, ClaudeAgent>();
    for (const { dir, source } of dirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // missing dir → skip
      }
      for (const entry of entries.sort()) {
        if (!/\.md$/i.test(entry)) continue;
        const abs = nodePath.join(dir, entry);
        let text: string;
        try {
          if (!fs.statSync(abs).isFile()) continue;
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        const meta = parseClaudeAgentFrontmatter(text);
        const name = meta.name && meta.name.trim() ? meta.name.trim() : entry.replace(/\.md$/i, "");
        // Project (scanned first) wins; don't let global clobber it.
        if (byName.has(name)) continue;
        byName.set(name, {
          name,
          path: abs,
          source,
          ...(meta.description ? { description: meta.description } : {}),
        });
      }
    }
    this.claudeAgents = Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** Re-scan Claude subagents AND refresh open views (dropdown "Refresh" path). */
  refreshClaudeAgents(): void {
    this.scanClaudeAgents();
    this.refreshViews();
  }

  /**
   * The dropdown value for a skill's stored Claude subagent — the stored name if
   * it still resolves to a discovered agent, else "" (Default). Keeps the UI from
   * showing an orphaned selection; launch re-validates the same way.
   */
  claudeAgentOptionValue(id: string): string {
    const stored = this.settings.skillClaudeAgent[id];
    if (typeof stored !== "string" || !stored) return "";
    return this.claudeAgents.some((a) => a.name === stored) ? stored : "";
  }

  /** Persist a skill's Claude subagent choice; "" / unknown deletes the key. */
  async setSkillClaudeAgent(id: string, name: string): Promise<void> {
    if (name && this.claudeAgents.some((a) => a.name === name)) {
      this.settings.skillClaudeAgent[id] = name;
    } else {
      delete this.settings.skillClaudeAgent[id];
    }
    await this.saveSettings();
    this.refreshViews();
  }

  /** Display label for a skill's Claude subagent ("Default" when none/stale). */
  claudeAgentLabelFor(id: string): string {
    const v = this.claudeAgentOptionValue(id);
    return v || "Default";
  }

  // --- Commands (M18) ----------------------------------------------------
  /** The cached, discovered commands (for the Commands tab). Skill-shaped. */
  getCommands(): Skill[] {
    return this.commands;
  }

  /**
   * Scan every tool's commands folder (`.claude/commands`, `.codex/prompts`, …)
   * — project (vault-relative) first, then home — for `*.md` files, each of
   * which is one command. Unlike skills there's no SKILL.md rule: any markdown in
   * a commands folder is a command. Built as Skill objects with kind:"command" so
   * they reuse the whole row UI / per-item state. Deduped by absolute path
   * (project wins). All fs access wrapped; never throws.
   */
  private scanCommands(): void {
    const base = this.detector.vaultBasePath();
    const home = os.homedir();
    const dirs: { dir: string; vaultRel: string | null }[] = [];
    for (const seg of commandFolderSegments()) {
      if (base) dirs.push({ dir: nodePath.join(base, seg), vaultRel: seg });
    }
    for (const seg of commandFolderSegments()) {
      dirs.push({ dir: joinHome(home, seg), vaultRel: null });
    }

    const byId = new Map<string, Skill>();
    for (const { dir, vaultRel } of dirs) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // missing dir → skip
      }
      for (const entry of entries.sort()) {
        if (!/\.md$/i.test(entry)) continue;
        const abs = nodePath.join(dir, entry);
        let text: string;
        try {
          if (!fs.statSync(abs).isFile()) continue;
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        if (byId.has(abs)) continue;
        const fm = parseFrontmatter(text);
        const stem = entry.replace(/\.md$/i, "");
        const name = fm.name && fm.name.trim() ? fm.name.trim() : stem;
        const description =
          fm.description && fm.description.trim()
            ? fm.description.trim()
            : firstHeading(text) ?? "(no description)";
        const vaultPath = vaultRel ? `${vaultRel}/${entry}` : null;
        const relForTag = vaultPath ?? `${nodePath.basename(dir)}/${entry}`;
        byId.set(abs, {
          id: abs,
          kind: "command",
          name,
          description,
          path: abs,
          vaultPath,
          sourceRoot: dir,
          sourceLabel: inferSourceLabel(abs),
          detection: vaultRel ? "adapter" : "external",
          tags: resolveSkillTags({
            relativePath: relForTag,
            description,
            frontmatterTags: fm.tags ?? [],
          }),
        });
      }
    }
    this.commands = Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /**
   * The <select> option value reflecting a skill's stored agent choice, used to
   * preselect the dropdown. Falls back to Default when the stored value is not a
   * currently-selectable option (unknown built-in, or a custom path no longer in
   * the discovered set) so the UI never shows an orphaned selection — launch
   * already fails closed independently via `resolveAgentLaunch`.
   */
  agentOptionValue(id: string): string {
    const stored = this.settings.skillAgent[id];
    if (!stored || typeof stored !== "object") return encodeAgentChoice(null);
    if (stored.kind === "builtin") {
      return isAllowedBuiltinAgent(stored.name)
        ? encodeAgentChoice(stored)
        : encodeAgentChoice(null);
    }
    if (stored.kind === "custom") {
      return this.customAgents.some((a) => a.path === stored.path)
        ? encodeAgentChoice(stored)
        : encodeAgentChoice(null);
    }
    return encodeAgentChoice(null);
  }

  /**
   * Persist a skill's agent choice from the dropdown's encoded option value. The
   * value is decoded then VALIDATED before storing: a built-in name must be in
   * the hardcoded allowlist; a custom path must pass `isValidCustomAgentPath`
   * against the scan dir AND be one of the currently-discovered agents. Anything
   * else (incl. Default) deletes the key so data.json stays clean. Launch
   * re-validates independently, so storage is defense-in-depth, not the gate.
   */
  async setSkillAgent(id: string, encoded: string): Promise<void> {
    const choice = decodeAgentChoice(encoded);
    let store: SkillAgent | null = null;
    if (choice.kind === "builtin" && isAllowedBuiltinAgent(choice.name)) {
      store = { kind: "builtin", name: choice.name };
    } else if (choice.kind === "custom") {
      const dir = this.agentConfigDir();
      const known = this.customAgents.some((a) => a.path === choice.path);
      if (dir && known && isValidCustomAgentPath(choice.path, dir)) {
        store = { kind: "custom", path: choice.path };
      }
    }
    if (store) {
      this.settings.skillAgent[id] = store;
    } else {
      delete this.settings.skillAgent[id];
    }
    await this.saveSettings();
  }

  /**
   * The <select> option value reflecting a skill's stored HARNESS choice (M15),
   * for preselecting the dropdown. Resolves to a built-in omnigent harness name,
   * a `custom:<id>` value (only if that custom harness still exists), or the
   * Default sentinel — so the UI never shows an orphaned selection. Launch
   * re-validates via `resolveSkillHarness`.
   */
  harnessOptionValue(id: string): string {
    const choice = parseHarnessValue(this.settings.skillHarness[id]);
    if (choice.kind === "omnigent") return choice.name;
    if (
      choice.kind === "custom" &&
      this.settings.harnesses.some((h) => h.id === choice.id)
    ) {
      return encodeCustomHarnessChoice(choice.id);
    }
    return HARNESS_DEFAULT_VALUE;
  }

  /**
   * Human-readable label for a skill's effective AGENT (M16) — shown on the row
   * so the assignment is visible without opening Configuration. Mirrors
   * `agentOptionValue`'s fail-closed fallback: a stale/unknown choice reads as
   * "Default". Returns "Default", a built-in name (polly/debby), or a custom
   * agent's display name.
   */
  agentLabelFor(id: string): string {
    const choice = decodeAgentChoice(this.agentOptionValue(id));
    if (choice.kind === "builtin") return choice.name;
    if (choice.kind === "custom") {
      const a = this.customAgents.find((x) => x.path === choice.path);
      return a ? a.name : "Default";
    }
    return "Default";
  }

  /**
   * Human-readable label for a skill's effective HARNESS (M16) — shown on the
   * row. "Default", an omnigent harness name, or a custom harness's label. Uses
   * `harnessOptionValue` so a dropped custom harness degrades to "Default".
   */
  harnessLabelFor(id: string): string {
    const v = this.harnessOptionValue(id);
    if (v === HARNESS_DEFAULT_VALUE) return "Default";
    const choice = parseHarnessValue(v);
    if (choice.kind === "custom") {
      const h = this.settings.harnesses.find((x) => x.id === choice.id);
      return h ? h.label : "Default";
    }
    // An omnigent harness — label it as such to distinguish from custom ones.
    return `omnigent - ${v}`;
  }

  /**
   * True iff the skill's effective harness is a user-defined CUSTOM harness
   * (non-omnigent). When so, omnigent AGENTS (polly/debby/the YAML bundle
   * format) do NOT apply — a custom harness spawns its own binary and never
   * routes through omnigent — so the Agent selector is filtered to Default and
   * the row's Agent pill is hidden. (Default + omnigent `--harness` both still
   * run via omnigent, so agents remain available for those.)
   */
  skillUsesCustomHarness(id: string): boolean {
    return parseHarnessValue(this.harnessOptionValue(id)).kind === "custom";
  }

  /**
   * Persist a skill's HARNESS choice from the dropdown's option value (M15). A
   * built-in omnigent harness name or a `custom:<id>` that still exists is
   * stored; Default / anything unrecognized deletes the key so data.json stays
   * clean. Launch re-validates independently (`resolveSkillHarness`), so storage
   * is defense-in-depth.
   */
  async setSkillHarness(id: string, value: string): Promise<void> {
    const choice = parseHarnessValue(value);
    if (choice.kind === "omnigent") {
      this.settings.skillHarness[id] = choice.name;
    } else if (
      choice.kind === "custom" &&
      this.settings.harnesses.some((h) => h.id === choice.id)
    ) {
      this.settings.skillHarness[id] = encodeCustomHarnessChoice(choice.id);
    } else {
      delete this.settings.skillHarness[id];
    }
    await this.saveSettings();
  }

  // --- Custom harnesses (M15.3) ------------------------------------------
  /** The user-defined custom harnesses (for the Harnesses tab + dropdown). */
  getCustomHarnesses(): CustomHarness[] {
    return this.settings.harnesses;
  }

  /**
   * Add a custom harness from the Settings form. `label` names it; `commandLine`
   * is the full single-line command (binary + args), e.g.
   * `/usr/local/bin/isaac -p {prompt}`. The line is whitespace-split into an argv
   * array (`parseHarnessCommandLine` — NOT a shell tokenizer) and validated
   * fail-closed (`isValidCustomHarnessCommand`: absolute binary + a `{prompt}`
   * token). Returns an error string on rejection (shown as a Notice by the
   * caller), or null on success. A stable id is generated.
   */
  async addCustomHarness(
    label: string,
    commandLine: string,
  ): Promise<string | null> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return "Harness needs a name.";
    const command = parseHarnessCommandLine(commandLine);
    if (!isValidCustomHarnessCommand(command)) {
      return (
        "Invalid command: the first token (binary) must be an ABSOLUTE path and " +
        "the command must include the {prompt} placeholder. " +
        "Example: /usr/local/bin/isaac -p {prompt}"
      );
    }
    const id = this.generateHarnessId(trimmedLabel);
    this.settings.harnesses.push({ id, label: trimmedLabel, command });
    await this.saveSettings();
    this.refreshViews();
    return null;
  }

  /** Remove a custom harness by id, and clear any skill selections pointing at it. */
  /**
   * Set (or clear, when blank) a custom harness's Resume command (M20). Parsed
   * like the launch command but WITHOUT a `{prompt}` requirement (resume
   * continues an existing session); the binary must still be an absolute path.
   * Returns an error string on invalid input, else null.
   */
  async setCustomHarnessResume(
    id: string,
    commandLine: string,
  ): Promise<string | null> {
    const h = this.settings.harnesses.find((x) => x.id === id);
    if (!h) return "Harness not found.";
    const line = commandLine.trim();
    if (!line) {
      delete h.resumeCommand;
      await this.saveSettings();
      return null;
    }
    const argv = parseHarnessCommandLine(line);
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((t) => typeof t === "string" && t.length > 0) ||
      !nodePath.isAbsolute(argv[0])
    ) {
      return "Invalid resume command: the first token (binary) must be an ABSOLUTE path. Example: /usr/local/bin/isaac resume";
    }
    h.resumeCommand = argv;
    await this.saveSettings();
    return null;
  }

  async removeCustomHarness(id: string): Promise<void> {
    this.settings.harnesses = this.settings.harnesses.filter((h) => h.id !== id);
    // Drop any per-skill selection that referenced this now-deleted harness.
    const ref = encodeCustomHarnessChoice(id);
    for (const [skillId, value] of Object.entries(this.settings.skillHarness)) {
      if (value === ref) delete this.settings.skillHarness[skillId];
    }
    await this.saveSettings();
    this.refreshViews();
  }

  /** A stable, collision-free id derived from the label. */
  private generateHarnessId(label: string): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "harness";
    let id = base;
    let n = 2;
    const taken = new Set(this.settings.harnesses.map((h) => h.id));
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  // --- Bash scripts (Scripts tab) ----------------------------------------
  /** The user-defined bash scripts (for the Scripts tab). */
  getBashScripts(): BashScript[] {
    return this.settings.bashScripts;
  }

  /** A stable, collision-free bash-script id derived from the label. */
  private generateBashScriptId(label: string): string {
    const base =
      label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32) || "script";
    let id = base;
    let n = 2;
    const taken = new Set(this.settings.bashScripts.map((s) => s.id));
    while (taken.has(id)) id = `${base}-${n++}`;
    return id;
  }

  /**
   * Add a bash script from the Scripts-tab form. `label` names it; `body` is the
   * script source (multi-line ok). Returns an error string on rejection, else
   * null. A stable id is generated.
   */
  async addBashScript(
    label: string,
    body: string,
    launchMode: LaunchMode,
    description?: string,
  ): Promise<string | null> {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return "Script needs a name.";
    if (!body.trim()) return "Script body is empty.";
    const script: BashScript = {
      id: this.generateBashScriptId(trimmedLabel),
      label: trimmedLabel,
      body,
      launchMode: launchMode === "terminal" ? "terminal" : "headless",
    };
    const desc = description?.trim();
    if (desc) script.description = desc;
    this.settings.bashScripts.push(script);
    await this.saveSettings();
    this.refreshViews();
    return null;
  }

  /** Update an existing bash script in place. Returns an error string, else null. */
  async updateBashScript(
    id: string,
    label: string,
    body: string,
    launchMode: LaunchMode,
    description?: string,
  ): Promise<string | null> {
    const script = this.settings.bashScripts.find((s) => s.id === id);
    if (!script) return "Script not found.";
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return "Script needs a name.";
    if (!body.trim()) return "Script body is empty.";
    script.label = trimmedLabel;
    script.body = body;
    script.launchMode = launchMode === "terminal" ? "terminal" : "headless";
    const desc = description?.trim();
    if (desc) script.description = desc;
    else delete script.description;
    await this.saveSettings();
    this.refreshViews();
    return null;
  }

  /** Remove a bash script by id. */
  async removeBashScript(id: string): Promise<void> {
    this.settings.bashScripts = this.settings.bashScripts.filter((s) => s.id !== id);
    await this.saveSettings();
    this.refreshViews();
  }

  /**
   * Run a bash script by id, per its own launch mode:
   *   - terminal → open the user's default terminal running the body (visible).
   *   - headless → spawn `bash -c <body>` (or `cmd /c` on Windows) detached via
   *     the shared hardened spawn surface, Notices only.
   * The body is user-authored and runs only on this explicit click (same trust
   * model as custom harnesses). cwd = vault. Desktop-gated.
   */
  runBashScript(id: string): void {
    if (!this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: running scripts requires the desktop app.");
      return;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill and Harness Manager: could not resolve the vault path; not running.");
      return;
    }
    const script = this.settings.bashScripts.find((s) => s.id === id);
    if (!script) return;

    if (script.launchMode === "terminal") {
      this.runRawInTerminal(script.body, cwd, `script-${script.id}`);
      new Notice(`Running "${script.label}" in your terminal…`);
      return;
    }
    // Headless: bash -c <body> (cmd /c on Windows). The body is a single inert
    // argv element (shell:false), so it is never re-tokenized by a shell WE spawn
    // — `bash -c` interprets it, which is the intended behavior for a script.
    const argv =
      process.platform === "win32"
        ? ["cmd.exe", "/c", script.body]
        : ["/bin/bash", "-c", script.body];
    this.spawnOmnigent(
      argv,
      cwd,
      `Running "${script.label}" in the background — check for output via Notices.`,
      script.label,
    );
  }

  // --- omnigent-configured harness discovery (M15.3) ---------------------
  /** Harnesses omnigent has configured (from `omnigent config list`). */
  getConfiguredHarnesses(): ConfiguredHarness[] {
    return this.configuredHarnesses;
  }

  /** True once a discovery attempt has completed (to distinguish "empty" from "not yet"). */
  hasDiscoveredHarnesses(): boolean {
    return this.harnessesDiscovered;
  }

  /**
   * The omnigent `--harness` values offered in the per-skill dropdown. Prefers
   * the discovered, CONFIGURED harnesses (lowercased, intersected with the
   * hardcoded allowlist for safety/correctness); before discovery completes (or
   * if it found none), falls back to the full allowlist so the dropdown is never
   * empty. Deduped, order-preserving.
   */
  getOmnigentHarnessOptions(): string[] {
    const discovered = this.configuredHarnesses
      .filter((h) => h.configured)
      .map((h) => h.name.toLowerCase())
      .filter((n) => isAllowedHarness(n));
    const source = discovered.length > 0 ? discovered : [...OMNIGENT_HARNESSES];
    return Array.from(new Set(source));
  }

  /** Re-run harness discovery and refresh open views (the Refresh path). */
  async refreshConfiguredHarnesses(): Promise<void> {
    await this.discoverConfiguredHarnesses();
    this.refreshViews();
  }

  /**
   * Discover the harnesses omnigent has configured by running
   * `omnigent config list` and parsing its "Credentials (by harness)" section.
   * Best-effort + fail-quiet: desktop-gated, the omnigent binary resolved
   * silently (no Notice), a bounded stdout capture with a hard timeout, and any
   * failure leaves the cache empty (the dropdown then falls back to the full
   * allowlist). This is a READ-ONLY omnigent query (config list), not a launch —
   * distinct from the hardened launch spawn, and it never passes user input.
   */
  private async discoverConfiguredHarnesses(): Promise<void> {
    const finish = (list: ConfiguredHarness[]) => {
      this.configuredHarnesses = list;
      this.harnessesDiscovered = true;
      this.refreshViews();
    };
    if (!this.detector.canScanExternal()) return finish([]);
    const resolution = resolveOmnigentBinary({
      override: this.settings.omnigentBinaryPath,
      homedir: os.homedir(),
      exists: (p) => fs.existsSync(p),
    });
    if (resolution.status !== "ok") return finish([]);

    const env = this.launchEnv();
    let child;
    try {
      // Fixed args only; no user input. stdout piped for parsing; stderr/stdin ignored.
      child = spawn(resolution.path, ["config", "list"], {
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err) {
      console.error("[skill-layer] harness discovery spawn threw:", err);
      return finish([]);
    }
    let stdout = "";
    let done = false;
    const settle = (list: ConfiguredHarness[]) => {
      if (done) return;
      done = true;
      finish(list);
    };
    // Hard timeout so a hung `omnigent` never leaves discovery pending.
    const timer = window.setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      settle([]);
    }, 8000);
    child.stdout?.on("data", (chunk: Buffer) => {
      // Bound the captured output defensively.
      if (stdout.length < 64_000) stdout += chunk.toString();
    });
    child.on("error", (err) => {
      console.error("[skill-layer] harness discovery error:", err);
      window.clearTimeout(timer);
      settle([]);
    });
    child.on("close", (code) => {
      window.clearTimeout(timer);
      settle(code === 0 ? parseConfiguredHarnesses(stdout) : []);
    });
    child.unref?.();
  }

  /**
   * Persist the "show hidden folders" toggle and apply it live (M15). Enabling
   * patches the vault adapter to reveal dot-folders; disabling reverts it. Both
   * paths are idempotent and no-op on non-desktop / non-FileSystemAdapter.
   */
  async setShowHiddenFolders(value: boolean): Promise<void> {
    this.settings.showHiddenFolders = value;
    await this.saveSettings();
    if (value) {
      await this.hiddenFiles.enable();
    } else {
      await this.hiddenFiles.disable();
    }
  }

  /** True on desktop with a real FileSystemAdapter (hidden-file reveal works). */
  canRevealHiddenFolders(): boolean {
    return this.hiddenFiles.canPatch();
  }

  /**
   * Populate the file-explorer right-click menu (file-menu event). Desktop-only
   * (consistent with M1 launch — no spawn capability on mobile). For each
   * right-click-enabled skill, add an item that launches it one-shot with the
   * clicked file/folder's ABSOLUTE path as context. The absolute path is
   * path.join(vaultBasePath, file.path), which works identically for files and
   * folders (both carry a vault-relative `path`).
   */
  private addFileMenuItems(menu: Menu, file: TAbstractFile): void {
    // Same desktop + filesystem gate as launchSkill: if we can't spawn, don't
    // advertise a launch action.
    if (!this.detector.canScanExternal()) return;
    const base = this.detector.vaultBasePath();
    if (!base) return;
    // file.path is vault-relative for both TFile and TFolder; join → absolute.
    const contextAbsPath = nodePath.join(base, file.path);

    const items = buildRightClickMenuItems(
      this.skills,
      (id) => this.isRightClickEnabled(id),
      contextAbsPath,
    );
    for (const it of items) {
      menu.addItem((item) => {
        item
          .setTitle(it.title)
          .setIcon("brain-circuit")
          .onClick(() => {
            const skill = this.getSkillById(it.skillId);
            if (skill) void this.launchSkill(skill, it.contextPath);
          });
      });
    }
  }

  /** True if `id` renders to an <svg> glyph via `setIcon` (naming-scheme agnostic). */
  private iconResolves(id: string): boolean {
    if (!id) return false;
    const el = activeDocument.createElement("div");
    setIcon(el, id);
    // Confirm an actual <svg> was inserted (not merely some child node), so an
    // unknown id that produces a non-SVG node can't false-positive.
    const ok = elementHasSvg(el);
    el.remove();
    return ok;
  }

  /**
   * Resolve the icon a pinned skill should display: per-skill choice, else the
   * legacy global icon (migration), else the built-in default — first one that
   * actually renders.
   */
  iconFor(id: string): string {
    return resolvePinnedIcon({
      perSkill: this.settings.skillIcons[id],
      legacyGlobal: this.settings.pinnedIcon,
      isValid: (i) => this.iconResolves(i),
    });
  }

  /**
   * Handle a "Pin to ribbon" request: reuse the skill's remembered icon if it
   * still resolves (pin immediately, no picker); otherwise open the picker.
   */
  requestPin(skill: Skill, onDone?: () => void): void {
    const action = pinAction({
      remembered: this.settings.skillIcons[skill.id],
      isValid: (i) => this.iconResolves(i),
    });
    if (action.kind === "pin") {
      void this.setSkillIcon(skill, action.icon, onDone);
    } else {
      this.openIconPicker(skill, onDone);
    }
  }

  /**
   * Open the searchable Lucide icon picker; choosing pins / re-icons the skill.
   * `onDone` (M16) lets a caller — e.g. the per-skill Configuration modal —
   * re-render itself after the choice is applied.
   */
  openIconPicker(skill: Skill, onDone?: () => void): void {
    new IconPickerModal(this.app, this.settings.skillIcons[skill.id], (iconId) => {
      void this.setSkillIcon(skill, iconId, onDone);
    }).open();
  }

  /** The effective default pinned-ribbon icon (user global, else the built-in). */
  defaultPinnedIcon(): string {
    return this.settings.pinnedIcon ?? DEFAULT_PINNED_ICON;
  }

  /**
   * Open the picker for the GLOBAL default pinned-ribbon icon (the fallback used
   * by any pinned skill that hasn't chosen its own icon). `onDone` lets the
   * settings tab re-render its preview after a choice.
   */
  openDefaultIconPicker(onDone?: () => void): void {
    new IconPickerModal(this.app, this.defaultPinnedIcon(), (iconId) => {
      void this.setDefaultPinnedIcon(iconId, onDone);
    }).open();
  }

  /** Set the global default pinned-ribbon icon; refresh fallback-driven ribbons. */
  async setDefaultPinnedIcon(iconId: string, onDone?: () => void): Promise<void> {
    if (!this.iconResolves(iconId)) {
      new Notice(`Skill and Harness Manager: "${iconId}" is not a known icon.`);
      return;
    }
    this.settings.pinnedIcon = iconId;
    await this.saveSettings();
    this.refreshAllPinnedRibbons();
    this.refreshViews();
    onDone?.();
  }

  /** Clear the global default back to the built-in fallback ("play"). */
  async clearDefaultPinnedIcon(onDone?: () => void): Promise<void> {
    delete this.settings.pinnedIcon;
    await this.saveSettings();
    this.refreshAllPinnedRibbons();
    this.refreshViews();
    onDone?.();
  }

  /**
   * Rebuild every persisted pin's ribbon icon. Pins with their own
   * `skillIcons[id]` keep it; pins relying on the fallback pick up the new global
   * default. Used after the global default changes.
   */
  private refreshAllPinnedRibbons(): void {
    for (const el of this.ribbonIcons.values()) el.remove();
    this.ribbonIcons.clear();
    this.recreatePinnedRibbons();
  }

  /**
   * Set a skill's ribbon icon (the pin action). Pins if not already pinned, or
   * updates the existing ribbon icon in place. Persisted in data.json only.
   */
  async setSkillIcon(skill: Skill, iconId: string, onDone?: () => void): Promise<void> {
    if (!this.iconResolves(iconId)) {
      new Notice(`Skill and Harness Manager: "${iconId}" is not a known icon.`);
      return;
    }
    const wasPinned = this.isPinned(skill.id);
    this.settings.skillIcons[skill.id] = iconId;
    if (!wasPinned) this.settings.pinnedSkillIds.push(skill.id);
    await this.saveSettings();

    // Recreate the ribbon icon in place (no duplicates / leaks).
    const existing = this.ribbonIcons.get(skill.id);
    if (existing) {
      existing.remove();
      this.ribbonIcons.delete(skill.id);
    }
    this.addPinnedRibbon(skill);
    this.addPinnedCommand(skill); // no-op if already registered

    new Notice(
      `Skill and Harness Manager: ${wasPinned ? "updated icon for" : "pinned"} "${skill.name}".`,
    );
    this.refreshViews();
    onDone?.();
  }

  async unpinById(id: string): Promise<void> {
    this.settings.pinnedSkillIds = this.settings.pinnedSkillIds.filter(
      (x) => x !== id,
    );
    // Keep settings.skillIcons[id] so the chosen icon is remembered across an
    // unpin/re-pin cycle (re-pin reuses it without re-opening the picker).
    await this.saveSettings();

    const el = this.ribbonIcons.get(id);
    if (el) {
      el.remove();
      this.ribbonIcons.delete(id);
    }
    this.removePinnedCommand(id);
    this.refreshViews();
  }

  /** Refresh any open browser views (e.g. after a pin/icon change). */
  private refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      const view = leaf.view;
      if (view instanceof SkillBrowserView) view.refresh();
    }
  }

  /** Recreate ribbon icons + commands for all persisted pins (on load). */
  private recreatePinnedRibbons(): void {
    for (const id of this.settings.pinnedSkillIds) {
      // Use the live skill if found, else a minimal placeholder by path so the
      // pin still works (and can be unpinned) even if the file moved/vanished.
      const skill = this.getSkillById(id) ?? this.placeholderSkill(id);
      this.addPinnedRibbon(skill);
      this.addPinnedCommand(skill);
    }
  }

  private placeholderSkill(id: string): Skill {
    const base = id.replace(/\\/g, "/").split("/").pop() ?? id;
    return {
      id,
      name: base,
      description: "(skill not currently detected)",
      path: id,
      vaultPath: null,
      sourceRoot: "",
      sourceLabel: "unknown",
      detection: "external",
      tags: [],
    };
  }

  private addPinnedRibbon(skill: Skill): void {
    if (this.ribbonIcons.has(skill.id)) return;
    const el = this.addRibbonIcon(
      this.iconFor(skill.id),
      `Skill and Harness Manager: Run ${skill.name}`,
      () => void this.launchSkill(this.getSkillById(skill.id) ?? skill),
    );
    this.ribbonIcons.set(skill.id, el);
  }

  private addPinnedCommand(skill: Skill): void {
    if (this.pinnedCommandIds.has(skill.id)) return;
    const localId = this.commandLocalId(skill.id);
    this.addCommand({
      id: localId,
      name: `Run ${skill.name}`,
      callback: () => void this.launchSkill(this.getSkillById(skill.id) ?? skill),
    });
    // The full, globally-unique id is `<pluginId>:<localId>` — build it
    // ourselves so removal does not depend on the returned object's id.
    this.pinnedCommandIds.set(skill.id, `${this.manifest.id}:${localId}`);
  }

  private removePinnedCommand(id: string): void {
    const fullId = this.pinnedCommandIds.get(id);
    if (!fullId) return;
    // `removeCommand` is not in the public API; use it when present so the
    // command disappears immediately, otherwise it clears on next reload.
    const commands = (this.app as unknown as { commands?: CommandsApi }).commands;
    commands?.removeCommand?.(fullId);
    this.pinnedCommandIds.delete(id);
    // Free the local id so it can be reused.
    this.usedCommandLocalIds.delete(fullId.slice(this.manifest.id.length + 1));
  }

  /**
   * Deterministic, charset-safe local command id. Combines a djb2 hash of the
   * full path with a sanitized basename, then guarantees uniqueness against a
   * live set so two distinct skills can never collide on the same id.
   */
  private commandLocalId(skillId: string): string {
    let hash = 5381;
    for (let i = 0; i < skillId.length; i++) {
      hash = ((hash << 5) + hash + skillId.charCodeAt(i)) | 0;
    }
    const slug =
      (skillId.replace(/\\/g, "/").split("/").pop() ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "skill";
    const stem = `run-${(hash >>> 0).toString(36)}-${slug}`;
    let candidate = stem;
    let n = 2;
    while (this.usedCommandLocalIds.has(candidate)) {
      candidate = `${stem}-${n++}`;
    }
    this.usedCommandLocalIds.add(candidate);
    return candidate;
  }

  // --- Launch ------------------------------------------------------------
  /**
   * Expand + highlight a vault file in Obsidian's file-explorer (left pane), so
   * the user sees the whole folder a multi-file skill lives in. Uses the
   * file-explorer view's private `revealInFolder` — the SAME method the built-in
   * "Reveal active file in navigation" command drives — behind a narrow guarded
   * cast (no public API exists). Best-effort: if the explorer isn't open or the
   * internal shape changes, it silently no-ops rather than throwing. `revealLeaf`
   * ensures the sidebar is actually showing.
   */
  private revealInFileExplorer(file: TAbstractFile): void {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!leaf) return;
    const view = leaf.view as unknown as {
      revealInFolder?: (f: TAbstractFile) => void;
      fileItems?: Record<
        string,
        {
          file?: TAbstractFile;
          collapsed?: boolean;
          setCollapsed?: (collapsed: boolean) => unknown;
        }
      >;
    };
    try {
      if (typeof view.revealInFolder !== "function") return;
      // Expands ancestors + scrolls to + highlights the target folder.
      view.revealInFolder(file);
      void this.app.workspace.revealLeaf(leaf);

      // Isolate the target: expand ONLY it and collapse its sibling folders, so
      // clicking one skill doesn't leave every neighbour in `.claude/skills` or
      // `.agents/skills` expanded. Only DIRECT siblings are touched — the rest
      // of the user's tree state is left alone. Deferred a tick so the freshly
      // revealed folder's tree item exists in `fileItems` before we toggle it.
      const items = view.fileItems;
      const parent = file.parent;
      if (!items || !(file instanceof TFolder) || !parent) return;
      window.setTimeout(() => {
        for (const child of parent.children) {
          if (!(child instanceof TFolder)) continue;
          const item = items[child.path];
          if (!item || typeof item.setCollapsed !== "function") continue;
          const shouldExpand = child.path === file.path;
          if (item.collapsed !== !shouldExpand) {
            void item.setCollapsed(!shouldExpand);
          }
        }
      }, 0);
    } catch (err) {
      console.error("[skill-layer] revealInFolder failed:", err);
    }
  }

  /**
   * Open a skill's file in Obsidian (vault file) or the OS default (dot/external),
   * THEN surface where it lives so the user sees the sibling files a multi-file
   * skill ships with (scripts/, references/, …):
   *  - vault TFile → expand + highlight it in the file-explorer left pane.
   *  - dot-folder / external file → reveal it in the OS file manager
   *    (`shell.showItemInFolder` opens the containing folder, file selected),
   *    since Obsidian's explorer can't show non-indexed paths.
   */
  async openSkill(skill: Skill): Promise<void> {
    const tfile = this.detector.resolveTFile(skill.vaultPath);
    if (tfile instanceof TFile) {
      await this.openTFileAndRevealFolder(tfile);
      return;
    }
    // A hidden vault skill (dot-folder, e.g. `.claude/skills/…`): it HAS a
    // vault-relative path but isn't indexed because the global hidden reveal is
    // off. Temporarily flip the reveal on, open it IN OBSIDIAN, and remember it
    // so the reveal is turned back off when its tab closes (M16).
    if (
      skill.vaultPath &&
      this.canRevealHiddenFolders() &&
      !this.settings.showHiddenFolders
    ) {
      if (await this.openHiddenSkillTemporarily(skill.vaultPath)) return;
      // Fell through: the file never indexed — fall back to the OS app below.
    }
    // External / fallback — open with the OS default app, then reveal its
    // containing folder in the OS file manager.
    try {
      const result: string = await shell.openPath(skill.path);
      if (result) new Notice(`Could not open file: ${result}`);
      else shell.showItemInFolder(skill.path);
    } catch (err) {
      console.error("[skill-layer] openPath failed:", err);
      new Notice("Could not open skill file.");
    }
  }

  /** Open an in-vault TFile in a leaf and highlight its FOLDER in the explorer. */
  private async openTFileAndRevealFolder(tfile: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(tfile);
    // Highlight the skill's OWN FOLDER (e.g. `omnigent-docs`), not the SKILL.md
    // file — so the user sees which skill's folder is selected and its files.
    this.revealInFileExplorer(tfile.parent ?? tfile);
  }

  /**
   * Open a hidden (dot-folder) skill by temporarily enabling the global hidden
   * reveal, then opening the now-indexed TFile in Obsidian. Sets
   * `tempRevealActive` so `onLayoutChange` re-hides once no hidden file remains
   * open. Returns false (and undoes the reveal if we just enabled it) when the
   * file never becomes indexable — the caller then falls back to the OS app.
   */
  private async openHiddenSkillTemporarily(vaultPath: string): Promise<boolean> {
    // Idempotent; surfaces ALL hidden folders (the ancestor chain must show).
    const wasActive = this.tempRevealActive;
    await this.hiddenFiles.enable();
    const tfile = await this.waitForTFile(vaultPath, 40, 50); // up to ~2s
    if (!(tfile instanceof TFile)) {
      // Undo the reveal only if WE just enabled it (weren't already holding one).
      if (!wasActive && !this.settings.showHiddenFolders) {
        await this.hiddenFiles.disable();
      }
      return false;
    }
    this.tempRevealActive = true;
    await this.openTFileAndRevealFolder(tfile);
    this.refreshViews(); // flip the row's button to "Close file"
    return true;
  }

  /**
   * Open a hidden (dot-folder) AGENT config by temporarily enabling the global
   * hidden reveal, waiting for it to index, then routing to the YAML Viewer when
   * enabled (else a normal leaf) and revealing its folder. Mirrors
   * `openHiddenSkillTemporarily` but ends at the YAML-viewer/leaf open instead of
   * the SKILL.md open. Returns false (undoing a reveal we just enabled) when the
   * file never indexes, so the caller falls back to the OS app.
   */
  private async openHiddenAgentTemporarily(vaultPath: string): Promise<boolean> {
    const wasActive = this.tempRevealActive;
    await this.hiddenFiles.enable();
    const tfile = await this.waitForTFile(vaultPath, 40, 50); // up to ~2s
    if (!(tfile instanceof TFile)) {
      if (!wasActive && !this.settings.showHiddenFolders) {
        await this.hiddenFiles.disable();
      }
      return false;
    }
    this.tempRevealActive = true;
    // Now that it's indexed, prefer the YAML Viewer; else open in a normal leaf.
    if (!(await this.openInYamlViewer(tfile.path))) {
      await this.app.workspace.getLeaf(false).openFile(tfile);
    }
    this.revealInFileExplorer(tfile.parent ?? tfile);
    this.refreshViews();
    return true;
  }

  /** Absolute path → vault-relative forward-slash path, or null when out-of-vault. */
  private absToVaultRelative(absPath: string): string | null {
    const base = this.detector.vaultBasePath();
    if (!base) return null;
    const rel = nodePath.relative(base, absPath);
    if (rel === "" || rel.startsWith("..") || nodePath.isAbsolute(rel)) return null;
    return rel.split(nodePath.sep).join("/");
  }

  /** Poll for a vault-relative path to become an indexed TFile (post-reveal). */
  private async waitForTFile(
    vaultPath: string,
    tries: number,
    delayMs: number,
  ): Promise<TFile | null> {
    for (let i = 0; i < tries; i++) {
      const tf = this.detector.resolveTFile(vaultPath);
      if (tf instanceof TFile) return tf;
      await new Promise<void>((r) => window.setTimeout(r, delayMs));
    }
    return this.detector.resolveTFile(vaultPath);
  }

  /** The skill's OWN folder (parent dir of SKILL.md), vault-relative, or null. */
  private skillFolderPath(skill: Skill): string | null {
    if (!skill.vaultPath) return null;
    const i = skill.vaultPath.lastIndexOf("/");
    return i > 0 ? skill.vaultPath.slice(0, i) : null;
  }

  /** Vault paths of every file currently open in ANY leaf (any view type). */
  private openFilePaths(): Set<string> {
    const paths = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const f = (leaf.view as unknown as { file?: TFile }).file;
      if (f) paths.add(f.path);
    });
    return paths;
  }

  /**
   * True iff ANY file within the skill's folder subtree is open — SKILL.md OR a
   * sibling script/reference — so the user is still "in" the skill. Keying on the
   * folder (not just SKILL.md) lets the user explore the skill's other files
   * without the Close-file toggle flipping or a temporary reveal tearing down.
   */
  isSkillOpen(skill: Skill): boolean {
    const folder = this.skillFolderPath(skill);
    if (!folder) return false;
    const prefix = folder + "/";
    for (const p of this.openFilePaths()) if (p.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Close ALL of a skill's open tabs — every file under its folder, not just
   * SKILL.md (the "Close file" row action means "I'm done with this skill").
   * Detaching fires a layout-change; `onLayoutChange` re-hides a temporary reveal
   * and refreshes the buttons. We also reconcile inline for immediacy.
   */
  async closeSkill(skill: Skill): Promise<void> {
    const folder = this.skillFolderPath(skill);
    if (folder) {
      const prefix = folder + "/";
      const toDetach: WorkspaceLeaf[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        const f = (leaf.view as unknown as { file?: TFile }).file;
        if (f && f.path.startsWith(prefix)) toDetach.push(leaf);
      });
      for (const leaf of toDetach) leaf.detach();
    }
    await this.onLayoutChange();
  }

  /**
   * Set of skill ids that are "open" — i.e. at least one file within the skill's
   * folder subtree is open in some leaf. Drives the Open/Close button state and
   * the temporary-reveal teardown, so exploring sibling files keeps the skill
   * "open" and the reveal alive; only leaving the folder entirely tears it down.
   */
  private openSkillIds(openPaths: Set<string> = this.openFilePaths()): Set<string> {
    const ids = new Set<string>();
    for (const s of this.getSkills()) {
      const folder = this.skillFolderPath(s);
      if (!folder) continue;
      const prefix = folder + "/";
      for (const p of openPaths) {
        if (p.startsWith(prefix)) {
          ids.add(s.id);
          break;
        }
      }
    }
    return ids;
  }

  /**
   * React to workspace layout changes. A TEMPORARY hidden reveal stays on while
   * ANY open file is inside a hidden folder — so the user can move freely between
   * hidden folders — and is turned back off only once NO open file is in a hidden
   * folder (they opened a normal, visible file), and never while the global toggle
   * is on. Re-renders the view (Open/Close labels) only when the open-state
   * signature changes; the signature folds in the hidden-file state so closing
   * the last hidden file (even a non-skill one) still triggers teardown.
   */
  private async onLayoutChange(): Promise<void> {
    const openPaths = this.openFilePaths();
    const open = this.openSkillIds(openPaths);
    const configDir = this.app.vault.configDir;
    const anyHiddenOpen = Array.from(openPaths).some((p) =>
      isRevealableHiddenPath(p, configDir),
    );
    const sig =
      Array.from(open).sort().join("|") + "|h:" + (anyHiddenOpen ? "1" : "0");
    if (sig === this.lastOpenSkillSig) return;
    this.lastOpenSkillSig = sig;

    if (
      this.tempRevealActive &&
      !this.settings.showHiddenFolders &&
      !anyHiddenOpen
    ) {
      await this.hiddenFiles.disable();
      this.tempRevealActive = false;
    }
    this.refreshViews();
  }

  /**
   * Copy the skill's invocation to the clipboard (row action). The copied form is
   * an agent-aware CLI that respects the per-skill "Run with" selection — the
   * stored choice is re-validated fail-closed by the SAME `resolveAgentLaunch`
   * gate `launchSkill` uses, so a stale/invalid custom agent silently degrades to
   * the Default (`omnigent run …`) form. The custom path + prompt are shell-quoted
   * (see `buildSkillCliInvocation`); the bin NAME `omnigent` is used, not a
   * resolved absolute binary, so no binary/desktop capability gate is needed.
   */
  async copyInvocation(skill: Skill): Promise<void> {
    const resolvedH = resolveSkillHarness(
      this.settings.skillHarness[skill.id],
      this.settings.harnesses,
    );
    let invocation: string;
    if (resolvedH.kind === "custom") {
      // A custom harness spawns its own binary; the copyable form is its argv
      // template with {prompt} filled in, each token shell-quoted.
      invocation = buildCustomHarnessCliInvocation({
        command: resolvedH.harness.command,
        prompt: buildLaunchPrompt(
          skill.name,
          this.detector.vaultBasePath() ?? "",
          false,
          undefined,
          undefined,
          skill.kind ?? "skill",
        ),
        agent: this.claudeAgentOptionValue(skill.id),
      });
    } else {
      const agent = resolveAgentLaunch(this.settings.skillAgent[skill.id], {
        scanDir: this.agentConfigDir() ?? "",
        exists: (p) => fs.existsSync(p),
      });
      invocation = buildSkillCliInvocation({
        skillName: skill.name,
        agent,
        harness: resolvedH.kind === "omnigent" ? resolvedH.name : null,
        server: this.settings.omnigentServerUrl,
        kind: skill.kind ?? "skill",
      });
    }
    try {
      await navigator.clipboard.writeText(invocation);
      new Notice(`Copied invocation: ${invocation}`);
    } catch (err) {
      console.error("[skill-layer] clipboard write failed:", err);
      new Notice(`Invocation: ${invocation}`);
    }
  }

  /**
   * Launch a skill as a one-shot, UI-visible omnigent run. This is the plugin's
   * only process-spawn surface: argv array (no shell), shell:false, an
   * omnigent-only allowlist, an absolute auto-resolved binary, and the skill
   * invocation passed as a single inert `-p` element. The run's cwd is the
   * vault base path, so any files it writes land in the real vault. The plugin
   * itself writes nothing.
   *
   * `contextPath` (M3 right-click path) is an absolute file/folder path that, when
   * present, is embedded as INERT TEXT inside the single `-p` prompt — it is
   * never its own argv element and never parsed as a flag (see buildLaunchPrompt
   * + buildOmnigentArgv). The file's CONTENTS are never read or piped. When
   * absent (ribbon / Launch button / command), the M1 prompt is unchanged.
   *
   * `userPrompt` (M16) is optional free text from the Launch modal, appended to
   * the skill directive (`Use the <name> skill. <userPrompt>`) so the session
   * gets extra context to act on. It flows through the same single inert `-p`
   * element (or control-char-stripped custom-harness token) — never tokenized.
   */
  async launchSkill(
    skill: Skill,
    contextPath?: string,
    userPrompt?: string,
  ): Promise<void> {
    // Desktop + filesystem capability gate.
    if (!this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: launching requires the desktop app.");
      return;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill and Harness Manager: could not resolve the vault path; not launching.");
      return;
    }

    // Natural-language prompt (NOT the `/slash` invocation): a leading-slash
    // first token would hit omnigent's REPL slash dispatcher ("Unknown
    // command") instead of selecting the host skill. Reuse the spawn cwd as the
    // vault path in the anchor text. ("Copy invocation" keeps the slash form.)
    const prompt = buildLaunchPrompt(
      skill.name,
      cwd,
      this.settings.appendVaultAnchor,
      contextPath,
      userPrompt,
      skill.kind ?? "skill",
    );

    // Build the skill's harness command (argv + session record + Notices) ONCE,
    // then run it either headless (detached spawn) or in the user's preferred
    // terminal — the SAME command in both modes. Per-item launch-mode override
    // wins over the global default.
    const plan = this.buildLaunchPlan(skill, prompt, cwd, contextPath);
    if (!plan) return; // a Notice was already shown (invalid harness / binary).

    if (this.effectiveLaunchMode(skill.id) === "terminal") {
      this.runPlanInTerminal(plan, skill.name, cwd);
    } else {
      this.spawnOmnigent(plan.argv, cwd, plan.successNotice, plan.label);
    }
    plan.record();
  }

  /**
   * Resolve a skill's harness into a runnable PLAN: the argv to execute, a label,
   * a success Notice, and a session-recording closure. Fails closed exactly like
   * the prior headless path (invalid custom harness / missing binary → a Notice
   * and null). Shared by headless AND terminal launch, so both run the identical
   * command; only how it is spawned differs.
   */
  private buildLaunchPlan(
    skill: Skill,
    prompt: string,
    cwd: string,
    contextPath?: string,
  ): {
    argv: string[];
    label: string;
    successNotice: string;
    record: () => void;
  } | null {
    // Per-skill HARNESS (M15), resolved fail-closed. A CUSTOM harness runs its own
    // (validated, absolute) binary instead of omnigent and DEFINES the whole
    // invocation, so the omnigent agent does not apply in that branch.
    const resolvedH = resolveSkillHarness(
      this.settings.skillHarness[skill.id],
      this.settings.harnesses,
    );
    if (resolvedH.kind === "custom") {
      const harness = resolvedH.harness;
      // A claude subagent (M17) is passed via the command's `{agent}` token.
      const claudeAgent = this.claudeAgentOptionValue(skill.id);
      const argv = buildCustomHarnessArgv({
        command: harness.command,
        prompt,
        agent: claudeAgent,
      });
      if (!argv) {
        new Notice(
          `Skill and Harness Manager: custom harness "${harness.label}" has an invalid command; not launching.`,
        );
        return null;
      }
      const binary = argv[0];
      if (!nodePath.isAbsolute(binary) || !fs.existsSync(binary)) {
        new Notice(
          `Skill and Harness Manager: custom harness "${harness.label}" binary not found: ${binary}`,
        );
        return null;
      }
      return {
        argv,
        label: harness.label,
        successNotice: `Launching "${skill.name}" via "${harness.label}" — it should start shortly.`,
        record: () =>
          this.recordSession(
            sessionToolFromCommand(binary) ?? "custom",
            skill.name,
            cwd,
            binary,
            { harnessId: harness.id, harnessLabel: harness.label },
          ),
      };
    }

    // Default / omnigent-harness path. Resolve the omnigent binary fail-closed.
    const binaryPath = this.resolveBinaryOrNotice();
    if (!binaryPath) return null;

    // Per-skill AGENT, resolved fail-closed (see resolveAgentLaunch).
    const agent = resolveAgentLaunch(this.settings.skillAgent[skill.id], {
      scanDir: this.agentConfigDir() ?? "",
      exists: (p) => fs.existsSync(p),
    });
    const argv = buildOmnigentArgv({
      binaryPath,
      prompt,
      agent,
      harness: resolvedH.kind === "omnigent" ? resolvedH.name : null,
      server: this.settings.omnigentServerUrl,
    });
    return {
      argv,
      label: "omnigent",
      successNotice: `Running "${skill.name}"${
        contextPath ? ` on ${nodePath.basename(contextPath)}` : ""
      } in omnigent — it should appear in the omnigent UI shortly.`,
      record: () =>
        this.recordSession("omnigent", skill.name, cwd, binaryPath, {
          agentArg: agent.mode === "custom" ? agent.path : undefined,
          harness: resolvedH.kind === "omnigent" ? resolvedH.name : undefined,
          server: this.settings.omnigentServerUrl,
        }),
    };
  }

  /**
   * Resolve the omnigent binary, failing closed; Notices + returns null on a
   * set-but-invalid override or a not-found binary. Shared by every spawn caller
   * (skill launch + custom-agent launch). Allowlist = an absolute path named
   * exactly "omnigent" (override) or the trusted default candidates.
   */
  private resolveBinaryOrNotice(): string | null {
    const resolution = resolveOmnigentBinary({
      override: this.settings.omnigentBinaryPath,
      homedir: os.homedir(),
      exists: (p) => fs.existsSync(p),
    });
    if (resolution.status === "invalid-override") {
      new Notice(
        'Skill and Harness Manager: invalid omnigent binary path (must be an absolute path ' +
          'to a binary named "omnigent"). Launch aborted.',
      );
      return null;
    }
    if (resolution.status === "not-found") {
      new Notice(
        "Skill and Harness Manager: omnigent binary not found. Set its path in Settings → Skill and Harness Manager.",
      );
      return null;
    }
    return resolution.path;
  }

  /**
   * The plugin's ONLY process-spawn surface, shared by skill launch (launchSkill),
   * custom-agent launch (launchCustomAgent), and custom-harness launch
   * (launchCustomHarness). `argv[0]` is the (already-validated) binary — the
   * absolute omnigent binary, or an absolute custom-harness binary that
   * `launchCustomHarness` proved exists; the rest are inert array args.
   * shell:false; stdio ignores stdin/stdout at the OS level and pipes a bounded
   * stderr tail. `cwd` is the vault base path so any files the run writes land in
   * the real vault. `successNotice` is shown once spawn succeeds. `label` names
   * the process in error Notices (defaults to "omnigent").
   */
  /**
   * Env for a launched child: process.env with PATH widened by the platform's
   * common install dirs (GUI apps inherit a thin launchd PATH on macOS). Never
   * mutates process.env.
   */
  private launchEnv(): NodeJS.ProcessEnv {
    const home = os.homedir();
    const extras =
      process.platform === "win32"
        ? [nodePath.join(home, ".local", "bin")]
        : ["/usr/local/bin", `${home}/.local/bin`, "/opt/homebrew/bin"];
    return { ...process.env, PATH: augmentPath(process.env.PATH, extras) };
  }

  private spawnOmnigent(
    argv: string[],
    cwd: string,
    successNotice: string,
    label = "omnigent",
  ): void {
    const env = this.launchEnv();

    let child;
    try {
      // argv[0] is the binary; the rest are inert array args. shell:false
      // (never true — the prompt is untrusted) so args are never shell-parsed.
      // stdio: ignore stdin+stdout at the OS level (no unconsumed pipe); keep
      // stderr piped for bounded error-surfacing.
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      console.error("[skill-layer] spawn threw:", err);
      new Notice(`Skill and Harness Manager: could not launch ${label} (${String(err)}).`);
      return;
    }

    // Capture a short stderr tail for error-surfacing; don't hang on the run.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-600);
    });
    child.on("error", (err) => {
      console.error("[skill-layer] spawn error:", err);
      new Notice(`Skill and Harness Manager: failed to launch ${label} — ${err.message}`);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
        new Notice(
          `Skill and Harness Manager: ${label} exited ${code}${tail ? ` — ${tail}` : ""}`,
        );
      }
    });
    child.unref?.();

    // Spawn succeeded; the run's real success/failure is async (an 'error' or
    // non-zero 'exit' will Notice above), so don't assert success here.
    new Notice(successNotice);
  }

  // --- Sessions (Sessions tab, M20) --------------------------------------

  /**
   * Record a launched session IMMEDIATELY (instant feedback — no capture race).
   * The launch is headless/detached and, for remote-server runs, the conversation
   * lives server-side with no reliable local artifact to poll, so we don't try to
   * pin a conversation id; reconnect uses each tool's "continue latest" (see
   * `buildResumeArgv`). Deduped-ish by tool+time. Never throws.
   */
  private recordSession(
    tool: SessionTool,
    skillName: string,
    cwd: string,
    binaryPath: string,
    extra: {
      agentArg?: string;
      harness?: string;
      server?: string;
      harnessId?: string;
      harnessLabel?: string;
    } = {},
  ): void {
    try {
      const startedAt = Date.now();
      const rec: LaunchedSession = {
        key: `${tool}:${startedAt}:${Math.random().toString(36).slice(2, 8)}`,
        tool,
        skillName,
        binaryPath,
        cwd,
        startedAt,
      };
      if (extra.agentArg) rec.agentArg = extra.agentArg;
      if (extra.harness) rec.harness = extra.harness;
      if (extra.server && extra.server.trim()) rec.server = extra.server.trim();
      if (extra.harnessId) rec.harnessId = extra.harnessId;
      if (extra.harnessLabel) rec.harnessLabel = extra.harnessLabel;
      this.settings.sessions.push(rec);
      void this.saveSettings();
      this.refreshViews();
    } catch (e) {
      console.error("[skill-layer] recordSession failed:", e);
    }
  }

  /**
   * Prune sessions older than 12h, persisting if anything changed. Returns the
   * survivors, newest-first. Called by the Sessions tab on render so the list is
   * always live. (Resumability can't be verified without a captured conversation
   * id — a future iteration; for now age is the sole prune criterion.)
   */
  livePrunedSessions(): LaunchedSession[] {
    const now = Date.now();
    const kept = this.settings.sessions.filter(
      (s) => now - s.startedAt < SESSION_MAX_AGE_MS,
    );
    if (kept.length !== this.settings.sessions.length) {
      this.settings.sessions = kept;
      void this.saveSettings();
    }
    return [...kept].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Remove one tracked session (the Sessions-tab "Forget" action). */
  async forgetSession(key: string): Promise<void> {
    this.settings.sessions = this.settings.sessions.filter((s) => s.key !== key);
    await this.saveSettings();
    this.refreshViews();
  }

  /**
   * Reconnect to a session: write its resume command to a temp executable
   * `.command` script and `open` it, which launches the user's DEFAULT terminal
   * and runs `omnigent/claude/codex resume …` in the vault cwd. Never throws.
   */
  openSessionTerminal(s: LaunchedSession): void {
    try {
      // Resume argv precedence: (1) a Resume command the user set on the custom
      // harness; (2) the built-in default / best-effort guess (buildResumeArgv).
      const harness = s.harnessId
        ? this.settings.harnesses.find((h) => h.id === s.harnessId)
        : undefined;
      const userResume = harness?.resumeCommand;
      const argv =
        userResume && userResume.length > 0 && nodePath.isAbsolute(userResume[0])
          ? userResume
          : buildResumeArgv(s);

      // Failure hint shown in the terminal if the resume command exits non-zero.
      const label = s.harnessLabel ?? s.tool;
      let hint: string;
      if (userResume && userResume.length > 0) {
        hint = `Skill and Harness Manager: resume may have failed. Check the Resume command for the "${label}" harness (Settings -> Skill and Harness Manager -> Custom harnesses).`;
      } else if (s.tool === "custom") {
        hint = `Skill and Harness Manager: could not auto-resume this "${label}" session. Set a Resume command for the harness (Settings -> Skill and Harness Manager -> Custom harnesses).`;
      } else {
        hint = `Skill and Harness Manager: could not resume — the session may have ended or is no longer resumable.`;
      }

      const { ext, content } = buildTerminalScript(argv, s.cwd, hint, process.platform);
      this.openTerminalScript(content, ext, `resume-${s.tool}`);
      new Notice(`Connecting to "${s.skillName}" (${label}) in your terminal…`);
    } catch (e) {
      console.error("[skill-layer] openSessionTerminal failed:", e);
      new Notice(`Skill and Harness Manager: could not open a terminal for this session.`);
    }
  }

  /**
   * Run a launch PLAN (skill's harness argv) VISIBLY in the user's PREFERRED
   * terminal. Writes a `cd <cwd> && <argv>` script (POSIX-quoted by
   * `buildTerminalScript`) and opens it in the chosen emulator. Shows a tmux
   * attach hint when the preferred terminal is tmux (detached). Never throws.
   */
  private runPlanInTerminal(
    plan: { argv: string[]; label: string },
    skillName: string,
    cwd: string,
  ): void {
    const term = this.resolvePreferredTerminal();
    const hint = `Skill and Harness Manager: "${plan.label}" exited non-zero — check it is installed and configured.`;
    // Terminal mode is for an INTERACTIVE session: strip the harness's headless
    // print flag (`-p`) so the CLI opens a session seeded with the prompt rather
    // than answering-and-exiting, and keep the window open afterward so the user
    // can continue. (tmux is detached, so keep-open doesn't apply there.)
    const argv = toInteractiveArgv(plan.argv);
    const keepOpen = !term.def.detached;
    try {
      const { ext, content } = buildTerminalScript(argv, cwd, hint, process.platform, keepOpen);
      this.openTerminalScript(content, ext, `run-${plan.label}`, term);
      if (term.def.detached) {
        new Notice(
          `Started "${skillName}" in ${term.def.label} — attach with: tmux attach -t ${TMUX_SESSION}`,
        );
      } else {
        new Notice(`Opening "${skillName}" in ${term.def.label}…`);
      }
    } catch (e) {
      console.error("[skill-layer] runPlanInTerminal failed:", e);
      new Notice("Skill and Harness Manager: could not open a terminal.");
    }
  }

  /**
   * Run a RAW user-authored script `body` in the PREFERRED terminal (Bash Scripts
   * tab, terminal mode): write `cd <cwd>` + body to a temp executable and open it
   * in the chosen emulator. Never throws (Notices on failure).
   */
  private runRawInTerminal(body: string, cwd: string, tag = "script"): void {
    const term = this.resolvePreferredTerminal();
    try {
      const { ext, content } = buildRawTerminalScript(body, cwd, process.platform);
      this.openTerminalScript(content, ext, tag, term);
      if (term.def.detached) {
        new Notice(`Started script in ${term.def.label} — attach with: tmux attach -t ${TMUX_SESSION}`);
      }
    } catch (e) {
      console.error("[skill-layer] runRawInTerminal failed:", e);
      new Notice("Skill and Harness Manager: could not open a terminal.");
    }
  }

  /**
   * The shared temp-script + terminal-opener surface: write `content` to a temp
   * file with extension `ext`, mark it executable (non-Windows), and open it in a
   * terminal. `terminal` selects the emulator (defaults to the OS default when
   * omitted — used by Sessions Connect); `tag` labels the temp filename.
   */
  private openTerminalScript(
    content: string,
    ext: string,
    tag: string,
    terminal?: DetectedTerminal,
  ): void {
    const plat = process.platform;
    // Sanitize the tag so the temp FILENAME never contains spaces or other shell-
    // unsafe characters (a label like "vibe agent" would otherwise break the
    // `cd`/exec in some terminals, e.g. Ghostty's `-e` command handling).
    const safeTag =
      tag.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
      "run";
    const file = `${os.tmpdir()}/skill-harness-${safeTag}-${Date.now()}${ext}`;
    fs.writeFileSync(file, content, plat === "win32" ? {} : { mode: 0o755 });

    // A specific preferred terminal, else the OS default (auto). buildOpenerCommand
    // handles tmux + macOS GUI emulators + the per-platform default.
    const opener = buildOpenerCommand({
      terminal: terminal ?? { def: { id: "auto", label: "Auto" } },
      scriptPath: file,
      platform: plat,
      linuxTerminalEnv: process.env.TERMINAL,
    });
    const child = spawn(opener.bin, opener.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    });
    child.unref?.();

    // Belt-and-suspenders cleanup: delete the temp launcher a few seconds later,
    // once the terminal has read+started it. The script also self-deletes at run
    // time (`rm -f "$0"`); this covers the case where the terminal never launched
    // so a stale script can't be re-run by session-restore. Never throws.
    window.setTimeout(() => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* already gone (self-deleted) or never created — fine */
      }
    }, 10000);
  }

  // --- Custom agents (Agents tab, M10) -----------------------------------
  /**
   * Re-validate a discovered custom-agent path through the SAME fail-closed gate
   * launches use (`safeCustomAgentRealPath`): the path must be a real, direct
   * child of the scan dir and either a loose `.yaml`/`.yml` file or a bundle
   * directory containing a regular `config.yaml`. Returns the real (symlink-
   * resolved) absolute path, or null (caller Notices + aborts). NEVER throws.
   */
  private validateAgentPath(agentPath: string): string | null {
    return safeCustomAgentRealPath(agentPath, this.agentConfigDir() ?? "", {
      exists: (p) => fs.existsSync(p),
      realpath: (p) => fs.realpathSync(p),
      isFile: (p) => fs.statSync(p).isFile(),
      isDirectory: (p) => fs.statSync(p).isDirectory(),
      isRegularFileNoFollow: (p) => fs.lstatSync(p).isFile(),
    });
  }

  /**
   * Open a discovered custom agent's config in the OS default app. `.omnigent/`
   * is a dot-folder outside the Vault API index, so (like openSkill's non-indexed
   * branch) we open via Electron `shell.openPath` rather than the Vault API. A
   * bundle's launch path is the DIRECTORY, so we open `<dir>/config.yaml`; a loose
   * agent path is the file itself. If it can't be opened, fall back to a Notice
   * showing the absolute path. `agentPath` comes from our own discovery scan.
   */
  async openCustomAgent(agentPath: string): Promise<void> {
    let fileToOpen = agentPath;
    try {
      if (fs.statSync(agentPath).isDirectory()) {
        fileToOpen = nodePath.join(agentPath, BUNDLE_CONFIG_NAME);
      }
    } catch {
      // stat failed — fall through; shell.openPath will Notice with the path.
    }
    // Prefer the YAML Viewer community plugin when it's installed+enabled AND
    // the config resolves to an in-vault TFile. Anything else (viewer absent,
    // non-YAML, dot-folder/external path with no TFile) returns false here so we
    // fall through to the unchanged OS-default-app path below.
    if (await this.openInYamlViewer(fileToOpen)) {
      // Opened in-vault — reveal the agent's FOLDER in the file-explorer so the
      // whole bundle (config + sibling files) is visible and highlighted.
      const tf = this.pathToVaultTFile(fileToOpen);
      if (tf) this.revealInFileExplorer(tf.parent ?? tf);
      return;
    }
    // The config lives in `.omnigent/agent-configs/…`, a hidden dot-folder. When
    // "Show hidden folders" is off it isn't indexed, so the YAML-viewer check
    // above failed — mirror openSkill's hidden branch: temporarily reveal hidden
    // folders, wait for the file to index, THEN open it in Obsidian (YAML viewer
    // if enabled, else a normal leaf). onLayoutChange re-hides once it's closed.
    const vaultRel = this.absToVaultRelative(fileToOpen);
    if (
      vaultRel &&
      this.canRevealHiddenFolders() &&
      !this.settings.showHiddenFolders
    ) {
      if (await this.openHiddenAgentTemporarily(vaultRel)) return;
      // Fell through: never indexed — fall back to the OS app below.
    }
    try {
      const result: string = await shell.openPath(fileToOpen);
      if (result) {
        new Notice(`Could not open agent config (${result}). Path: ${fileToOpen}`);
      } else {
        // Reveal the bundle folder in the OS file manager (agents are often a
        // directory of files), so the user sees everything the agent ships with.
        shell.showItemInFolder(fileToOpen);
      }
    } catch (err) {
      console.error("[skill-layer] openPath (agent) failed:", err);
      new Notice(`Could not open agent config. Path: ${fileToOpen}`);
    }
  }

  /**
   * True iff the "YAML Viewer" community plugin (id `yaml-viewer`) is installed
   * AND enabled. Reads the untyped community-plugins API via a narrow local cast
   * (no global type loosening); the predicate itself lives in the pure module.
   */
  private isYamlViewerEnabled(): boolean {
    const plugins = (this.app as { plugins?: unknown }).plugins;
    return detectYamlViewerEnabled(plugins);
  }

  /**
   * Map an absolute filesystem path to the in-vault `TFile` it names, or null.
   * Returns null when the vault adapter isn't a `FileSystemAdapter`, when the
   * path is outside the vault, or when it doesn't index to a `TFile` (e.g. a
   * non-indexed dot-folder like `.omnigent/...` or an external scan root).
   */
  private pathToVaultTFile(absPath: string): TFile | null {
    const adapter = this.app.vault.adapter;
    const basePath =
      adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
    return resolveVaultTFile<TAbstractFile>(basePath, absPath, {
      relative: (from, to) => nodePath.relative(from, to),
      isAbsolute: (p) => nodePath.isAbsolute(p),
      sep: nodePath.sep,
      getAbstractFileByPath: (vaultPath) =>
        this.app.vault.getAbstractFileByPath(vaultPath),
      isTFile: (f) => f instanceof TFile,
    }) as TFile | null;
  }

  /**
   * Try to open `fileToOpen` in the YAML Viewer. Returns false (so the caller
   * falls back to `shell.openPath`) unless the viewer is enabled, the path is a
   * `.yaml`/`.yml`, AND it resolves to an in-vault `TFile`. A throw from
   * `setViewState` also returns false so we never leave a broken viewer leaf.
   */
  private async openInYamlViewer(fileToOpen: string): Promise<boolean> {
    const tfile = this.pathToVaultTFile(fileToOpen);
    if (
      !(tfile instanceof TFile) ||
      !canOpenInYamlViewer({
        viewerEnabled: this.isYamlViewerEnabled(),
        fileToOpen,
        hasTFile: true,
      })
    ) {
      return false;
    }
    try {
      await this.app.workspace.getLeaf(false).setViewState({
        type: YAML_VIEWER_VIEW_TYPE,
        state: { file: tfile.path },
        active: true,
      });
      return true;
    } catch (err) {
      console.error("[skill-layer] YAML Viewer open failed:", err);
      return false;
    }
  }

  /**
   * Launch a UI-visible omnigent SESSION for a discovered custom agent
   * (`omnigent run <agent-path> -p "<default prompt>"`). The agent path is
   * re-validated through `safeCustomAgentRealPath` (same gate as skill launches);
   * a path that fails validation Notices and does NOT spawn. Reuses the shared
   * hardened spawn surface (allowlisted binary, shell:false, array args, stdio
   * ignore). Since the spawn is non-interactive, a default opening prompt is
   * passed so the session opens and is visible in the omnigent UI.
   */
  async launchCustomAgent(agentPath: string): Promise<void> {
    if (!this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: launching requires the desktop app.");
      return;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill and Harness Manager: could not resolve the vault path; not launching.");
      return;
    }
    const real = this.validateAgentPath(agentPath);
    if (!real) {
      new Notice(
        "Skill and Harness Manager: this agent path failed validation; not launching.",
      );
      return;
    }
    const binaryPath = this.resolveBinaryOrNotice();
    if (!binaryPath) return;

    const argv = buildOmnigentArgv({
      binaryPath,
      prompt: AGENT_SESSION_PROMPT,
      agent: { mode: "custom", path: real },
      server: this.settings.omnigentServerUrl,
    });
    this.spawnOmnigent(
      argv,
      cwd,
      `Launching agent session (${nodePath.basename(real)}) in omnigent — ` +
        "it should appear in the omnigent UI shortly.",
    );
  }

  /**
   * Copy the exact CLI to start a session with a custom agent plus a placeholder
   * prompt: `omnigent run <validated-abs-agent-path> -p "<your prompt here>"`.
   * The path is re-validated through the SAME gate as launch; a path that fails
   * validation Notices and copies nothing.
   */
  async copyCustomAgentInvocation(agentPath: string): Promise<void> {
    const real = this.validateAgentPath(agentPath);
    if (!real) {
      new Notice(
        "Skill and Harness Manager: this agent path failed validation; nothing copied.",
      );
      return;
    }
    const invocation = buildAgentInvocation(real);
    try {
      await navigator.clipboard.writeText(invocation);
      new Notice(`Copied invocation: ${invocation}`);
    } catch (err) {
      console.error("[skill-layer] clipboard write failed:", err);
      new Notice(`Invocation: ${invocation}`);
    }
  }

  // --- Tagging (write side) ----------------------------------------------
  // POSTURE: the plugin is read-only except these paths, which run ONLY on an
  // explicit user add/remove. Frontmatter `tags:` is the SINGLE authoritative
  // place we write — the description and derived folder tags are never written.

  /**
   * Add a user tag to a skill's frontmatter `tags:`.
   * - already in frontmatter → no-op (informative Notice);
   * - exists only as a derived FOLDER tag → no-op (folder tags stay virtual);
   * - exists only in the DESCRIPTION text → allowed: promotes it to the
   *   authoritative, natively-indexed frontmatter list.
   */
  async addTag(skill: Skill, rawTag: string): Promise<void> {
    const tag = sanitizeTag(rawTag);
    if (!tag) {
      new Notice("Skill and Harness Manager: not a valid tag.");
      return;
    }
    const existing = skill.tags.find(
      (t) => t.tag.toLowerCase() === tag.toLowerCase(),
    );
    if (existing) {
      if (existing.origin === "frontmatter") {
        new Notice(`Skill and Harness Manager: "${skill.name}" already has the tag #${existing.tag}.`);
        return;
      }
      if (existing.origin === "folder") {
        new Notice(`Skill and Harness Manager: #${existing.tag} is already auto-applied from the folder.`);
        return;
      }
      // origin === "description": fall through to promote it into frontmatter.
    }
    await this.writeTag(skill, tag, "add");
  }

  /** Remove a frontmatter-origin tag from a skill (the only removable kind). */
  async removeTag(skill: Skill, tag: string): Promise<void> {
    await this.writeTag(skill, tag, "remove");
  }

  private async writeTag(
    skill: Skill,
    tag: string,
    op: "add" | "remove",
  ): Promise<void> {
    try {
      const tfile = this.detector.resolveTFile(skill.vaultPath);
      if (tfile instanceof TFile) {
        await this.writeTagVault(tfile, tag, op);
      } else {
        const ok = await this.writeTagRaw(skill, tag, op);
        if (!ok) return;
      }
      await this.refreshSkillFromDisk(skill);
      new Notice(
        `Skill and Harness Manager: ${op === "add" ? "added" : "removed"} #${tag} ${
          op === "add" ? "to" : "from"
        } "${skill.name}".`,
      );
    } catch (err) {
      console.error(`[skill-layer] tag ${op} failed for ${skill.path}:`, err);
      new Notice(`Skill and Harness Manager: could not ${op} tag (see console).`);
    }
  }

  /** In-vault: mutate frontmatter `tags:` via Obsidian's safe API. */
  private async writeTagVault(
    file: TFile,
    tag: string,
    op: "add" | "remove",
  ): Promise<void> {
    await this.app.fileManager.processFrontMatter(
      file,
      (fm: Record<string, unknown>) => {
        const arr = coerceFrontmatterTags(fm.tags);
        const want = tag.toLowerCase();
        const next =
          op === "add"
            ? arr.some((t) => t.toLowerCase() === want)
              ? arr
              : [...arr, tag]
            : arr.filter((t) => t.toLowerCase() !== want);
        if (next.length) fm.tags = next;
        else delete fm.tags;
      },
    );
  }

  /**
   * External / dot-folder: rewrite frontmatter `tags:` on raw content via the
   * adapter or Node fs. Returns false (and Notices) if the write can't proceed.
   */
  private async writeTagRaw(
    skill: Skill,
    tag: string,
    op: "add" | "remove",
  ): Promise<boolean> {
    const isAdapter = skill.detection === "adapter" && skill.vaultPath !== null;
    const adapter = this.app.vault.adapter;

    // This is a WRITE path — guard the external/Node-fs branch at the write
    // site (don't trust that the scan path implied capability).
    if (!isAdapter && !this.detector.canScanExternal()) {
      new Notice(
        "Skill and Harness Manager: external file writes require the desktop app with filesystem access.",
      );
      return false;
    }

    const content = isAdapter
      ? await adapter.read(skill.vaultPath as string)
      : await fs.promises.readFile(skill.path, "utf8");

    const newContent =
      op === "add"
        ? addTagToContent(content, tag)
        : removeTagFromContent(content, tag);

    if (newContent !== content) {
      if (isAdapter) {
        await adapter.write(skill.vaultPath as string, newContent);
      } else {
        await fs.promises.writeFile(skill.path, newContent, "utf8");
      }
    }
    return true;
  }

  /** Re-read one skill from disk and update its parsed description + tags. */
  private async refreshSkillFromDisk(skill: Skill): Promise<void> {
    let content: string | null = null;
    try {
      const tfile = this.detector.resolveTFile(skill.vaultPath);
      if (tfile instanceof TFile) {
        content = await this.app.vault.read(tfile);
      } else if (skill.detection === "adapter" && skill.vaultPath !== null) {
        content = await this.app.vault.adapter.read(skill.vaultPath);
      } else if (this.app.vault.adapter instanceof FileSystemAdapter) {
        content = await fs.promises.readFile(skill.path, "utf8");
      }
    } catch (err) {
      console.error(`[skill-layer] refresh read failed for ${skill.path}:`, err);
    }
    if (content === null) return;

    const fm = parseFrontmatter(content);
    const description = fm.description ?? skill.description;
    const updated: Skill = {
      ...skill,
      description,
      tags: resolveSkillTags({
        relativePath: this.detector.relativeForTag(skill),
        description,
        frontmatterTags: fm.tags ?? [],
      }),
    };
    const idx = this.skills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) this.skills[idx] = updated;

    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      const view = leaf.view;
      if (view instanceof SkillBrowserView) view.refresh();
    }
  }
}
