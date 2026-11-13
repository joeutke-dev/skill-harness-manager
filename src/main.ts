import { execFile, spawn } from "child_process";
import { shell } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as nodePath from "path";
import {
  Editor,
  FileSystemAdapter,
  MarkdownFileInfo,
  MarkdownView,
  Menu,
  Notice,
  Platform,
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
} from "./terminal";
import { EXAMPLE_SKILL_BODY, EXAMPLE_SKILL_REL_PATH } from "./example";
import { BUNDLED_SKILLS, BundledSkillId } from "./bundledSkills";
import {
  classifyCmuxError,
  cmuxErrorMessage,
  cmuxNewSurfaceArgs,
  cmuxNewWorkspaceArgs,
  cmuxNotifyArgs,
  cmuxRenameTabArgs,
  cmuxRunCommand,
  findCmuxWorkspace,
  parseCmuxAccessMode,
  parseCmuxRefs,
  parseCmuxWorkspaces,
  resolveCmuxWorkspaceName,
} from "./cmux";
import {
  addRun,
  buildPromptTaskPrompt,
  evaluateSchedule,
  isWakeGap,
  normalizeSchedules,
  Schedule,
  ScheduleRun,
  TICK_MS,
  WAKE_SETTLE_MS,
} from "./schedules";
import {
  buildGhosttyAppleScript,
  ghosttySupportsAppleScript,
  readBundleVersion,
} from "./ghostty";
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
  buildEditorMenuItems,
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
  buildExternalOpenPlan,
  commandFolderSegments,
  defaultSkillScanRoots,
  EXTERNAL_BRIDGE_DIR,
  homeSkillRootPaths,
  joinHome,
  skillFolderSegments,
} from "./folders";
import { HiddenFilesController, isRevealableHiddenPath } from "./hiddenFiles";
import {
  coerceFrontmatterTags,
  firstHeading,
  inferSourceLabel,
  normalizeExternalRoot,
  parseFrontmatter,
  resolveSkillTags,
  sanitizeTag,
} from "./parse";
import { SkillLayerSettingTab } from "./settingsTab";
import {
  buildResumeArgv,
  buildTerminalScript,
  LaunchedSession,
  scrubClaudeSessionEnv,
  SESSION_MAX_AGE_MS,
  sessionToolFromCommand,
  SessionTool,
} from "./sessions";
import {
  alertsToFire,
  AlertKind,
  applyStreamLine,
  DerivedStatus,
  deriveSessionStatus,
  emptyStreamState,
  formatDuration,
  NEEDS_INPUT_INSTRUCTION,
  resumeArgvForSession,
  sessionGroup,
  SessionStatus,
  withResumed,
  sessionLogBase,
  splitChunk,
  StreamState,
  withStreamJson,
} from "./sessionMonitor";
import { SessionDetailsModal } from "./sessionDetails";
import { ScheduleModal } from "./scheduleModal";
import { StringDecoder } from "string_decoder";
import { addTagToContent, removeTagFromContent } from "./tagEdit";
import {
  DEFAULT_SETTINGS,
  LaunchMode,
  ScanRoot,
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

/**
 * Obsidian's internal per-vault config accessors (not in the public API). Used
 * to read/write the `nativeMenus` app setting so the plugin can offer a toggle
 * for it — native OS menus can't render the plugin's Lucide menu icons.
 */
interface VaultConfigAccess {
  getConfig(key: string): unknown;
  setConfig(key: string, value: unknown): void;
}

const RESCAN_DEBOUNCE_MS = 600;

/** Body class that switches the plugin UI to Obsidian's selected text font. */
const INHERIT_FONT_CLASS = "skill-layer-inherit-font";

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
  /** Installed Ghostty version (from its Info.plist), "" when not installed/unknown. */
  private ghosttyVersion = "";
  /** Scheduler: time of the previous tick (0 = none yet) — a long gap means the machine slept. */
  private scheduleLastTick = 0;
  /** Scheduler: a wake/startup waiting WAKE_SETTLE_MS before schedules fire. */
  private pendingWake: { wakeAt: number; settleAt: number } | null = null;
  /** Scheduler: re-entrancy guard (a tick can await launches). */
  private scheduleTicking = false;
  /** Serialises cmux opens so concurrent runs can't each create the workspace. */
  private cmuxQueue: Promise<void> = Promise.resolve();

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

  /** Session monitoring: per-session read state, latest status, status-bar item. */
  private sessionRuntime = new Map<string, SessionRuntime>();
  private sessionDerived = new Map<string, DerivedStatus>();
  private sessionStatusEl: HTMLElement | null = null;
  private sessionSig = "";
  private sessionPolling = false;
  /** The live "is running" notice per session (until dismissed or finished). */
  private liveNotices = new Map<string, LiveNotice>();
  /** An open "may be stalled" notice per session (closed if it recovers/finishes). */
  private stallNotices = new Map<string, Notice>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.detector = new Detector(this.app, () => this.settings);
    this.hiddenFiles = new HiddenFilesController(this.app);
    this.applyFontMode();

    this.registerView(
      SKILL_LAYER_VIEW,
      (leaf: WorkspaceLeaf) => new SkillBrowserView(leaf, this),
    );

    this.addRibbonIcon("brain-circuit", "Skill and Harness Manager: toggle skills browser", () => {
      void this.toggleView();
    });

    // Session monitoring: a status-bar summary of running / needs-you sessions,
    // and a 10s check of every tracked headless run (alerts fire from there).
    this.sessionStatusEl = this.addStatusBarItem();
    this.sessionStatusEl.addClass("skill-layer-statusbar", "mod-clickable");
    this.registerDomEvent(this.sessionStatusEl, "click", () => void this.openSessionsTab());
    this.registerInterval(window.setInterval(() => void this.pollSessions(), 5_000));
    // 1s ticker: elapsed times in the live notices + Sessions tab, updated in place.
    this.registerInterval(window.setInterval(() => this.tickSessions(), 1_000));
    this.app.workspace.onLayoutReady(() => void this.pollSessions());
    // Scheduler: tick every 30s. Obsidian starting counts as a wake, so runs
    // missed while it was closed catch up ~1 min after launch.
    this.pendingWake = { wakeAt: Date.now(), settleAt: Date.now() + WAKE_SETTLE_MS };
    this.registerInterval(window.setInterval(() => void this.tickSchedules(), TICK_MS));
    this.addCommand({
      id: "new-schedule",
      name: "New schedule",
      callback: () => this.openScheduleModal(),
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

    // M-EDIT: editor-selection right-click. When text is highlighted in a note,
    // each selection-enabled skill adds a `Run "<name>"` item that
    // launches it one-shot with the current file as context AND the highlighted
    // text as inert prompt context. No item is added when the selection is empty.
    this.registerEvent(
      this.app.workspace.on(
        "editor-menu",
        (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) =>
          this.addEditorMenuItems(menu, editor, view),
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
    document.body.removeClass(INHERIT_FONT_CLASS);
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
    // Best-effort remove the external-skill bridge symlinks (M-EXT). These are
    // just links (the real files live elsewhere), so removal is safe; fire and
    // forget since onunload is synchronous.
    void this.cleanupExternalBridge();
  }

  /**
   * Remove the managed external-skill bridge directory and its symlinks (M-EXT).
   * The entries are symlinks to external folders, so deleting them never touches
   * the real skill files. Best-effort and silent — a missing dir is a no-op.
   * Called on unload so bridge links don't accumulate across sessions.
   */
  private async cleanupExternalBridge(): Promise<void> {
    if (!this.detector.canScanExternal()) return;
    const base = this.detector.vaultBasePath();
    if (!base) return;
    const bridgeDirAbs = nodePath.join(base, EXTERNAL_BRIDGE_DIR);
    try {
      await fs.promises.rm(bridgeDirAbs, { recursive: true, force: true });
    } catch (err) {
      console.error("[skill-layer] external bridge cleanup failed:", err);
    }
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
    // auto-added (external kind, DISABLED) — they cluttered settings and mixed
    // machine-global skills with the user's in-vault skills. Scope the strip to
    // `!enabled` so we only drop those legacy auto-added roots: a user who later
    // ADDS one of these same well-known paths themselves does so ENABLED (see
    // settingsTab `addRoot`), so their choice is preserved across reloads.
    const homeRoots = new Set(homeSkillRootPaths(os.homedir()));
    this.settings.scanRoots = this.settings.scanRoots.filter(
      (r) => !(r.kind === "external" && !r.enabled && homeRoots.has(r.path)),
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
    this.settings.schedules = normalizeSchedules(this.settings.schedules);
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
   * Scan roots the user added (removable) — every root that is NOT a built-in
   * default. Surfaced in the Skills tab so folder management stays in the browser.
   */
  getRemovableScanRoots(): ScanRoot[] {
    const defaultPaths = new Set(defaultSkillScanRoots().map((r) => r.path));
    return this.settings.scanRoots.filter(
      (r) => !(r.kind !== "external" && defaultPaths.has(r.path)),
    );
  }

  /** Remove a user-added scan root (matched by path + kind), then rescan + refresh. */
  async removeScanRoot(target: ScanRoot): Promise<void> {
    this.settings.scanRoots = this.settings.scanRoots.filter(
      (r) => !(r.path === target.path && r.kind === target.kind),
    );
    await this.saveSettings();
    await this.rescan();
    this.refreshViews();
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
   * Remove a tool folder (e.g. `.claude/skills`) from the vault — but ONLY when it
   * is empty, so skills/commands are never deleted out from under the user (a
   * non-empty folder is refused with a user-facing message). Then rescan so its
   * section disappears. Returns an error string, or null on success (incl. an
   * already-absent folder — a no-op). Desktop-gated; `seg` must be a known segment.
   */
  async removeToolFolder(seg: string): Promise<string | null> {
    const base = this.detector.vaultBasePath();
    if (!base || !this.detector.canScanExternal()) return "Requires the desktop app.";
    if (!this.addableFolderSegments("skill").includes(seg) &&
        !this.addableFolderSegments("command").includes(seg)) {
      return "Unknown folder.";
    }
    try {
      // rmdir fails on a non-empty directory, which is exactly the guard we want.
      await fs.promises.rmdir(nodePath.join(base, seg));
      await this.rescan();
      return null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        await this.rescan(); // already gone — reconcile the view
        return null;
      }
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        return `"${seg}" isn't empty — delete the files inside it first.`;
      }
      console.error("[skill-layer] removeToolFolder failed:", err);
      return "Could not remove the folder.";
    }
  }

  /**
   * Add an ABSOLUTE folder path (chosen from the OS folder picker) as an enabled
   * `external` scan root, then rescan. Mirrors the Settings-tab add-root routine
   * (`normalizeExternalRoot` + dedupe by path+kind) so a root added from the
   * Skills/Commands tab "+" behaves identically. Returns an error string, or null
   * on success (incl. an already-present root — a no-op, not an error). Desktop /
   * FileSystemAdapter only. Enabled so it survives reloads (the load-time M18
   * strip only drops DISABLED legacy home roots).
   */
  async addExternalScanRoot(absPath: string): Promise<string | null> {
    if (!this.detector.canScanExternal()) return "Requires the desktop app with filesystem access.";
    const trimmed = (absPath ?? "").trim();
    if (!trimmed || !nodePath.isAbsolute(trimmed)) return "Please choose an absolute folder path.";
    const path = normalizeExternalRoot(trimmed);
    const exists = this.settings.scanRoots.some(
      (r) => r.path === path && r.kind === "external",
    );
    if (!exists) {
      this.settings.scanRoots.push({ path, kind: "external", enabled: true });
      await this.saveSettings();
      await this.rescan();
    }
    return null;
  }

  /**
   * Open a native folder picker and pass the chosen folder's ABSOLUTE path to
   * `onPick` (mirrors the Settings-tab picker): a hidden
   * `<input type="file" webkitdirectory>` whose selected files expose an absolute
   * `.path` in Electron. No Electron dialog/remote dependency; a Notice on
   * failure.
   */
  pickExternalFolder(onPick: (absPath: string) => void): void {
    const input = createEl("input", {
      cls: "skill-layer-hidden-input",
      attr: { type: "file", webkitdirectory: "", multiple: "" },
    });
    input.addEventListener("change", () => {
      const files = input.files;
      const first =
        files && files.length > 0 ? (files[0] as File & { path?: string }).path : undefined;
      if (first) {
        const dir = first.replace(/[/\\][^/\\]*$/, "");
        onPick(dir || first);
      } else {
        new Notice("Skill and Harness Manager: could not read the chosen folder path.");
      }
      input.remove();
    });
    activeDocument.body.appendChild(input);
    input.click();
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
  /** Re-detect installed terminal emulators into the cache (app bundles). */
  private detectTerminals(): void {
    this.detectedTerminals = detectInstalledTerminals({
      homedir: os.homedir(),
      // Standard macOS app locations (system + per-user Applications).
      appDirs: ["/Applications", nodePath.join(os.homedir(), "Applications")],
      exists: (p) => fs.existsSync(p),
    });
    // Ghostty ≥ 1.3 gets the AppleScript tab integration; read its version once.
    this.ghosttyVersion = "";
    const ghostty = this.detectedTerminals.find((t) => t.def.id === "ghostty");
    if (ghostty?.appPath) {
      try {
        const plist = fs.readFileSync(nodePath.join(ghostty.appPath, "Contents", "Info.plist"), "utf8");
        this.ghosttyVersion = readBundleVersion(plist);
      } catch {
        /* binary plist / unreadable — treat as unknown (pre-1.3 behaviour) */
      }
    }
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
        // setCssStyles (not a direct .style assignment) per Obsidian guidelines.
        el.setCssStyles({ width: `${width}px` });
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

  // --- Editor-selection (editor-menu) per-skill toggle (M-EDIT) ----------
  /** True if this skill is exposed in the editor selection right-click menu. */
  isEditorMenuEnabled(id: string): boolean {
    return this.settings.editorMenuSkillIds.includes(id);
  }

  /** Flip a skill's `editorMenuEnabled` membership and persist to data.json. */
  async toggleEditorMenu(skill: Skill): Promise<void> {
    const on = this.isEditorMenuEnabled(skill.id);
    if (on) {
      this.settings.editorMenuSkillIds = this.settings.editorMenuSkillIds.filter(
        (x) => x !== skill.id,
      );
    } else {
      this.settings.editorMenuSkillIds.push(skill.id);
    }
    await this.saveSettings();
    this.refreshViews();
    new Notice(
      `Skill and Harness Manager: ${on ? "removed" : "added"} "${skill.name}" ${
        on ? "from" : "to"
      } the selection menu.`,
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
   * commands, custom agents, Claude subagents (all via `rescan`). This is the
   * single "Refresh" action wired to every tab's refresh control (it subsumes the
   * old Rescan button).
   */
  async refreshAll(): Promise<void> {
    await this.rescan();
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
   * for preselecting the dropdown. Resolves to a `custom:<id>` value (only if
   * that custom harness still exists) or the Default sentinel — so the UI never
   * shows an orphaned selection. A legacy stored omnigent-harness value degrades
   * to Default (omnigent is no longer a selectable option). Launch re-validates
   * via `resolveSkillHarness`.
   */
  harnessOptionValue(id: string): string {
    const choice = parseHarnessValue(this.settings.skillHarness[id]);
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
   * row. "Default" or a custom harness's label. Uses `harnessOptionValue` so a
   * dropped custom harness (or a legacy omnigent value) degrades to "Default".
   */
  harnessLabelFor(id: string): string {
    const v = this.harnessOptionValue(id);
    if (v === HARNESS_DEFAULT_VALUE) return "Default";
    const choice = parseHarnessValue(v);
    if (choice.kind === "custom") {
      const h = this.settings.harnesses.find((x) => x.id === choice.id);
      return h ? h.label : "Default";
    }
    return "Default";
  }

  /**
   * The custom harness a skill will ACTUALLY run through: its explicit `custom:`
   * pick, else the designated default harness ("Default" → the harness chosen in
   * Settings → Harnesses). Null when neither is set — launching then shows a
   * Notice rather than running (omnigent is never used as an implicit default).
   */
  effectiveCustomHarness(id: string): CustomHarness | null {
    const resolved = resolveSkillHarness(
      this.settings.skillHarness[id],
      this.settings.harnesses,
    );
    if (resolved.kind === "custom") return resolved.harness;
    return this.resolveDefaultHarness();
  }

  /**
   * The default custom harness "Default" resolves to: the explicitly-designated
   * one when set and valid, else — with no explicit choice — a LONE harness (so a
   * single configured harness is the default automatically). Null when there are
   * zero, or 2+ with none marked (the user must then pick one in the Config tab → Harnesses).
   */
  resolveDefaultHarness(): CustomHarness | null {
    const harnesses = this.settings.harnesses;
    const id = this.settings.defaultHarnessId;
    if (id) {
      const h = harnesses.find((x) => x.id === id);
      if (h && isValidCustomHarnessCommand(h.command)) return h;
    }
    if (harnesses.length === 1 && isValidCustomHarnessCommand(harnesses[0].command)) {
      return harnesses[0];
    }
    return null;
  }

  /** Persist the designated default harness ("" clears it). */
  async setDefaultHarness(id: string): Promise<void> {
    if (id && this.settings.harnesses.some((h) => h.id === id)) {
      this.settings.defaultHarnessId = id;
    } else {
      delete this.settings.defaultHarnessId;
    }
    await this.saveSettings();
    this.refreshViews();
  }

  /**
   * True iff the skill will run through a CUSTOM harness — an explicit `custom:`
   * pick OR "Default" resolving to a configured default harness. When so, the
   * Agent selector offers Claude subagents (passed via the command's `{agent}`
   * token); otherwise the skill has no runnable harness yet.
   */
  skillUsesCustomHarness(id: string): boolean {
    return this.effectiveCustomHarness(id) !== null;
  }

  /**
   * Persist a skill's HARNESS choice from the dropdown's option value (M15). A
   * `custom:<id>` that still exists is stored; Default / anything unrecognized
   * deletes the key so data.json stays clean. Launch re-validates independently
   * (`resolveSkillHarness`), so storage is defense-in-depth.
   */
  async setSkillHarness(id: string, value: string): Promise<void> {
    const choice = parseHarnessValue(value);
    if (
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
  /** The user-defined custom harnesses (for the Config tab → Harnesses + dropdown). */
  getCustomHarnesses(): CustomHarness[] {
    return this.settings.harnesses;
  }

  /**
   * Add a custom harness from the Settings form. `label` names it; `commandLine`
   * is the full single-line command (binary + args), e.g.
   * `/usr/local/bin/claude -p {prompt}`. The line is whitespace-split into an argv
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
        "Example: /usr/local/bin/claude -p {prompt}"
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
      return "Invalid resume command: the first token (binary) must be an ABSOLUTE path. Example: /usr/local/bin/claude --resume";
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
  /** Toggle "use Obsidian's text font" and apply it live. */
  async setInheritTextFont(value: boolean): Promise<void> {
    this.settings.inheritTextFont = value;
    await this.saveSettings();
    this.applyFontMode();
  }

  /** Sync the body class that scopes the text-font override (styles.css). */
  private applyFontMode(): void {
    document.body.toggleClass(INHERIT_FONT_CLASS, this.settings.inheritTextFont);
  }

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

  /** Obsidian's internal vault config surface, or null if unavailable. */
  private vaultConfig(): VaultConfigAccess | null {
    const v = this.app.vault as unknown as Partial<VaultConfigAccess>;
    return typeof v.getConfig === "function" && typeof v.setConfig === "function"
      ? (v as VaultConfigAccess)
      : null;
  }

  /**
   * True when Obsidian's `nativeMenus` setting is togglable here — desktop only
   * (native menus are a desktop concept) and the internal config API is present.
   */
  canControlNativeMenus(): boolean {
    return Platform.isDesktopApp && this.vaultConfig() !== null;
  }

  /**
   * The EFFECTIVE native-menu state. Obsidian stores `nativeMenus` as
   * true/false/null; an unset (null) value means ON on macOS and OFF elsewhere —
   * mirroring Obsidian's own `updateUseNativeMenu`.
   */
  nativeMenusEnabled(): boolean {
    const raw = this.vaultConfig()?.getConfig("nativeMenus") ?? null;
    if (raw === null || raw === undefined) return Platform.isMacOS;
    return raw === true;
  }

  /**
   * Set Obsidian's `nativeMenus` config (the same call its Appearance toggle
   * makes). Obsidian applies it live, so right-click menus switch immediately —
   * turning it OFF lets the plugin's Lucide icons render in menus, which native
   * OS menus can't do.
   */
  setNativeMenus(value: boolean): void {
    this.vaultConfig()?.setConfig("nativeMenus", value);
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

  /**
   * Populate the editor right-click menu (editor-menu event) for the M-EDIT
   * selection surface. Desktop-only (same spawn gate as launchSkill). Adds an
   * item ONLY when there is a non-empty text selection AND the editor is backed
   * by a real vault file — so the menu never appears for an empty selection or an
   * unsaved buffer. The current file's absolute path (context) and the
   * highlighted text are passed to `launchSkill`; both reach argv only as inert
   * text inside the single `-p` prompt (see buildLaunchPrompt + launchSkill).
   */
  private addEditorMenuItems(
    menu: Menu,
    editor: Editor,
    view: MarkdownView | MarkdownFileInfo,
  ): void {
    if (!this.detector.canScanExternal()) return;
    const base = this.detector.vaultBasePath();
    if (!base) return;
    const selection = editor.getSelection();
    if (!selection || selection.trim().length === 0) return;
    // The editor must be backed by a real vault file to give the skill a target.
    const file = view.file;
    if (!(file instanceof TFile)) return;
    const contextAbsPath = nodePath.join(base, file.path);

    const items = buildEditorMenuItems(
      this.skills,
      (id) => this.isEditorMenuEnabled(id),
      contextAbsPath,
      selection,
    );
    for (const it of items) {
      menu.addItem((item) => {
        item
          .setTitle(it.title)
          .setIcon("brain-circuit")
          .onClick(() => {
            const skill = this.getSkillById(it.skillId);
            if (skill) void this.launchSkill(skill, it.contextPath, undefined, it.selection);
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
    // External (out-of-vault) skill: bridge it INTO the vault via a managed
    // symlink so it can open in an Obsidian tab (M-EXT). Falls through to the
    // OS-app fallback below if the bridge can't be created / indexed.
    if (!skill.vaultPath && (await this.openExternalSkillViaBridge(skill))) return;
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

  /**
   * Open an EXTERNAL (out-of-vault) skill file in Obsidian by bridging it into
   * the vault (M-EXT). Symlinks the skill file's containing FOLDER into the
   * hidden managed dir `<vault>/.shm-external/<hash>-<name>`, which turns the
   * file into an indexable vault path, then reuses the temporary-reveal open
   * path (`openHiddenSkillTemporarily`) to open it in a tab. Returns false (so
   * the caller falls back to the OS app) on any failure: no vault base, no
   * filesystem capability, symlink error, or the file never indexes. Desktop /
   * FileSystemAdapter only. Creating the link is idempotent — an existing,
   * correct symlink is reused; a stale one (wrong target) is replaced.
   */
  private async openExternalSkillViaBridge(skill: Skill): Promise<boolean> {
    if (!this.detector.canScanExternal()) return false;
    const base = this.detector.vaultBasePath();
    if (!base) return false;
    const plan = buildExternalOpenPlan(skill.path, base, nodePath.sep);
    if (!plan) return false;
    try {
      // Ensure the managed bridge dir exists, then (re)create the folder symlink.
      const bridgeDirAbs = nodePath.join(base, EXTERNAL_BRIDGE_DIR);
      await fs.promises.mkdir(bridgeDirAbs, { recursive: true });
      // Confirm the source folder still exists and is a directory.
      const srcStat = await fs.promises.stat(plan.sourceFolderAbs).catch(() => null);
      if (!srcStat || !srcStat.isDirectory()) return false;
      // Reuse an existing correct link; replace a stale/broken one.
      let needLink = true;
      try {
        const cur = await fs.promises.readlink(plan.linkAbs);
        const curAbs = nodePath.isAbsolute(cur)
          ? cur
          : nodePath.resolve(nodePath.dirname(plan.linkAbs), cur);
        if (nodePath.resolve(curAbs) === nodePath.resolve(plan.sourceFolderAbs)) {
          needLink = false;
        } else {
          await fs.promises.rm(plan.linkAbs, { force: true });
        }
      } catch {
        // No existing link (ENOENT) — create it below.
      }
      if (needLink) {
        // `dir` junction type is required on Windows for a directory symlink;
        // harmless on POSIX.
        await fs.promises.symlink(plan.sourceFolderAbs, plan.linkAbs, "dir");
      }
    } catch (err) {
      console.error("[skill-layer] external bridge symlink failed:", err);
      return false;
    }
    // Now the file has an in-vault path through the link: open it via the same
    // temporary-reveal machinery used for hidden dot-folder skills.
    return this.openHiddenSkillTemporarily(plan.fileVaultRel);
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
    // Default resolves to the designated default harness (option B); an explicit
    // custom pick wins. Only when neither is set do we fall back to the omnigent
    // CLI form.
    const customHarness =
      resolvedH.kind === "custom" ? resolvedH.harness : this.resolveDefaultHarness();
    let invocation: string;
    if (customHarness) {
      // A custom harness spawns its own binary; the copyable form is its argv
      // template with {prompt} filled in, each token shell-quoted.
      invocation = buildCustomHarnessCliInvocation({
        command: customHarness.command,
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
   *
   * `selectionText` (M-EDIT) is optional highlighted text from the editor
   * right-click path; when present, `buildLaunchPrompt` appends it (with an
   * edit-this-file default) as inert prose inside the SAME single `-p` element,
   * so it is never tokenized. On the custom-harness path it is control-char-
   * stripped like `userPrompt` (newlines flattened).
   */
  async launchSkill(
    skill: Skill,
    contextPath?: string,
    userPrompt?: string,
    selectionText?: string,
    monitor?: { stallMinutes?: number; longRunMinutes?: number },
    opts?: { scheduleId?: string; mode?: LaunchMode },
  ): Promise<LaunchedSession | null> {
    // Desktop + filesystem capability gate.
    if (!this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: launching requires the desktop app.");
      return null;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill and Harness Manager: could not resolve the vault path; not launching.");
      return null;
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
      selectionText,
    );
    const mode = opts?.mode ?? this.effectiveLaunchMode(skill.id);
    return this.runLaunch(skill, prompt, cwd, mode, monitor, null, opts?.scheduleId);
  }

  /**
   * The shared tail of every skill / prompt launch: add the NEEDS INPUT
   * instruction for headless runs, build the harness plan ONCE, then run it
   * headless (tracked) or in the preferred terminal — the SAME command either
   * way. `harnessOverride` (prompt tasks) replaces the per-skill harness
   * lookup; `scheduleId` tags the session record. Returns the recorded session.
   */
  private runLaunch(
    skill: Skill,
    basePrompt: string,
    cwd: string,
    mode: LaunchMode,
    monitor?: { stallMinutes?: number; longRunMinutes?: number },
    harnessOverride?: CustomHarness | null,
    scheduleId?: string,
  ): LaunchedSession | null {
    let prompt = basePrompt;
    // Headless runs can't stop and wait for an answer, so (Settings toggle) tell
    // the model to end with a `NEEDS INPUT:` line when it truly needs the user.
    if (mode !== "terminal" && this.settings.needsInputInstruction) {
      prompt = `${prompt}\n\n${NEEDS_INPUT_INSTRUCTION}`;
    }
    const plan = this.buildLaunchPlan(skill, prompt, cwd, harnessOverride);
    if (!plan) return null; // a Notice was already shown (invalid harness / binary).
    const tag: Partial<LaunchedSession> = scheduleId ? { scheduleId } : {};

    if (mode === "terminal") {
      this.runPlanInTerminal(plan, skill.name, cwd);
      return plan.record({ mode: "terminal", ...tag });
    }
    return this.launchTrackedHeadless(plan, cwd, monitor, tag);
  }

  /**
   * Run a launch plan headless WITH session tracking: stdout/stderr go to
   * per-session log files (outside the vault, so vault backups never pick them
   * up), Claude-family harnesses get `--output-format stream-json` for live
   * progress + the exact session id, and the record carries the pid so status
   * survives an Obsidian reload. The monitor (`pollSessions`) does the rest.
   */
  private launchTrackedHeadless(
    plan: {
      argv: string[];
      label: string;
      successNotice: string;
      record: (extra: Partial<LaunchedSession>) => LaunchedSession | null;
    },
    cwd: string,
    monitor?: { stallMinutes?: number; longRunMinutes?: number },
    tag: Partial<LaunchedSession> = {},
  ): LaunchedSession | null {
    const { argv, streaming } = withStreamJson(plan.argv);
    const base = sessionLogBase(`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const dir = this.sessionLogDir();
    const logPath = nodePath.join(dir, `${base}.out.jsonl`);
    const errPath = nodePath.join(dir, `${base}.err.log`);

    let rec: LaunchedSession | null = null;
    const pid = this.spawnOmnigent(argv, cwd, "", plan.label, {
      logPath,
      errPath,
      onExit: (code) => {
        if (!rec) return;
        rec.exitCode = code;
        rec.endedAt = Date.now();
        const rt = this.sessionRuntime.get(rec.key);
        if (rt) rt.exited = true;
        void this.pollSessions();
      },
    });
    if (pid === null) return null; // spawn failed; a Notice was already shown.

    const extra: Partial<LaunchedSession> = { mode: "headless", pid, logPath, errPath, ...tag };
    if (streaming) extra.stream = "claude";
    const stall = validMinutes(monitor?.stallMinutes);
    const longRun = validMinutes(monitor?.longRunMinutes);
    if (stall !== undefined) extra.stallMinutes = stall;
    if (longRun !== undefined) extra.longRunMinutes = longRun;
    rec = plan.record(extra);
    if (rec) {
      this.sessionRuntime.set(rec.key, { offset: 0, partial: "", state: emptyStreamState(), exited: false });
      this.showRunningNotice(rec);
    } else {
      new Notice(plan.successNotice);
    }
    return rec;
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
    harnessOverride?: CustomHarness | null,
  ): {
    argv: string[];
    label: string;
    successNotice: string;
    record: (extra: Partial<LaunchedSession>) => LaunchedSession | null;
  } | null {
    // The skill runs through a CUSTOM harness: its explicit `custom:` pick, else
    // the designated default harness ("Default"). With neither set there is no
    // runtime to launch — show a Notice rather than fall back to omnigent.
    const harness = harnessOverride ?? this.effectiveCustomHarness(skill.id);
    if (!harness) {
      new Notice(
        "Skill and Harness Manager: no harness set. Choose a Default harness in " +
          "the Config tab → Harnesses, or pick one in the skill's ⚙ Configure panel.",
      );
      return null;
    }
    // A claude subagent (M17) is passed via the command's `{agent}` token.
    const claudeAgent = this.claudeAgentOptionValue(skill.id);
    const argv = buildCustomHarnessArgv({
      command: harness.command,
      prompt,
      agent: claudeAgent,
    });
    if (!argv) {
      new Notice(
        `Skill and Harness Manager: harness "${harness.label}" has an invalid command; not launching.`,
      );
      return null;
    }
    const binary = argv[0];
    if (!nodePath.isAbsolute(binary) || !fs.existsSync(binary)) {
      new Notice(
        `Skill and Harness Manager: harness "${harness.label}" binary not found: ${binary}`,
      );
      return null;
    }
    return {
      argv,
      label: harness.label,
      successNotice: `Launching "${skill.name}" via "${harness.label}" — it should start shortly.`,
      record: (extra: Partial<LaunchedSession>) =>
        this.recordSession(
          sessionToolFromCommand(binary) ?? "custom",
          skill.name,
          cwd,
          binary,
          { harnessId: harness.id, harnessLabel: harness.label, ...extra },
        ),
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
    // Strip per-session Claude Code variables Obsidian may have inherited, so a
    // launched / resumed `claude` is a normal top-level session that saves its
    // conversation (see CLAUDE_SESSION_ENV_VARS).
    return scrubClaudeSessionEnv({ ...process.env, PATH: augmentPath(process.env.PATH, extras) });
  }

  private spawnOmnigent(
    argv: string[],
    cwd: string,
    successNotice: string,
    label = "omnigent",
    track?: {
      logPath: string;
      errPath: string;
      onExit: (code: number | null) => void;
    },
  ): number | null {
    const env = this.launchEnv();

    // Tracked launches write stdout/stderr straight to log files (fds, not
    // pipes), so the run keeps going and stays observable even if Obsidian
    // reloads or quits. Detached on POSIX so it's its own process group (Stop
    // can signal the whole group).
    let outFd: number | undefined;
    let errFd: number | undefined;
    if (track) {
      try {
        fs.mkdirSync(nodePath.dirname(track.logPath), { recursive: true });
        outFd = fs.openSync(track.logPath, "a");
        errFd = fs.openSync(track.errPath, "a");
      } catch (err) {
        console.error("[skill-layer] could not open session logs:", err);
        new Notice(`Skill and Harness Manager: could not create session log files (${String(err)}).`);
        return null;
      }
    }
    const closeFds = () => {
      for (const fd of [outFd, errFd]) {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* already closed */
          }
        }
      }
    };

    let child;
    try {
      // argv[0] is the binary; the rest are inert array args. shell:false
      // (never true — the prompt is untrusted) so args are never shell-parsed.
      // Untracked: ignore stdin+stdout at the OS level (no unconsumed pipe) and
      // pipe stderr for bounded error-surfacing.
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: track ? process.platform !== "win32" : false,
        stdio:
          track && outFd !== undefined && errFd !== undefined
            ? ["ignore", outFd, errFd]
            : ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      closeFds();
      console.error("[skill-layer] spawn threw:", err);
      new Notice(`Skill and Harness Manager: could not launch ${label} (${String(err)}).`);
      return null;
    }
    // The child holds its own copies of the log fds.
    closeFds();

    if (track) {
      child.on("error", (err) => {
        console.error("[skill-layer] spawn error:", err);
        new Notice(`Skill and Harness Manager: failed to launch ${label} — ${err.message}`);
      });
      child.on("exit", (code) => track.onExit(code));
      child.unref?.();
      if (successNotice) new Notice(successNotice);
      return child.pid ?? null;
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
    return child.pid ?? null;
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
    extra: Partial<LaunchedSession> = {},
  ): LaunchedSession | null {
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
      // Tracking fields (headless launches) carry over as-is.
      for (const k of [
        "mode",
        "pid",
        "logPath",
        "errPath",
        "stream",
        "stallMinutes",
        "longRunMinutes",
        "scheduleId",
      ] as const) {
        if (extra[k] !== undefined) (rec as unknown as Record<string, unknown>)[k] = extra[k];
      }
      this.settings.sessions.push(rec);
      void this.saveSettings();
      this.refreshViews();
      this.updateSessionStatusBar();
      return rec;
    } catch (e) {
      console.error("[skill-layer] recordSession failed:", e);
      return null;
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
    for (const s of this.settings.sessions) {
      if (!kept.includes(s)) this.deleteSessionLogs(s);
    }
    if (kept.length !== this.settings.sessions.length) {
      this.settings.sessions = kept;
      void this.saveSettings();
    }
    return [...kept].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Remove one tracked session (the Sessions-tab "Forget" action). */
  async forgetSession(key: string): Promise<void> {
    const gone = this.settings.sessions.find((s) => s.key === key);
    this.settings.sessions = this.settings.sessions.filter((s) => s.key !== key);
    if (gone) this.deleteSessionLogs(gone);
    await this.saveSettings();
    this.refreshViews();
    this.updateSessionStatusBar();
  }

  // --- Session monitoring ------------------------------------------------

  /**
   * `claude --resume <id>` for a Claude-family session whose primary resume
   * command isn't already plain claude; null when there's no id or no claude
   * binary. The claude binary comes from a configured harness, else the
   * standard install locations.
   */
  private claudeResumeFallback(s: LaunchedSession, primary: string[]): string[] | null {
    if (s.stream !== "claude" || !s.sessionId || !/^[A-Za-z0-9._:-]{1,128}$/.test(s.sessionId)) {
      return null;
    }
    const isClaude = (p: string) => nodePath.basename(p).toLowerCase().replace(/\.exe$/, "") === "claude";
    if (primary.length > 0 && isClaude(primary[0])) return null;
    const home = os.homedir();
    const candidates = [
      ...this.settings.harnesses.map((h) => h.command?.[0]).filter((p): p is string => !!p && isClaude(p)),
      nodePath.join(home, ".local", "bin", "claude"),
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
    ];
    const bin = candidates.find((p) => nodePath.isAbsolute(p) && fs.existsSync(p));
    return bin ? [bin, "--resume", s.sessionId] : null;
  }

  /** True while a tracked headless session's process is still running. */
  isSessionLive(s: LaunchedSession): boolean {
    if (s.mode !== "headless" || !s.logPath || s.endedAt !== undefined) return false;
    return typeof s.pid === "number" && isPidAlive(s.pid);
  }

  /** Where headless runs' stdout/stderr go: the OS temp dir, never the vault. */
  sessionLogDir(): string {
    return nodePath.join(os.tmpdir(), "skill-harness-manager", "sessions");
  }

  private deleteSessionLogs(s: LaunchedSession): void {
    this.sessionRuntime.delete(s.key);
    this.sessionDerived.delete(s.key);
    for (const p of [s.logPath, s.errPath]) {
      if (p && p.startsWith(this.sessionLogDir())) {
        try {
          fs.rmSync(p, { force: true });
        } catch {
          /* best effort */
        }
      }
    }
  }

  private runtimeFor(s: LaunchedSession): SessionRuntime {
    let rt = this.sessionRuntime.get(s.key);
    if (!rt) {
      rt = { offset: 0, partial: "", state: emptyStreamState(), exited: false };
      this.sessionRuntime.set(s.key, rt);
    }
    return rt;
  }

  /** Read whatever the run has written since the last poll into its stream state. */
  private readSessionOutput(s: LaunchedSession, rt: SessionRuntime, flush: boolean): void {
    if (!s.logPath || s.stream !== "claude") return;
    let fd: number | undefined;
    try {
      fd = fs.openSync(s.logPath, "r");
      const size = fs.fstatSync(fd).size;
      if (size < rt.offset) {
        // Log was truncated/replaced: start over.
        Object.assign(rt, { offset: 0, partial: "", state: emptyStreamState() });
        rt.decoder = undefined;
      }
      rt.decoder ??= new StringDecoder("utf8");
      const toRead = Math.min(size - rt.offset, 8 * 1024 * 1024);
      if (toRead > 0) {
        const buf = Buffer.alloc(toRead);
        fs.readSync(fd, buf, 0, toRead, rt.offset);
        rt.offset += toRead;
        const { lines, partial } = splitChunk(rt.partial, rt.decoder.write(buf));
        rt.partial = partial;
        for (const line of lines) applyStreamLine(rt.state, line);
      }
      if (flush && rt.partial) {
        applyStreamLine(rt.state, rt.partial);
        rt.partial = "";
      }
    } catch {
      /* log not created yet / unreadable: try again next poll */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  /** Last time the run wrote anything (stdout or stderr), else its start time. */
  private lastSessionActivity(s: LaunchedSession): number {
    let last = s.startedAt;
    for (const p of [s.logPath, s.errPath]) {
      if (!p) continue;
      try {
        last = Math.max(last, fs.statSync(p).mtimeMs);
      } catch {
        /* missing */
      }
    }
    return last;
  }

  /** The last few meaningful stderr lines (for error details). */
  sessionStderrTail(s: LaunchedSession, lines = 3): string {
    if (!s.errPath) return "";
    try {
      const size = fs.statSync(s.errPath).size;
      const start = Math.max(0, size - 4096);
      const fd = fs.openSync(s.errPath, "r");
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return buf
        .toString("utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^Warning: no stdin data received/.test(l))
        .slice(-lines)
        .join("\n");
    } catch {
      return "";
    }
  }

  /**
   * Check every tracked headless session: read new output, work out its status,
   * raise each alert once, cache the outcome when it finishes, and refresh the
   * Sessions tab + status bar when anything visible changed. Runs every 10s and
   * immediately when a run exits. Never throws.
   */
  async pollSessions(): Promise<void> {
    if (this.sessionPolling) return;
    this.sessionPolling = true;
    try {
      const now = Date.now();
      let dirty = false;
      for (const s of this.settings.sessions) {
        if (s.mode !== "headless" || !s.logPath) continue;
        if (s.outcome && s.endedAt === undefined) {
          delete s.outcome;
          dirty = true;
        }
        if (s.outcome) {
          if (!this.sessionDerived.has(s.key)) this.sessionDerived.set(s.key, derivedFromOutcome(s.outcome));
          continue;
        }
        const rt = this.runtimeFor(s);
        // Liveness BEFORE reading: if it's already dead, the log is complete.
        const alive =
          !rt.exited &&
          s.endedAt === undefined &&
          typeof s.pid === "number" &&
          isPidAlive(s.pid);
        this.readSessionOutput(s, rt, !alive);
        if (rt.state.sessionId && s.sessionId !== rt.state.sessionId) {
          s.sessionId = rt.state.sessionId;
          dirty = true;
        }
        if (!alive && s.endedAt === undefined) {
          s.endedAt = now;
          dirty = true;
        }
        const d = deriveSessionStatus({
          session: s,
          stream: s.stream === "claude" ? rt.state : undefined,
          alive,
          lastActivityAt: this.lastSessionActivity(s),
          now,
          stallMinutes: s.stallMinutes ?? this.settings.stallMinutes,
          longRunMinutes: s.longRunMinutes ?? this.settings.longRunMinutes,
          stderrTail: alive ? undefined : this.sessionStderrTail(s),
        });
        this.sessionDerived.set(s.key, d);
        const live = this.liveNotices.get(s.key);
        if (live) live.detailEl.setText(d.detail);
        // Recovered from a stall: close its notice and re-arm the stall alert.
        if (d.status === "running" && s.alerted?.includes("stalled")) {
          this.stallNotices.get(s.key)?.hide();
          this.stallNotices.delete(s.key);
          s.alerted = s.alerted.filter((k) => k !== "stalled");
          dirty = true;
        }
        if (d.finished || d.status === "stalled") this.closeRunningNotice(s.key);
        if (d.finished) this.onSessionFinished(s, d);
        for (const kind of alertsToFire(d, s.alerted)) {
          this.showSessionAlert(s, kind, d);
          s.alerted = [...(s.alerted ?? []), kind];
          dirty = true;
        }
        if (d.finished) {
          const r = rt.state.result;
          s.outcome = {
            status: d.status,
            detail: d.detail,
            question: d.question,
            resultText: r?.text || rt.state.lastText,
            costUsd: r?.costUsd,
            numTurns: r?.numTurns,
            durationMs: r?.durationMs ?? (s.endedAt ?? now) - s.startedAt,
          };
          this.sessionRuntime.delete(s.key);
          dirty = true;
        }
      }
      if (dirty) await this.saveSettings();
      // Refresh visible bits when a status changes, and once a minute for elapsed times.
      const sig = this.settings.sessions
        .map((s) => {
          const d = this.sessionDerived.get(s.key);
          return `${s.key}:${d?.status}:${d?.longRunning}:${d?.detail}:${s.acknowledged}`;
        })
        .join("|");
      if (sig !== this.sessionSig) {
        this.sessionSig = sig;
        this.refreshSessionViews();
      }
      this.updateSessionStatusBar();
    } catch (e) {
      console.error("[skill-layer] pollSessions failed:", e);
    } finally {
      this.sessionPolling = false;
    }
  }

  /** The current status of a session (for the Sessions tab / details modal). */
  describeSession(s: LaunchedSession): DerivedStatus {
    const cached = this.sessionDerived.get(s.key);
    if (cached) return withResumed(cached, s.resumedAt);
    if (s.outcome) return withResumed(derivedFromOutcome(s.outcome), s.resumedAt);
    if (s.mode === "headless" && s.logPath) {
      return { status: "running", longRunning: false, finished: false, detail: "Starting…" };
    }
    return deriveSessionStatus({
      session: s,
      alive: false,
      lastActivityAt: s.startedAt,
      now: Date.now(),
      stallMinutes: this.settings.stallMinutes,
      longRunMinutes: this.settings.longRunMinutes,
    });
  }

  /** Fully re-read a session's log (details modal): steps, result, stderr. */
  readSessionDetails(s: LaunchedSession): { state: StreamState; stderr: string } {
    const rt: SessionRuntime = { offset: 0, partial: "", state: emptyStreamState(), exited: true };
    this.readSessionOutput(s, rt, true);
    return { state: rt.state, stderr: this.sessionStderrTail(s, 12) };
  }

  /** Stop a running headless session (SIGTERM to its process group). */
  async stopSession(key: string): Promise<void> {
    const s = this.settings.sessions.find((x) => x.key === key);
    if (!s || typeof s.pid !== "number") return;
    try {
      if (process.platform !== "win32") process.kill(-s.pid, "SIGTERM");
      else process.kill(s.pid, "SIGTERM");
    } catch {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    s.stopped = true;
    s.acknowledged = true;
    await this.saveSettings();
    new Notice(`Stopped “${s.skillName}”.`);
    window.setTimeout(() => void this.pollSessions(), 500);
  }

  /** Mark a session as dealt with, so it leaves "Needs attention". */
  async acknowledgeSession(key: string): Promise<void> {
    const s = this.settings.sessions.find((x) => x.key === key);
    if (!s || s.acknowledged) return;
    s.acknowledged = true;
    await this.saveSettings();
    this.refreshSessionViews();
    this.updateSessionStatusBar();
  }

  openSessionDetails(s: LaunchedSession): void {
    new SessionDetailsModal(this.app, this, s).open();
  }

  /** Open the browser on the Sessions tab. */
  async openSessionsTab(): Promise<void> {
    await this.activateView();
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      if (leaf.view instanceof SkillBrowserView) leaf.view.showTab("sessions");
    }
  }

  private refreshSessionViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      if (leaf.view instanceof SkillBrowserView) leaf.view.refreshSessions();
    }
  }

  /** Status-bar summary: "2 running · 1 needs you" (hidden when idle). */
  updateSessionStatusBar(): void {
    const el = this.sessionStatusEl;
    if (!el) return;
    let running = 0;
    let attention = 0;
    for (const s of this.settings.sessions) {
      const d = this.describeSession(s);
      if (!d.finished) running++;
      if (sessionGroup(d, s.acknowledged) === "attention") attention++;
    }
    el.empty();
    el.toggleClass("skill-layer-statusbar-hidden", running === 0 && attention === 0);
    if (running > 0) {
      const r = el.createSpan({ cls: "skill-layer-statusbar-part" });
      setIcon(r.createSpan({ cls: "skill-layer-statusbar-icon" }), "loader");
      r.createSpan({ text: `${running} running` });
    }
    if (attention > 0) {
      const a = el.createSpan({ cls: "skill-layer-statusbar-part mod-attention" });
      setIcon(a.createSpan({ cls: "skill-layer-statusbar-icon" }), "alert-triangle");
      a.createSpan({ text: `${attention} need${attention === 1 ? "s" : ""} you` });
    }
    el.setAttr("aria-label", "Skill and Harness Manager sessions — click to open");
  }

  /**
   * Show a session notice: a theme-coloured box with a small × in its top-right
   * corner as the way to dismiss it. Clicking the box body (not a button) opens
   * the Sessions tab and that session's details. `build` fills the box and gets
   * a `close` callback for its own buttons.
   */
  private sessionNotice(
    s: LaunchedSession,
    cls: string,
    build: (box: HTMLElement, close: () => void) => void,
    duration = 0,
  ): Notice {
    let notice: Notice | null = null;
    const close = () => notice?.hide();
    const frag = createFragment((f) => {
      const box = f.createDiv({ cls: `skill-layer-alert ${cls}` });
      const x = box.createEl("button", {
        cls: "skill-layer-alert-close clickable-icon",
        attr: { "aria-label": "Dismiss" },
      });
      setIcon(x, "x");
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
      });
      build(box, close);
      box.setAttr("aria-label", `Open the “${s.skillName}” session`);
      // Body click → Sessions tab + details. Clicks never reach Obsidian's
      // click-to-dismiss; the box's own buttons handle themselves.
      box.addEventListener("click", (e) => {
        e.stopPropagation();
        if ((e.target as HTMLElement | null)?.closest("button")) return;
        void this.openSessionsTab().then(() => this.openSessionDetails(s));
      });
    });
    notice = new Notice(frag, duration);
    noticeBox(notice)?.addClass("skill-layer-notice");
    return notice;
  }

  /** A sticky notice for a session that needs attention. */
  private showSessionAlert(s: LaunchedSession, kind: AlertKind, d: DerivedStatus): void {
    const name = `“${s.skillName}”`;
    const title =
      kind === "needs-input"
        ? `${name} needs your input`
        : kind === "errored"
          ? `${name} failed`
          : kind === "stalled"
            ? `${name} may be stalled`
            : `${name} is still running after ${formatDuration(Date.now() - s.startedAt)}`;
    const body = kind === "needs-input" && d.question ? d.question : d.detail;
    if (kind === "needs-input" || kind === "errored") this.cmuxNotifySession(title, body);
    const notice = this.sessionNotice(s, `mod-${kind}`, (box, close) => {
      box.createDiv({ cls: "skill-layer-alert-title", text: title });
      if (body) box.createDiv({ cls: "skill-layer-alert-body", text: body });
      const actions = box.createDiv({ cls: "skill-layer-alert-actions" });
      // Connect only once the run has ended (a running headless session can't
      // take input); while it's live, Details is the way in.
      if (!this.isSessionLive(s)) {
        actions
          .createEl("button", { text: "Connect", cls: "mod-cta" })
          .addEventListener("click", () => {
            close();
            this.openSessionTerminal(s);
          });
      }
      actions
        .createEl("button", { text: "Details" })
        .addEventListener("click", () => this.openSessionDetails(s));
    });
    if (kind === "stalled") this.stallNotices.set(s.key, notice);
  }

  /**
   * The live "is running" notice shown at launch: elapsed time + current step,
   * updated in place. Dismiss with its ×; the session still pops a notice back
   * up if it stalls / needs input / fails, and briefly when it finishes.
   */
  private showRunningNotice(s: LaunchedSession): void {
    let elapsedEl: HTMLElement | null = null;
    let detailEl: HTMLElement | null = null;
    const notice = this.sessionNotice(s, "mod-running", (box) => {
      box.createDiv({ cls: "skill-layer-alert-title", text: `“${s.skillName}” is running` });
      const line = box.createDiv({ cls: "skill-layer-alert-body" });
      line.createSpan({ text: `${s.harnessLabel ?? s.tool} · ` });
      elapsedEl = line.createSpan({ cls: "skill-layer-alert-elapsed", text: "0s" });
      line.createSpan({ text: " · " });
      detailEl = line.createSpan({ text: "Starting…" });
    });
    if (elapsedEl && detailEl) this.liveNotices.set(s.key, { notice, elapsedEl, detailEl });
  }

  private closeRunningNotice(key: string): void {
    const live = this.liveNotices.get(key);
    if (!live) return;
    live.notice.hide();
    this.liveNotices.delete(key);
  }

  /** A run just finished: close its stall notice; a clean finish gets a brief notice. */
  private onSessionFinished(s: LaunchedSession, d: DerivedStatus): void {
    this.stallNotices.get(s.key)?.hide();
    this.stallNotices.delete(s.key);
    this.noteScheduleRunStatus(s, d.status);
    if (d.status !== "done") return; // needs-input / errored alert separately; stopped already noticed
    const ran = formatDuration((s.endedAt ?? Date.now()) - s.startedAt);
    this.cmuxNotifySession(`“${s.skillName}” finished in ${ran}`, d.detail);
    this.sessionNotice(
      s,
      "mod-done",
      (box) => {
        box.createDiv({ cls: "skill-layer-alert-title", text: `“${s.skillName}” finished in ${ran}` });
        if (d.detail) box.createDiv({ cls: "skill-layer-alert-body", text: d.detail });
        const actions = box.createDiv({ cls: "skill-layer-alert-actions" });
        actions
          .createEl("button", { text: "Details" })
          .addEventListener("click", () => this.openSessionDetails(s));
      },
      8000,
    );
  }

  /** Every second: tick elapsed times in live notices + the Sessions tab. */
  private tickSessions(): void {
    const now = Date.now();
    for (const [key, live] of this.liveNotices) {
      const s = this.settings.sessions.find((x) => x.key === key);
      if (!s || !noticeVisible(live.notice)) {
        this.liveNotices.delete(key); // dismissed by the user (or forgotten)
        continue;
      }
      live.elapsedEl.setText(formatDuration(now - s.startedAt));
    }
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      if (leaf.view instanceof SkillBrowserView) leaf.view.tickSessions(now);
    }
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
          ? resumeArgvForSession(userResume, s.sessionId)
          : buildResumeArgv(s);
      // Connecting to a finished session counts as dealing with it: it's now
      // continued interactively, so it shows as Resumed (not its old status).
      if (this.describeSession(s).finished) {
        s.resumedAt = Date.now();
        s.acknowledged = true;
        void this.saveSettings();
        this.refreshSessionViews();
        this.updateSessionStatusBar();
      }

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

      // Claude-family sessions are plain Claude Code sessions underneath, so
      // `claude --resume <id>` can always open them (primary for Isaac, the
      // fallback for other wrappers whose resume fails to start).
      const claudeResume = this.claudeResumeFallback(s, argv);
      // Isaac's own `isaac resume <id>` was seen rewriting the session file at
      // startup, dropping turns from an earlier Connect (so every Connect landed
      // back at the original question). Isaac sessions are plain Claude Code
      // sessions underneath, so resume them with `claude --resume <id>` and
      // keep `isaac resume` only as the fallback if claude fails to start.
      const isIsaac =
        s.tool === "isaac" || nodePath.basename(s.binaryPath).toLowerCase() === "isaac";
      const primary = isIsaac && claudeResume ? claudeResume : argv;
      const fallback = isIsaac && claudeResume ? argv : claudeResume;
      const header =
        `Resuming “${s.skillName}” (${label})` +
        (s.sessionId ? ` · session ${s.sessionId}` : "");
      // Connect opens in the same Preferred terminal as terminal launches (e.g.
      // Ghostty), not always the OS default, since the default terminal may be
      // blocked from the vault folder by macOS privacy settings.
      const term = this.resolvePreferredTerminal();
      const { ext, content } = buildTerminalScript(primary, s.cwd, hint, process.platform, true, {
        header,
        fallback: fallback ?? undefined,
        fallbackNote: fallback
          ? isIsaac && claudeResume
            ? "claude --resume didn't start; trying isaac resume instead…"
            : `${label} resume didn't start; opening the same session with claude --resume instead…`
          : undefined,
        cwdGuard: true,
      });
      this.openTerminalScript(content, ext, `resume-${s.tool}`, term, `↻ ${s.skillName}`);
      new Notice(`Connecting to "${s.skillName}" (${label}) in ${this.terminalPlaceLabel(term)}…`);
    } catch (e) {
      console.error("[skill-layer] openSessionTerminal failed:", e);
      new Notice(`Skill and Harness Manager: could not open a terminal for this session.`);
    }
  }

  /**
   * Run a launch PLAN (skill's harness argv) VISIBLY in the user's PREFERRED
   * terminal. Writes a `cd <cwd> && <argv>` script (POSIX-quoted by
   * `buildTerminalScript`) and opens it in the chosen emulator. Never throws.
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
    // can continue.
    const argv = toInteractiveArgv(plan.argv);
    const keepOpen = true;
    try {
      const { ext, content } = buildTerminalScript(argv, cwd, hint, process.platform, keepOpen);
      this.openTerminalScript(content, ext, `run-${plan.label}`, term, skillName);
      new Notice(`Opening "${skillName}" in ${this.terminalPlaceLabel(term)}…`);
    } catch (e) {
      console.error("[skill-layer] runPlanInTerminal failed:", e);
      new Notice("Skill and Harness Manager: could not open a terminal.");
    }
  }

  /**
   * The shared temp-script + terminal-opener surface: write `content` to a temp
   * file with extension `ext`, mark it executable (non-Windows), and open it in a
   * terminal. `terminal` selects the emulator (defaults to the OS default when
   * omitted); `tag` labels the temp filename; `title` names the tab where the
   * terminal supports it (cmux, Ghostty ≥ 1.3).
   *
   * Integrations: cmux opens the script as a new tab in the plugin's cmux
   * workspace; Ghostty ≥ 1.3 opens it as a tab via AppleScript. Either falls back
   * to a plain opener (with a Notice) if it fails.
   */
  private openTerminalScript(
    content: string,
    ext: string,
    tag: string,
    terminal?: DetectedTerminal,
    title?: string,
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

    const term: DetectedTerminal = terminal ?? { def: { id: "auto", label: "Auto" } };
    const tabTitle = title ?? tag;
    let integrated = false;
    if (plat === "darwin" && term.def.integration === "cmux" && term.binPath) {
      integrated = true;
      const bin = term.binPath;
      this.cmuxQueue = this.cmuxQueue
        .then(() => this.openInCmux(bin, term.appPath, file, tabTitle))
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[skill-layer] cmux open failed:", e);
          new Notice(
            `Skill and Harness Manager: ${cmuxErrorMessage(classifyCmuxError(msg), msg)} ` +
              `Opening in your default terminal instead.`,
            12000,
          );
          this.spawnTerminalOpener(file, { def: { id: "auto", label: "Auto" } });
        });
    } else if (
      plat === "darwin" &&
      term.def.integration === "ghostty" &&
      ghosttySupportsAppleScript(this.ghosttyVersion)
    ) {
      integrated = true;
      this.openInGhostty(file, tabTitle).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[skill-layer] Ghostty AppleScript open failed:", e);
        const denied = /-1743|not authori[sz]ed|not allowed/i.test(msg);
        new Notice(
          denied
            ? "Skill and Harness Manager: macOS blocked Obsidian from controlling Ghostty. " +
                "Allow it in System Settings → Privacy & Security → Automation → Obsidian → Ghostty. " +
                "Opening a separate Ghostty window instead."
            : "Skill and Harness Manager: couldn't open a Ghostty tab; opening a separate Ghostty window instead.",
          12000,
        );
        this.spawnTerminalOpener(file, term);
      });
    } else {
      this.spawnTerminalOpener(file, term);
    }

    // Belt-and-suspenders cleanup: delete the temp launcher once the terminal has
    // read+started it. The script also self-deletes at run time (`rm -f "$0"`);
    // this covers the case where the terminal never launched so a stale script
    // can't be re-run by session-restore. Integrations get longer (cmux may have
    // to start up first). Never throws.
    window.setTimeout(
      () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone (self-deleted) or never created — fine */
        }
      },
      integrated ? 90_000 : 10_000,
    );
  }

  /** Where a terminal open lands, for Notices: "cmux › Obsidian Sessions", "Ghostty", … */
  private terminalPlaceLabel(term: DetectedTerminal): string {
    if (term.def.integration === "cmux" && term.binPath) {
      return `cmux › ${this.cmuxWorkspaceName()}`;
    }
    return term.def.label;
  }

  /** Open a written launcher script with the terminal's plain opener command. */
  private spawnTerminalOpener(file: string, term: DetectedTerminal): void {
    // A specific preferred terminal, else the OS default (auto). buildOpenerCommand
    // handles macOS GUI emulators + the per-platform default.
    const opener = buildOpenerCommand({
      terminal: term,
      scriptPath: file,
      platform: process.platform,
      linuxTerminalEnv: process.env.TERMINAL,
    });
    const child = spawn(opener.bin, opener.args, {
      env: this.launchEnv(),
      stdio: "ignore",
      detached: true,
      windowsHide: false,
    });
    child.unref?.();
  }

  // --- cmux integration ---------------------------------------------------
  /** The detected cmux terminal (with its CLI path), or undefined. */
  getCmuxTerminal(): DetectedTerminal | undefined {
    return this.detectedTerminals.find((t) => t.def.id === "cmux" && !!t.binPath);
  }

  /** The cmux workspace name runs open into. */
  cmuxWorkspaceName(): string {
    return resolveCmuxWorkspaceName(this.settings.cmuxWorkspaceName);
  }

  /**
   * Run the cmux CLI with inert argv (execFile, no shell). Resolves stdout;
   * rejects with an Error whose message is the CLI's stderr/stdout. The env drops
   * any inherited CMUX_* surface ids (if Obsidian was started from a cmux tab) so
   * cmux never resolves "the caller's" workspace/tab for us.
   */
  private runCmux(bin: string, args: string[], timeoutMs = 8000): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...this.launchEnv(), CMUX_QUIET: "1" };
    for (const k of ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_TAB_ID", "CMUX_PANEL_ID"]) {
      delete env[k];
    }
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`${String(stderr || "")} ${String(stdout || "")} ${err.message}`.trim()));
          } else {
            resolve(String(stdout));
          }
        },
      );
    });
  }

  /**
   * Make sure cmux is up and accepting us. If its socket isn't reachable, open
   * the app and poll for up to ~15s. An access-denied answer is thrown right away
   * (no point waiting: the socket mode has to change — see setup-cmux).
   */
  private async ensureCmuxRunning(bin: string, appPath?: string): Promise<void> {
    try {
      await this.runCmux(bin, ["capabilities", "--json"], 4000);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (classifyCmuxError(msg) === "access-denied") throw e;
    }
    spawn("/usr/bin/open", ["-a", appPath ?? "cmux"], { stdio: "ignore", detached: true }).unref?.();
    let last: unknown = null;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => window.setTimeout(r, 1000));
      try {
        await this.runCmux(bin, ["capabilities", "--json"], 3000);
        return;
      } catch (e) {
        last = e;
        const msg = e instanceof Error ? e.message : String(e);
        if (classifyCmuxError(msg) === "access-denied") throw e;
      }
    }
    throw last instanceof Error ? last : new Error("cmux did not start (not running)");
  }

  /** Find the plugin's cmux workspace (by name); undefined when absent. */
  private async findCmuxWorkspaceRef(bin: string): Promise<string | undefined> {
    const list = parseCmuxWorkspaces(await this.runCmux(bin, ["workspace", "list", "--json"]));
    return findCmuxWorkspace(list, this.cmuxWorkspaceName())?.ref;
  }

  /**
   * Open a launcher script as a new tab in the plugin's cmux workspace, creating
   * the workspace (with this run as its first tab) when it doesn't exist yet.
   * The tab is titled; when "Bring cmux to front" is on the workspace is selected
   * and cmux activated. Throws on failure (caller falls back).
   */
  private async openInCmux(
    bin: string,
    appPath: string | undefined,
    scriptFile: string,
    title: string,
  ): Promise<void> {
    await this.ensureCmuxRunning(bin, appPath);
    const cwd = this.detector.vaultBasePath() ?? os.homedir();
    const command = cmuxRunCommand(scriptFile);
    const focus = this.settings.cmuxFocus;
    let wsRef = await this.findCmuxWorkspaceRef(bin);
    if (wsRef) {
      const refs = parseCmuxRefs(
        await this.runCmux(bin, cmuxNewSurfaceArgs({ workspace: wsRef, cwd, command, focus })),
      );
      await this.runCmux(bin, cmuxRenameTabArgs({ workspace: wsRef, surface: refs.surface, title })).catch(
        () => undefined,
      );
    } else {
      const refs = parseCmuxRefs(
        await this.runCmux(
          bin,
          cmuxNewWorkspaceArgs({ name: this.cmuxWorkspaceName(), cwd, command, focus }),
        ),
      );
      wsRef = refs.workspace;
      if (wsRef) {
        await this.runCmux(bin, cmuxRenameTabArgs({ workspace: wsRef, title })).catch(() => undefined);
      }
    }
    if (focus) {
      if (wsRef) {
        await this.runCmux(bin, ["select-workspace", "--workspace", wsRef]).catch(() => undefined);
      }
      spawn("/usr/bin/open", ["-a", appPath ?? "cmux"], { stdio: "ignore", detached: true }).unref?.();
    }
  }

  /**
   * Settings "Test connection": report whether the plugin can drive cmux and
   * where runs will open. Never throws.
   */
  async testCmuxConnection(): Promise<{ ok: boolean; text: string }> {
    const cmux = this.getCmuxTerminal();
    if (!cmux?.binPath) {
      return { ok: false, text: "cmux isn't installed (no cmux.app with its bundled CLI found)." };
    }
    try {
      const caps = await this.runCmux(cmux.binPath, ["capabilities", "--json"], 4000);
      const mode = parseCmuxAccessMode(caps) || "unknown";
      const ws = await this.findCmuxWorkspaceRef(cmux.binPath);
      const name = this.cmuxWorkspaceName();
      return {
        ok: true,
        text:
          `Connected (socket mode: ${mode}). Runs open as tabs in the “${name}” workspace` +
          (ws ? ` (${ws}).` : ", which will be created on the first run."),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, text: cmuxErrorMessage(classifyCmuxError(msg), msg) };
    }
  }

  /**
   * Post a cmux notification for a session event (finished / failed / needs
   * input) when "cmux notifications" is on. Best-effort and silent: never starts
   * cmux and never surfaces an error.
   */
  private cmuxNotifySession(title: string, body?: string): void {
    if (!this.settings.cmuxNotify || process.platform !== "darwin") return;
    const cmux = this.getCmuxTerminal();
    if (!cmux?.binPath) return;
    const bin = cmux.binPath;
    void (async () => {
      const ws = await this.findCmuxWorkspaceRef(bin).catch(() => undefined);
      await this.runCmux(bin, cmuxNotifyArgs({ title, body, workspace: ws }));
    })().catch((e) => console.debug("[skill-layer] cmux notify skipped:", e));
  }

  // --- Ghostty integration (≥ 1.3, AppleScript) ---------------------------
  /** Installed Ghostty version + whether runs open as tabs (for the settings UI). */
  getGhosttyStatus(): { installed: boolean; version: string; tabs: boolean } {
    const installed = this.detectedTerminals.some((t) => t.def.id === "ghostty");
    return {
      installed,
      version: this.ghosttyVersion,
      tabs: installed && ghosttySupportsAppleScript(this.ghosttyVersion),
    };
  }

  /** Open a launcher script as a Ghostty tab/window via AppleScript. Rejects on failure. */
  private openInGhostty(scriptFile: string, title: string): Promise<void> {
    const script = buildGhosttyAppleScript({
      cwd: this.detector.vaultBasePath() ?? os.homedir(),
      command: cmuxRunCommand(scriptFile),
      title,
      openIn: this.settings.ghosttyOpenIn === "window" ? "window" : "tab",
    });
    return new Promise((resolve, reject) => {
      execFile("/usr/bin/osascript", ["-e", script], { timeout: 15000 }, (err, _out, stderr) => {
        if (err) reject(new Error(`${String(stderr || "")} ${err.message}`.trim()));
        else resolve();
      });
    });
  }

  // --- Schedules ------------------------------------------------------------
  /** All schedules (Schedules tab). */
  getSchedules(): Schedule[] {
    return this.settings.schedules;
  }

  /** The custom harnesses (for the schedule modal's harness picker). */
  getScheduleHarnessOptions(): CustomHarness[] {
    return this.settings.harnesses.filter((h) => isValidCustomHarnessCommand(h.command));
  }

  /** Open the create/edit schedule modal (optionally pre-filled with a skill). */
  openScheduleModal(existing?: Schedule, skill?: Skill): void {
    new ScheduleModal(this.app, this, existing, skill).open();
  }

  /**
   * Create or update a schedule. A new schedule, or one whose trigger changed,
   * starts its cursor NOW — so past occurrences never fire immediately — and a
   * finished one-shot whose trigger changed becomes live again.
   */
  async saveSchedule(next: Schedule): Promise<void> {
    const list = this.settings.schedules;
    const i = list.findIndex((x) => x.id === next.id);
    const now = Date.now();
    if (i === -1) {
      list.push({ ...next, createdAt: now, cursor: now, done: undefined, runs: [] });
    } else {
      const prev = list[i];
      const triggerChanged = JSON.stringify(prev.trigger) !== JSON.stringify(next.trigger);
      list[i] = {
        ...next,
        createdAt: triggerChanged ? now : prev.createdAt,
        cursor: triggerChanged ? now : prev.cursor,
        done: triggerChanged ? undefined : prev.done,
        runs: prev.runs,
      };
    }
    await this.saveSettings();
    this.refreshViews();
  }

  async deleteSchedule(id: string): Promise<void> {
    this.settings.schedules = this.settings.schedules.filter((x) => x.id !== id);
    await this.saveSettings();
    this.refreshViews();
  }

  /** Pause / resume. Resuming starts the cursor now, so runs missed while paused don't fire. */
  async setScheduleEnabled(id: string, enabled: boolean): Promise<void> {
    const sch = this.settings.schedules.find((x) => x.id === id);
    if (!sch) return;
    sch.enabled = enabled;
    if (enabled) sch.cursor = Date.now();
    await this.saveSettings();
    this.refreshViews();
  }

  /** Run a schedule right now (doesn't change when it next runs on its own). */
  async runScheduleNow(id: string): Promise<void> {
    const sch = this.settings.schedules.find((x) => x.id === id);
    if (sch) await this.fireSchedule(sch, "manual");
  }

  /** The live session a schedule run started, if it's still tracked. */
  getScheduleRunSession(run: ScheduleRun): LaunchedSession | undefined {
    return run.sessionKey ? this.settings.sessions.find((x) => x.key === run.sessionKey) : undefined;
  }

  /**
   * Scheduler tick (every 30s). A gap since the last tick longer than a few
   * minutes means the machine slept → a wake. After a wake (or startup) nothing
   * fires until it has settled for a minute, so network/VPN/auth come back first.
   * Then every schedule is evaluated: due ones fire, and ones missed while away
   * are caught up once.
   */
  private async tickSchedules(): Promise<void> {
    const now = Date.now();
    if (isWakeGap(this.scheduleLastTick, now)) {
      this.pendingWake = { wakeAt: now, settleAt: now + WAKE_SETTLE_MS };
    }
    this.scheduleLastTick = now;
    // Keep "Next: in 25m" current on a visible Schedules tab.
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      if (leaf.view instanceof SkillBrowserView) leaf.view.refreshSchedules();
    }
    if (this.scheduleTicking) return;
    if (this.pendingWake && now < this.pendingWake.settleAt) return;
    this.pendingWake = null;
    if (this.settings.schedules.length === 0) return;
    this.scheduleTicking = true;
    try {
      let changed = false;
      for (const sch of [...this.settings.schedules]) {
        const d = evaluateSchedule(sch, now);
        if (d.action === "none") continue;
        changed = true;
        // Advance the cursor / finish one-shots BEFORE launching, so a reload or
        // crash mid-launch can never fire the same occurrence twice.
        sch.cursor = d.slot;
        if (sch.trigger.kind === "once") sch.done = true;
        await this.saveSettings();
        await this.fireSchedule(sch, d.reason);
      }
      if (changed) {
        await this.saveSettings();
        this.refreshViews();
      }
    } catch (e) {
      console.error("[skill-layer] schedule tick failed:", e);
    } finally {
      this.scheduleTicking = false;
    }
  }

  /** Launch one schedule's task now (always headless) and record the run in its history. Never throws. */
  private async fireSchedule(sch: Schedule, reason: ScheduleRun["reason"]): Promise<void> {
    const now = Date.now();
    const record = async (run: Omit<ScheduleRun, "at" | "reason">) => {
      sch.runs = addRun(sch.runs, { at: now, reason, ...run });
      await this.saveSettings();
      this.refreshViews();
    };
    try {
      if (reason !== "manual") {
        new Notice(
          reason === "catch-up"
            ? `Scheduled: running “${sch.name}” (missed while you were away).`
            : `Scheduled: running “${sch.name}”.`,
        );
      }
      let rec: LaunchedSession | null = null;
      if (sch.task.kind === "skill") {
        const task = sch.task;
        const skill =
          this.getSkillById(task.skillId) ??
          [...this.getSkills(), ...this.getCommands()].find(
            (x) => x.name === task.skillName && (x.kind ?? "skill") === (task.itemKind ?? "skill"),
          );
        if (!skill) {
          new Notice(`Scheduled “${sch.name}”: the ${task.itemKind ?? "skill"} “${task.skillName}” wasn't found.`);
          await record({ status: "failed", note: `“${task.skillName}” not found` });
          return;
        }
        rec = await this.launchSkill(skill, undefined, task.prompt, undefined, undefined, {
          scheduleId: sch.id,
          mode: "headless",
        });
      } else {
        rec = this.launchPromptTask(sch);
      }
      await record(rec ? { status: "launched", sessionKey: rec.key } : { status: "failed", note: "Couldn't launch (see the notice)" });
    } catch (e) {
      console.error("[skill-layer] fireSchedule failed:", e);
      await record({ status: "failed", note: "Launch error" });
    }
  }

  /** Launch a PROMPT task through its harness (or the default one). */
  private launchPromptTask(sch: Schedule): LaunchedSession | null {
    if (sch.task.kind !== "prompt") return null;
    if (!this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: launching requires the desktop app.");
      return null;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill and Harness Manager: could not resolve the vault path; not launching.");
      return null;
    }
    const harnessId = sch.task.harnessId;
    const harness = harnessId
      ? this.getScheduleHarnessOptions().find((h) => h.id === harnessId) ?? this.resolveDefaultHarness()
      : this.resolveDefaultHarness();
    const prompt = buildPromptTaskPrompt({
      prompt: sch.task.prompt,
      vaultPath: cwd,
      appendAnchor: this.settings.appendVaultAnchor,
    });
    // A synthetic item so the shared launch path (session record, notices,
    // terminal tab title) shows the schedule's name.
    const item: Skill = {
      id: `schedule:${sch.id}`,
      kind: "skill",
      name: sch.name,
      description: "",
      path: "",
      vaultPath: null,
      sourceRoot: "",
      sourceLabel: "schedule",
      detection: "vault",
      tags: [],
    };
    return this.runLaunch(item, prompt, cwd, "headless", undefined, harness, sch.id);
  }

  /** A scheduled run's session ended: copy its final status into the schedule's history. */
  private noteScheduleRunStatus(s: LaunchedSession, status: string): void {
    if (!s.scheduleId) return;
    const sch = this.settings.schedules.find((x) => x.id === s.scheduleId);
    const run = sch?.runs.find((r) => r.sessionKey === s.key);
    if (!run) return;
    const map: Record<string, ScheduleRun["status"]> = {
      done: "done",
      "needs-input": "needs-input",
      errored: "errored",
      stopped: "stopped",
    };
    const next = map[status];
    if (!next || run.status === next) return;
    run.status = next;
    void this.saveSettings();
    this.refreshViews();
  }

  // --- Bundled setup skills -------------------------------------------------
  /** Absolute path a bundled skill installs to, or null without a vault path. */
  private bundledSkillPath(id: BundledSkillId): string | null {
    const base = this.detector.vaultBasePath();
    return base ? nodePath.join(base, BUNDLED_SKILLS[id].relPath) : null;
  }

  /** True when the bundled skill's SKILL.md already exists in the vault. */
  isBundledSkillInstalled(id: BundledSkillId): boolean {
    const abs = this.bundledSkillPath(id);
    return !!abs && fs.existsSync(abs);
  }

  /**
   * Write a bundled setup skill (setup-cmux / setup-ghostty) into the vault's
   * `.agents/skills/` so it shows up in the Skills tab. Never overwrites an
   * existing copy (the user may have edited it). Never throws.
   */
  async installBundledSkill(id: BundledSkillId): Promise<void> {
    const sk = BUNDLED_SKILLS[id];
    const abs = this.bundledSkillPath(id);
    if (!abs || !this.detector.canScanExternal()) {
      new Notice("Skill and Harness Manager: installing skills requires the desktop app.");
      return;
    }
    try {
      if (fs.existsSync(abs)) {
        new Notice(`“${sk.name}” is already installed (${sk.relPath}).`);
        return;
      }
      await fs.promises.mkdir(nodePath.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, sk.body, "utf8");
      await this.rescan();
      new Notice(`Installed “${sk.name}”. Run it from the Skills tab.`, 8000);
    } catch (err) {
      console.error(`[skill-layer] installing ${sk.name} failed:`, err);
      new Notice(`Skill and Harness Manager: couldn't install “${sk.name}”.`);
    }
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

/** In-memory read state for one tracked session (rebuilt after a reload). */
interface SessionRuntime {
  offset: number;
  partial: string;
  state: StreamState;
  exited: boolean;
  decoder?: StringDecoder;
}

/** A live-updating notice and the spans the ticker rewrites. */
interface LiveNotice {
  notice: Notice;
  elapsedEl: HTMLElement;
  detailEl: HTMLElement;
}

/** The notice's outer `.notice` element (containerEl on 1.8+, noticeEl before). */
function noticeBox(n: Notice): HTMLElement | undefined {
  const any = n as unknown as { containerEl?: HTMLElement; noticeEl?: HTMLElement };
  return any.containerEl ?? any.noticeEl;
}

/** False once the user has dismissed a notice (or it timed out). */
function noticeVisible(n: Notice): boolean {
  const el = noticeBox(n);
  return !!el && el.isConnected;
}

/** True if a process with this pid exists (EPERM = exists but not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A per-launch minutes override, if it's a sane number (1 min – 24 h). */
function validMinutes(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 24 * 60 ? v : undefined;
}

function derivedFromOutcome(o: {
  status: string;
  detail: string;
  question?: string;
}): DerivedStatus {
  return {
    status: o.status as SessionStatus,
    longRunning: false,
    finished: true,
    detail: o.detail,
    question: o.question,
  };
}
