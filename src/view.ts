import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { AgentConfigModal, LaunchModal, SkillConfigModal } from "./configModal";
import type SkillLayerPlugin from "./main";
import {
  AgentRowModel,
  buildAgentsTabModel,
  DEFAULT_TAB,
  SkillLayerTab,
  TABS,
} from "./tabs";
import { Skill } from "./types";

export const SKILL_LAYER_VIEW = "skill-layer-browser";

export class SkillBrowserView extends ItemView {
  private plugin: SkillLayerPlugin;
  private filter = "";
  /** Active tag filters (lowercased), AND-combined with the text filter. */
  private activeTags = new Set<string>();
  private listEl: HTMLElement | null = null;
  /** Active tab (M10). Defaults to Skills; switching re-renders the view. */
  private activeTab: SkillLayerTab = DEFAULT_TAB;
  /** Container the active tab's content renders into (below the tab bar). */
  private tabContentEl: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: SkillLayerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return SKILL_LAYER_VIEW;
  }

  getDisplayText(): string {
    return "Skill Layer";
  }

  getIcon(): string {
    return "layers";
  }

  async onOpen(): Promise<void> {
    this.render();
    // Dot-folder / external roots emit no metadataCache events — refresh on open.
    await this.plugin.rescan();
    this.renderActiveTab();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Called by the plugin after a rescan / tag write so the view stays current. */
  refresh(): void {
    // Re-render whichever tab is showing (rescan also re-scans custom agents).
    this.renderActiveTab();
  }

  /** Render the persistent chrome (title + rescan + tab bar) and the active tab. */
  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("skill-layer-view");

    const header = root.createDiv({ cls: "skill-layer-header" });

    const rescanBtn = header.createEl("button", {
      cls: "skill-layer-rescan",
      attr: { "aria-label": "Rescan skills" },
    });
    setIcon(rescanBtn, "refresh-cw");
    rescanBtn.createSpan({ text: "Rescan" });
    rescanBtn.addEventListener("click", async () => {
      await this.plugin.rescan();
      this.renderActiveTab();
    });

    this.renderTabBar(root);

    this.tabContentEl = root.createDiv({ cls: "skill-layer-tabcontent" });
    this.renderActiveTab();
  }

  /** The Skills | Agents tab bar; clicking a tab switches the rendered content. */
  private renderTabBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "skill-layer-tabbar" });
    for (const tab of TABS) {
      const active = this.activeTab === tab.id;
      const btn = bar.createEl("button", {
        cls: "skill-layer-tab" + (active ? " is-active" : ""),
        text: tab.label,
        attr: { "aria-label": `${tab.label} tab`, "aria-selected": String(active) },
      });
      btn.addEventListener("click", () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        // Re-render the whole view so tab-bar active state + content both update.
        this.render();
      });
    }
  }

  /** Render the content for the active tab into the tab-content container. */
  private renderActiveTab(): void {
    const c = this.tabContentEl;
    if (!c) return;
    c.empty();
    if (this.activeTab === "agents") this.renderAgentsTab(c);
    else if (this.activeTab === "harnesses") this.renderHarnessesTab(c);
    else this.renderSkillsTab(c);
  }

  /** Empty-state block: a muted lucide glyph above the explanatory copy. */
  private renderEmptyState(parent: HTMLElement, text: string): void {
    const empty = parent.createDiv({ cls: "skill-layer-empty" });
    setIcon(empty.createSpan(), "layers");
    empty.createSpan({ text });
  }

  /** The Skills tab: the existing browser (search + filters + facet + rows). */
  private renderSkillsTab(c: HTMLElement): void {
    const search = c.createEl("input", {
      cls: "skill-layer-search",
      attr: {
        type: "text",
        placeholder: "Filter skills by name, description, source…",
        "aria-label": "Filter skills by name, description, source, or path",
      },
    });
    search.value = this.filter;
    search.addEventListener("input", () => {
      this.filter = search.value.toLowerCase().trim();
      this.renderList();
    });

    this.listEl = c.createDiv({ cls: "skill-layer-list" });
    this.renderList();
  }

  /** The Agents tab: a Refresh control + the discovered custom agents (M10). */
  private renderAgentsTab(c: HTMLElement): void {
    // Refresh control — re-scan custom agents. refreshCustomAgents re-renders open views.
    const toolbar = c.createDiv({ cls: "skill-layer-agents-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "skill-layer-rescan",
      attr: { "aria-label": "Refresh custom agents" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      this.plugin.refreshCustomAgents();
    });

    const agents = this.plugin.getCustomAgents();
    const model = buildAgentsTabModel(agents);

    const count = c.createDiv({ cls: "skill-layer-count" });
    count.setText(
      `${agents.length} custom agent${agents.length === 1 ? "" : "s"}`,
    );

    if (model.empty) {
      this.renderEmptyState(c, model.text);
      return;
    }

    const list = c.createDiv({ cls: "skill-layer-list" });
    for (const row of model.rows) this.renderAgentRow(list, row);
  }

  /** One Agents-tab row: name + description, with Open / Launch / Copy actions. */
  private renderAgentRow(parent: HTMLElement, row: AgentRowModel): void {
    const el = parent.createDiv({ cls: "skill-layer-row" });

    const main = el.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    const nameEl = nameLine.createSpan({
      text: row.title,
      cls: "skill-layer-row-name",
    });
    // Description as subtitle when present; also a title tooltip on the name.
    if (row.subtitle) nameEl.setAttr("title", row.subtitle);
    nameLine.createSpan({ text: "agent", cls: "skill-layer-row-badge" });

    if (row.subtitle) {
      main.createDiv({ cls: "skill-layer-row-desc", text: row.subtitle });
    }
    main.createDiv({ cls: "skill-layer-row-path", text: row.path });

    // Cleaned-up row (M16), mirroring the Skills tab: Launch session + Open file
    // stay inline; Copy invocation moves into the ⚙ Configuration modal.
    const actions = el.createDiv({ cls: "skill-layer-row-actions" });

    const launchBtn = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-launch",
      attr: { "aria-label": `Launch a session with ${row.title}` },
    });
    setIcon(launchBtn.createSpan({ cls: "skill-layer-action-icon" }), "play");
    launchBtn.createSpan({ text: " Launch session" });
    launchBtn.addEventListener("click", () =>
      this.plugin.launchCustomAgent(row.path),
    );

    const openBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Open file",
    });
    openBtn.addEventListener("click", () => this.plugin.openCustomAgent(row.path));

    const cfgBtn = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-gear",
      attr: { "aria-label": `Configure ${row.title}` },
    });
    setIcon(cfgBtn, "settings");
    cfgBtn.addEventListener("click", () =>
      new AgentConfigModal(this.app, this.plugin, row.path, row.title).open(),
    );
  }

  /**
   * The Harnesses tab (M15.3), DISPLAY-ONLY. Shows (1) the harnesses omnigent has
   * configured — discovered by running `omnigent config list` — and (2) the
   * user's custom harnesses. Add/remove is done in Settings → Skill Layer (this
   * tab links there). A Refresh button re-runs discovery. Selecting a harness
   * per skill happens on the skill row's "Harness" dropdown, which this feeds.
   */
  private renderHarnessesTab(c: HTMLElement): void {
    // --- Toolbar: refresh discovery ---
    const toolbar = c.createDiv({ cls: "skill-layer-agents-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "skill-layer-rescan",
      attr: { "aria-label": "Refresh harnesses configured in omnigent" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: "Refresh" });
    refreshBtn.addEventListener("click", () => {
      void this.plugin.refreshConfiguredHarnesses();
    });

    // ONE unified list: omnigent-configured harnesses (discovered via the CLI)
    // and custom harnesses render as the SAME row shape. Omnigent harnesses show
    // their `omnigent run --harness <name>` form; custom ones show their command.
    // Only harnesses actually CONFIGURED in omnigent are shown (an unconfigured
    // provider like Gemini that omnigent lists with "(none configured)" is
    // omitted). Custom harnesses are added/removed in Settings.
    const configured = this.plugin
      .getConfiguredHarnesses()
      .filter((h) => h.configured);
    const custom = this.plugin.getCustomHarnesses();

    if (!this.plugin.hasDiscoveredHarnesses() && custom.length === 0) {
      this.renderEmptyState(c, "Discovering harnesses… (omnigent config list)");
      return;
    }

    const count = c.createDiv({ cls: "skill-layer-count" });
    count.setText(
      `${configured.length + custom.length} harness${
        configured.length + custom.length === 1 ? "" : "es"
      } — add custom ones in Settings → Skill Layer.`,
    );

    const list = c.createDiv({ cls: "skill-layer-list" });
    // Omnigent-discovered (configured) harnesses.
    for (const h of configured) {
      this.renderHarnessRow(list, {
        name: h.name,
        badge: "omnigent",
        detail: `omnigent run --harness ${h.name.toLowerCase()}`,
      });
    }
    // Custom harnesses (same row shape).
    for (const h of custom) {
      this.renderHarnessRow(list, {
        name: h.label,
        badge: "custom",
        detail: h.command.join(" "),
      });
    }
  }

  /** One harness row (shared by omnigent-discovered and custom harnesses). */
  private renderHarnessRow(
    parent: HTMLElement,
    row: { name: string; badge: string; detail: string },
  ): void {
    const el = parent.createDiv({ cls: "skill-layer-row" });
    const main = el.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    nameLine.createSpan({ text: row.name, cls: "skill-layer-row-name" });
    nameLine.createSpan({ text: row.badge, cls: "skill-layer-row-badge" });
    main.createDiv({ cls: "skill-layer-row-path", text: row.detail });
  }

  private renderList(): void {
    const container = this.listEl;
    if (!container) return;
    container.empty();

    const all = this.plugin.getSkills();

    this.renderActiveFilters(container);
    this.renderFacet(container, all);

    const skills = all.filter((s) => this.matches(s));

    const count = container.createDiv({ cls: "skill-layer-count" });
    count.setText(
      `${skills.length} skill${skills.length === 1 ? "" : "s"}` +
        (this.filter || this.activeTags.size
          ? ` (filtered from ${all.length})`
          : ""),
    );

    if (skills.length === 0) {
      this.renderEmptyState(
        container,
        all.length === 0
          ? "No skills found. Add scan roots in Settings → Skill Layer, then Rescan."
          : "No skills match the current filters.",
      );
      return;
    }

    // Group by source label.
    const groups = new Map<string, Skill[]>();
    for (const s of skills) {
      const g = groups.get(s.sourceLabel) ?? [];
      g.push(s);
      groups.set(s.sourceLabel, g);
    }

    for (const label of Array.from(groups.keys()).sort()) {
      const groupEl = container.createDiv({ cls: "skill-layer-group" });
      const heading = groupEl.createDiv({ cls: "skill-layer-group-heading" });
      heading.createSpan({ text: label, cls: "skill-layer-group-name" });
      heading.createSpan({
        text: String(groups.get(label)?.length ?? 0),
        cls: "skill-layer-group-count",
      });
      for (const skill of groups.get(label) ?? []) {
        this.renderRow(groupEl, skill);
      }
    }
  }

  /** The "active tag filters" bar with a clear-all. */
  private renderActiveFilters(container: HTMLElement): void {
    if (this.activeTags.size === 0) return;
    const bar = container.createDiv({ cls: "skill-layer-activefilters" });
    bar.createSpan({ cls: "skill-layer-activefilters-label", text: "Filtering:" });
    for (const tag of Array.from(this.activeTags).sort()) {
      const chip = bar.createSpan({
        cls: "skill-layer-chip is-active",
      });
      chip.createSpan({ cls: "skill-layer-chip-label", text: `#${tag}` });
      const x = chip.createSpan({ cls: "skill-layer-chip-x" });
      setIcon(x, "x");
      x.setAttr("aria-label", `Remove ${tag} filter`);
      x.addEventListener("click", () => this.toggleTagFilter(tag));
    }
    const clear = bar.createEl("button", {
      cls: "skill-layer-clearfilters",
      text: "Clear all",
    });
    clear.addEventListener("click", () => {
      this.activeTags.clear();
      this.renderList();
    });
  }

  /** The tag facet — every tag present across all skills, click to toggle. */
  private renderFacet(container: HTMLElement, all: Skill[]): void {
    const byKey = new Map<string, string>();
    for (const s of all) {
      for (const t of s.tags) {
        const k = t.tag.toLowerCase();
        if (!byKey.has(k)) byKey.set(k, t.tag);
      }
    }
    if (byKey.size === 0) return;

    const facet = container.createDiv({ cls: "skill-layer-facet" });
    for (const key of Array.from(byKey.keys()).sort()) {
      const display = byKey.get(key) ?? key;
      const active = this.activeTags.has(key);
      const chip = facet.createSpan({
        cls: "skill-layer-chip skill-layer-facet-chip" + (active ? " is-active" : ""),
      });
      chip.createSpan({ cls: "skill-layer-chip-label", text: `#${display}` });
      chip.addEventListener("click", () => this.toggleTagFilter(key));
    }
  }

  private toggleTagFilter(tagLower: string): void {
    if (this.activeTags.has(tagLower)) this.activeTags.delete(tagLower);
    else this.activeTags.add(tagLower);
    this.renderList();
  }

  private matches(s: Skill): boolean {
    // Text filter.
    if (this.filter) {
      const q = this.filter;
      const textHit =
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.sourceLabel.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q) ||
        s.tags.some((t) => t.tag.toLowerCase().includes(q));
      if (!textHit) return false;
    }
    // Tag filters — AND: every active tag must be present.
    for (const want of this.activeTags) {
      if (!s.tags.some((t) => t.tag.toLowerCase() === want)) return false;
    }
    return true;
  }

  private renderRow(parent: HTMLElement, skill: Skill): void {
    const row = parent.createDiv({ cls: "skill-layer-row" });

    const main = row.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    nameLine.createSpan({ text: skill.name, cls: "skill-layer-row-name" });

    main.createDiv({ cls: "skill-layer-row-desc", text: skill.description });
    main.createDiv({ cls: "skill-layer-row-path", text: skill.path });

    this.renderRowMeta(main, skill);
    this.renderRowTags(main, skill);

    // Cleaned-up row (M16): only the two primary actions live here — Launch
    // (spawn a one-shot run) and Open file — plus a ⚙ that opens the per-skill
    // Configuration modal holding everything else (Copy invocation, right-click
    // toggle, Run-with agent, Harness, ribbon pin/icon). See SkillConfigModal.
    const actions = row.createDiv({ cls: "skill-layer-row-actions" });

    const launchBtn = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-launch",
      attr: { "aria-label": `Run the ${skill.name} skill` },
    });
    setIcon(launchBtn.createSpan({ cls: "skill-layer-action-icon" }), "play");
    launchBtn.createSpan({ text: " Run skill" });
    // Opens the Run modal so the user can add optional context before running
    // (empty = the prior bare `Use the <name> skill.` behavior).
    launchBtn.addEventListener("click", () =>
      new LaunchModal(this.app, this.plugin, skill).open(),
    );

    // Open ↔ Close toggle: when the skill's file is already open in Obsidian the
    // button becomes "Close file" (closing re-hides a temporarily-revealed
    // hidden folder). Only tracks files open in Obsidian, not the OS app.
    const isOpen = this.plugin.isSkillOpen(skill);
    const openBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: isOpen ? "Close file" : "Open file",
    });
    openBtn.addEventListener("click", () => {
      void (isOpen ? this.plugin.closeSkill(skill) : this.plugin.openSkill(skill));
    });

    const cfgBtn = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-gear",
      attr: { "aria-label": `Configure ${skill.name}` },
    });
    setIcon(cfgBtn, "settings");
    cfgBtn.addEventListener("click", () =>
      new SkillConfigModal(this.app, this.plugin, skill).open(),
    );
  }

  /**
   * The per-skill assignment line (M16): shows the effective AGENT and HARNESS
   * at a glance, so the user sees them without opening Configuration. Each is a
   * labelled pill; a "Default" value is muted while a non-default (explicitly
   * assigned) value is accented so real assignments stand out. Clicking a pill
   * opens the Configuration modal (where the dropdowns live).
   */
  private renderRowMeta(main: HTMLElement, skill: Skill): void {
    const meta = main.createDiv({ cls: "skill-layer-row-meta" });
    const pill = (key: string, val: string): void => {
      const isDefault = val === "Default";
      const el = meta.createSpan({
        cls: "skill-layer-meta-pill" + (isDefault ? " is-default" : " is-set"),
        attr: { "aria-label": `${key}: ${val} — click to configure` },
      });
      el.createSpan({ cls: "skill-layer-meta-key", text: key });
      el.createSpan({ cls: "skill-layer-meta-val", text: val });
      el.addEventListener("click", () =>
        new SkillConfigModal(this.app, this.plugin, skill).open(),
      );
    };
    pill("Harness", this.plugin.harnessLabelFor(skill.id));
    // Agent source depends on the harness (M17): a custom (claude) harness uses
    // Claude subagents (.claude/agents); Default/omnigent use omnigent agents.
    const agentLabel = this.plugin.skillUsesCustomHarness(skill.id)
      ? this.plugin.claudeAgentLabelFor(skill.id)
      : this.plugin.agentLabelFor(skill.id);
    pill("Agent", agentLabel);
  }

  private renderRowTags(main: HTMLElement, skill: Skill): void {
    const wrap = main.createDiv({ cls: "skill-layer-tags" });

    for (const t of skill.tags) {
      // Only frontmatter tags are authoritative / UI-editable. Description and
      // folder tags are read-only (edit the note / move the file to change).
      const removable = t.origin === "frontmatter";
      const originClass =
        t.origin === "frontmatter"
          ? "is-frontmatter"
          : t.origin === "description"
            ? "is-description"
            : "is-folder";
      const chip = wrap.createSpan({
        cls:
          "skill-layer-chip " +
          originClass +
          (this.activeTags.has(t.tag.toLowerCase()) ? " is-active" : ""),
      });
      chip.createSpan({ cls: "skill-layer-chip-label", text: `#${t.tag}` });
      if (t.origin === "folder") {
        chip.setAttr("title", "auto from folder");
        chip.setAttr("aria-label", `${t.tag} (auto from folder)`);
      } else if (t.origin === "description") {
        chip.setAttr("title", "from description text — edit the note to change");
        chip.setAttr("aria-label", `${t.tag} (from description text — read-only)`);
      }
      // Clicking anywhere on the chip toggles its filter.
      chip.addEventListener("click", () =>
        this.toggleTagFilter(t.tag.toLowerCase()),
      );
      // Only frontmatter chips get a remove ×; the × stops propagation so
      // removing doesn't also toggle the filter.
      if (removable) {
        const x = chip.createSpan({ cls: "skill-layer-chip-x" });
        setIcon(x, "x");
        x.setAttr("aria-label", `Remove tag ${t.tag}`);
        x.addEventListener("click", async (evt) => {
          evt.stopPropagation();
          await this.plugin.removeTag(skill, t.tag);
          this.renderList();
        });
      }
    }

    // "+ tag" affordance.
    const addChip = wrap.createSpan({
      cls: "skill-layer-chip skill-layer-chip-add",
      text: "+ tag",
    });
    addChip.setAttr("aria-label", `Add a tag to ${skill.name}`);
    addChip.addEventListener("click", () => this.showAddTagInput(wrap, addChip, skill));
  }

  private showAddTagInput(
    wrap: HTMLElement,
    addChip: HTMLElement,
    skill: Skill,
  ): void {
    addChip.hide();
    const input = wrap.createEl("input", {
      cls: "skill-layer-addtag-input",
      attr: { type: "text", placeholder: "tag", "aria-label": "New tag" },
    });
    input.focus();

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const val = input.value.trim();
      if (val) await this.plugin.addTag(skill, val);
      this.renderList();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.renderList();
      }
    });
    input.addEventListener("blur", () => void commit());
  }
}
