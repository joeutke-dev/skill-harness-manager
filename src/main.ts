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
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { Detector } from "./detector";
import { elementHasSvg, pinAction, resolvePinnedIcon } from "./icon";
import { IconPickerModal } from "./iconPicker";
import {
  AGENT_CONFIG_SUBDIR,
  AGENT_SESSION_PROMPT,
  augmentPath,
  buildAgentInvocation,
  buildLaunchPrompt,
  buildOmnigentArgv,
  buildRightClickMenuItems,
  buildSkillInvocation,
  BUNDLE_CONFIG_NAME,
  CustomAgent,
  decodeAgentChoice,
  discoverCustomAgents,
  encodeAgentChoice,
  isAllowedBuiltinAgent,
  isValidCustomAgentPath,
  resolveAgentLaunch,
  resolveOmnigentBinary,
  safeCustomAgentRealPath,
  SkillAgent,
} from "./launch";
import {
  coerceFrontmatterTags,
  parseFrontmatter,
  resolveSkillTags,
  sanitizeTag,
} from "./parse";
import { SkillLayerSettingTab } from "./settingsTab";
import { addTagToContent, removeTagFromContent } from "./tagEdit";
import { DEFAULT_SETTINGS, Skill, SkillLayerSettings } from "./types";
import { SKILL_LAYER_VIEW, SkillBrowserView } from "./view";
import { decideToggleAction } from "./viewToggle";

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

  private rescanTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.detector = new Detector(this.app, () => this.settings);

    this.registerView(
      SKILL_LAYER_VIEW,
      (leaf: WorkspaceLeaf) => new SkillBrowserView(leaf, this),
    );

    this.addRibbonIcon("layers", "Skill Layer: browse skills", () => {
      void this.toggleView();
    });

    this.addCommand({
      id: "open-browser",
      name: "Open skills browser",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "rescan",
      name: "Rescan skills",
      callback: () => void this.rescan(true),
    });

    this.addSettingTab(new SkillLayerSettingTab(this.app, this));

    // Hot-reload for Vault-API (non-dot) roots. `vault.on('modify')` fires on
    // edit (incl. external edits Obsidian detects), but the metadataCache may
    // not be re-parsed yet at that moment — so we ALSO listen to
    // `metadataCache.on('changed')`, which fires after a fresh re-parse, and
    // the scan reads fresh file content anyway (see Detector.scanVaultRoot).
    // Dot-folder / external roots emit no events; they refresh on view open
    // and via the manual Rescan command.
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
    });
  }

  onunload(): void {
    if (this.rescanTimer !== null) window.clearTimeout(this.rescanTimer);
    // Detach the browser view leaves.
    this.app.workspace.detachLeavesOfType(SKILL_LAYER_VIEW);
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
      "skillHarness",
      "discoveredHarnesses",
      "customHarnesses",
      "omnigentHarness",
      // M11: the user-configurable invocation template and the omnigent server
      // URL are gone. The "Copy invocation" action now uses a FIXED natural-
      // language form (`Use the <name> skill.`), and server routing is decided
      // by omnigent's own config.yaml (the plugin never passes `--server`).
      // Strip both fail-closed so a stale data.json can never reintroduce them;
      // every OTHER setting (scanRoots, pins, skillAgent, omnigentBinaryPath,
      // appendVaultAnchor, …) is preserved by the Object.assign above.
      "invocationTemplate",
      "omnigentServerUrl",
    ]) {
      delete raw[key];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    for (const leaf of this.app.workspace.getLeavesOfType(SKILL_LAYER_VIEW)) {
      const view = leaf.view;
      if (view instanceof SkillBrowserView) view.refresh();
    }
    if (notify) new Notice(`Skill Layer: found ${this.skills.length} skills.`);
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
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    // A freshly created leaf's onOpen() runs the rescan itself.
    await leaf.setViewState({ type: SKILL_LAYER_VIEW, active: true });
    await workspace.revealLeaf(leaf);
  }

  /**
   * Ribbon behavior: toggle the Skill Layer pane.
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
      `Skill Layer: ${on ? "removed" : "added"} "${skill.name}" ${
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
          .setIcon("layers")
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
    const el = document.createElement("div");
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
  requestPin(skill: Skill): void {
    const action = pinAction({
      remembered: this.settings.skillIcons[skill.id],
      isValid: (i) => this.iconResolves(i),
    });
    if (action.kind === "pin") {
      void this.setSkillIcon(skill, action.icon);
    } else {
      this.openIconPicker(skill);
    }
  }

  /** Open the searchable Lucide icon picker; choosing pins / re-icons the skill. */
  openIconPicker(skill: Skill): void {
    new IconPickerModal(this.app, this.settings.skillIcons[skill.id], (iconId) => {
      void this.setSkillIcon(skill, iconId);
    }).open();
  }

  /**
   * Set a skill's ribbon icon (the pin action). Pins if not already pinned, or
   * updates the existing ribbon icon in place. Persisted in data.json only.
   */
  async setSkillIcon(skill: Skill, iconId: string): Promise<void> {
    if (!this.iconResolves(iconId)) {
      new Notice(`Skill Layer: "${iconId}" is not a known icon.`);
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
      `Skill Layer: ${wasPinned ? "updated icon for" : "pinned"} "${skill.name}".`,
    );
    this.refreshViews();
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
      `Skill Layer: Run ${skill.name}`,
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
  /** Open a skill's file in Obsidian (vault file) or the OS default (dot/external). */
  async openSkill(skill: Skill): Promise<void> {
    const tfile = this.detector.resolveTFile(skill.vaultPath);
    if (tfile instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(tfile);
      return;
    }
    // Non-indexed file (dot-folder or external) — open with the OS default app.
    try {
      const result: string = await shell.openPath(skill.path);
      if (result) new Notice(`Could not open file: ${result}`);
    } catch (err) {
      console.error("[skill-layer] openPath failed:", err);
      new Notice("Could not open skill file.");
    }
  }

  /**
   * Copy the skill's invocation string to the clipboard (row action). The
   * invocation is the FIXED natural-language form `Use the <name> skill.` (M11
   * removed the user-configurable template). It embeds no path, so no shell
   * quoting is needed.
   */
  async copyInvocation(skill: Skill): Promise<void> {
    const invocation = buildSkillInvocation(skill.name);
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
   */
  async launchSkill(skill: Skill, contextPath?: string): Promise<void> {
    // Desktop + filesystem capability gate.
    if (!this.detector.canScanExternal()) {
      new Notice("Skill Layer: launching requires the desktop app.");
      return;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill Layer: could not resolve the vault path; not launching.");
      return;
    }

    // Resolve the omnigent binary, failing closed (shared with launchCustomAgent).
    const binaryPath = this.resolveBinaryOrNotice();
    if (!binaryPath) return;

    // Natural-language prompt (NOT the `/slash` invocation): a leading-slash
    // first token would hit omnigent's REPL slash dispatcher ("Unknown
    // command") instead of selecting the host skill. Reuse the spawn cwd as the
    // vault path in the anchor text. ("Copy invocation" keeps the slash form.)
    const prompt = buildLaunchPrompt(
      skill.name,
      cwd,
      this.settings.appendVaultAnchor,
      contextPath,
    );
    // Per-skill AGENT, resolved fail-closed: a built-in name reaches argv as an
    // omnigent SUBCOMMAND only if it is in the hardcoded allowlist; a custom
    // path reaches argv as a single inert positional after `run` only if it is a
    // real direct child of the scan dir AND is either a `.yaml`/`.yml` file or a
    // bundle directory containing `config.yaml`. Anything else (absent / unknown
    // kind / bad name / bad path) → the Default agent (`omnigent run …`). No
    // display label/description ever flows to argv.
    const agent = resolveAgentLaunch(this.settings.skillAgent[skill.id], {
      scanDir: this.agentConfigDir() ?? "",
      exists: (p) => fs.existsSync(p),
    });
    const argv = buildOmnigentArgv({
      binaryPath,
      prompt,
      agent,
    });

    // Spawn via the single shared hardened surface. The success Notice is built
    // here (skill name + optional context file); the run's real success/failure
    // is async (an 'error' or non-zero 'exit' Notices from spawnOmnigent).
    this.spawnOmnigent(
      argv,
      cwd,
      `Launching "${skill.name}"${
        contextPath ? ` on ${nodePath.basename(contextPath)}` : ""
      } in omnigent — it should appear in the omnigent UI shortly.`,
    );
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
        'Skill Layer: invalid omnigent binary path (must be an absolute path ' +
          'to a binary named "omnigent"). Launch aborted.',
      );
      return null;
    }
    if (resolution.status === "not-found") {
      new Notice(
        "Skill Layer: omnigent binary not found. Set its path in Settings → Skill Layer.",
      );
      return null;
    }
    return resolution.path;
  }

  /**
   * The plugin's ONLY process-spawn surface, shared by skill launch (launchSkill)
   * and custom-agent launch (launchCustomAgent). `argv[0]` is the allowlisted,
   * absolute omnigent binary; the rest are inert array args. shell:false; stdio
   * ignores stdin/stdout at the OS level and pipes a bounded stderr tail. `cwd`
   * is the vault base path so any files the run writes land in the real vault.
   * `successNotice` is shown once spawn succeeds.
   */
  private spawnOmnigent(argv: string[], cwd: string, successNotice: string): void {
    // GUI apps inherit a thin launchd PATH; the binary execs sub-tools, so
    // widen PATH (de-duped) without mutating process.env. /opt/homebrew/bin is
    // required so omnigent can find the Homebrew `databricks` CLI it uses to
    // authenticate to its remote server (absent from the launchd PATH).
    const env = {
      ...process.env,
      PATH: augmentPath(process.env.PATH, [
        "/usr/local/bin",
        `${os.homedir()}/.local/bin`,
        "/opt/homebrew/bin",
      ]),
    };

    let child;
    try {
      // argv[0] is the binary; the rest are inert array args. shell:false.
      // stdio: ignore stdin+stdout at the OS level (no unconsumed pipe); keep
      // stderr piped for bounded error-surfacing.
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (err) {
      console.error("[skill-layer] spawn threw:", err);
      new Notice(`Skill Layer: could not launch omnigent (${String(err)}).`);
      return;
    }

    // Capture a short stderr tail for error-surfacing; don't hang on the run.
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-600);
    });
    child.on("error", (err) => {
      console.error("[skill-layer] omnigent spawn error:", err);
      new Notice(`Skill Layer: failed to launch omnigent — ${err.message}`);
    });
    child.on("exit", (code) => {
      if (code && code !== 0) {
        const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
        new Notice(
          `Skill Layer: omnigent exited ${code}${tail ? ` — ${tail}` : ""}`,
        );
      }
    });
    child.unref?.();

    // Spawn succeeded; the run's real success/failure is async (an 'error' or
    // non-zero 'exit' will Notice above), so don't assert success here.
    new Notice(successNotice);
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
    try {
      const result: string = await shell.openPath(fileToOpen);
      if (result) {
        new Notice(`Could not open agent config (${result}). Path: ${fileToOpen}`);
      }
    } catch (err) {
      console.error("[skill-layer] openPath (agent) failed:", err);
      new Notice(`Could not open agent config. Path: ${fileToOpen}`);
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
      new Notice("Skill Layer: launching requires the desktop app.");
      return;
    }
    const cwd = this.detector.vaultBasePath();
    if (!cwd) {
      new Notice("Skill Layer: could not resolve the vault path; not launching.");
      return;
    }
    const real = this.validateAgentPath(agentPath);
    if (!real) {
      new Notice(
        "Skill Layer: this agent path failed validation; not launching.",
      );
      return;
    }
    const binaryPath = this.resolveBinaryOrNotice();
    if (!binaryPath) return;

    const argv = buildOmnigentArgv({
      binaryPath,
      prompt: AGENT_SESSION_PROMPT,
      agent: { mode: "custom", path: real },
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
        "Skill Layer: this agent path failed validation; nothing copied.",
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
      new Notice("Skill Layer: not a valid tag.");
      return;
    }
    const existing = skill.tags.find(
      (t) => t.tag.toLowerCase() === tag.toLowerCase(),
    );
    if (existing) {
      if (existing.origin === "frontmatter") {
        new Notice(`Skill Layer: "${skill.name}" already has the tag #${existing.tag}.`);
        return;
      }
      if (existing.origin === "folder") {
        new Notice(`Skill Layer: #${existing.tag} is already auto-applied from the folder.`);
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
        `Skill Layer: ${op === "add" ? "added" : "removed"} #${tag} ${
          op === "add" ? "to" : "from"
        } "${skill.name}".`,
      );
    } catch (err) {
      console.error(`[skill-layer] tag ${op} failed for ${skill.path}:`, err);
      new Notice(`Skill Layer: could not ${op} tag (see console).`);
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
        "Skill Layer: external file writes require the desktop app with filesystem access.",
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
