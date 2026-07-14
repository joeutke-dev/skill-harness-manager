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
import { LaunchedSession, relativeTime, resumeTargetLabel } from "./sessions";

export const SKILL_LAYER_VIEW = "skill-layer-browser";

export class SkillBrowserView extends ItemView {
  private plugin: SkillLayerPlugin;
  private filter = "";
  /** Multi-select dropdown filters (empty set = no constraint for that facet).
   *  Within a facet the selected values are OR'd; facets are AND'd together. */
  private filterAgents = new Set<string>();
  private filterHarnesses = new Set<string>();
  private filterTags = new Set<string>();
  /** Access facet — any of {"rightclick","ribbon"}; both = union. */
  private filterAccess = new Set<string>();
  private listEl: HTMLElement | null = null;
  /** Collapsed source-folder groups in the tree (M18), keyed by group label. */
  private collapsedGroups = new Set<string>();
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
    return "Skill and Harness Manager";
  }

  getIcon(): string {
    return "brain-circuit";
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

    // No rescan button (it ate the top space) — the view rescans on open and on
    // file changes; per-tab Refresh controls remain on Agents/Harnesses. The tab
    // bar sits at the very top now.
    this.renderTabBar(root);

    this.tabContentEl = root.createDiv({ cls: "skill-layer-tabcontent" });
    this.renderActiveTab();
  }

  /** The Skills | Agents tab bar; clicking a tab switches the rendered content. */
  private renderTabBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "skill-layer-tabbar", attr: { role: "tablist" } });
    TABS.forEach((tab, i) => {
      const active = this.activeTab === tab.id;
      // Show a divider after this tab only when it AND its next sibling are both
      // inactive (computed here so the CSS needn't use a `:has()` selector).
      const next = TABS[i + 1];
      const divider = !active && next !== undefined && this.activeTab !== next.id;
      // A DIV (role=tab), NOT a <button> — Obsidian's default button chrome
      // (background, padding, box-shadow) interferes with the Chrome-tab CSS.
      const btn = bar.createEl("div", {
        cls:
          "skill-layer-tab" +
          (active ? " is-active" : "") +
          (divider ? " has-divider" : ""),
        text: tab.label,
        attr: {
          role: "tab",
          tabindex: "0",
          "aria-label": `${tab.label} tab`,
          "aria-selected": String(active),
        },
      });
      const activate = () => {
        if (this.activeTab === tab.id) return;
        this.activeTab = tab.id;
        // Filters are per-tab (agents/harnesses/tags differ between Skills and
        // Commands), so reset them to avoid a stale selection hiding everything.
        this.resetFilters();
        // Re-render the whole view so tab-bar active state + content both update.
        this.render();
      };
      btn.addEventListener("click", activate);
      btn.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
    });
  }

  /** Render the content for the active tab into the tab-content container. */
  private renderActiveTab(): void {
    const c = this.tabContentEl;
    if (!c) return;
    c.empty();
    if (this.activeTab === "agents") this.renderAgentsTab(c);
    else if (this.activeTab === "harnesses") this.renderHarnessesTab(c);
    else if (this.activeTab === "sessions") this.renderSessionsTab(c);
    else this.renderBrowserTab(c); // skills OR commands (same browser UI)
  }

  /** The active browser tab's item kind + label noun. */
  private get browsing(): { items: Skill[]; noun: string } {
    return this.activeTab === "commands"
      ? { items: this.plugin.getCommands(), noun: "command" }
      : { items: this.plugin.getSkills(), noun: "skill" };
  }

  /** Empty-state block: a muted lucide glyph above the explanatory copy. */
  private renderEmptyState(parent: HTMLElement, text: string): void {
    const empty = parent.createDiv({ cls: "skill-layer-empty" });
    setIcon(empty.createSpan(), "brain-circuit");
    empty.createSpan({ text });
  }

  /** The Skills/Commands browser tab (search + filters + facet + rows). Shared
   *  between the Skills and Commands tabs — the only difference is the item
   *  source + label noun (see `browsing`). */
  private renderBrowserTab(c: HTMLElement): void {
    const noun = this.browsing.noun;
    // Search + a compact Refresh (the unified rescan — replaces the old top
    // Rescan button; re-scans skills/commands/agents + re-discovers harnesses).
    const toolbar = c.createDiv({ cls: "skill-layer-searchbar" });
    const search = toolbar.createEl("input", {
      cls: "skill-layer-search",
      attr: {
        type: "text",
        placeholder: `Filter ${noun}s by name, description, source…`,
        "aria-label": `Filter ${noun}s by name, description, source, or path`,
      },
    });
    search.value = this.filter;
    search.addEventListener("input", () => {
      this.filter = search.value.toLowerCase().trim();
      this.renderList();
    });

    const refreshBtn = toolbar.createEl("button", {
      cls: "skill-layer-rescan skill-layer-refresh-icon",
      attr: { "aria-label": "Refresh (rescan skills, commands, agents, harnesses)" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => void this.plugin.refreshAll());

    this.renderFilterBar(c, this.browsing.items);

    this.listEl = c.createDiv({ cls: "skill-layer-list" });
    this.renderList();
  }

  /** The effective Agent label for a skill (accounts for custom-harness Claude
   *  subagents vs omnigent agents), mirroring the row-meta pill logic. */
  private agentLabelOf(s: Skill): string {
    return this.plugin.skillUsesCustomHarness(s.id)
      ? this.plugin.claudeAgentLabelFor(s.id)
      : this.plugin.agentLabelFor(s.id);
  }

  private resetFilters(): void {
    this.filter = "";
    this.filterAgents.clear();
    this.filterHarnesses.clear();
    this.filterTags.clear();
    this.filterAccess.clear();
  }

  /** The dark filter bar: Agent / Harness / Tag / Access MULTI-select dropdowns.
   *  Options are the distinct values actually present across `all`, so empty
   *  facets vanish. */
  private renderFilterBar(c: HTMLElement, all: Skill[]): void {
    const bar = c.createDiv({ cls: "skill-layer-filterbar" });

    const distinct = (fn: (s: Skill) => string): string[] =>
      Array.from(new Set(all.map(fn).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
      );

    this.addMultiSelect(
      bar,
      "Filter by agent",
      "All agents",
      "agents",
      distinct((s) => this.agentLabelOf(s)).map((v) => ({ value: v, text: v })),
      this.filterAgents,
    );
    this.addMultiSelect(
      bar,
      "Filter by harness",
      "All harnesses",
      "harnesses",
      distinct((s) => this.plugin.harnessLabelFor(s.id)).map((v) => ({
        value: v,
        text: v,
      })),
      this.filterHarnesses,
    );

    // Tags: distinct across every item's resolved tags (case-insensitive).
    const tagByKey = new Map<string, string>();
    for (const s of all) {
      for (const t of s.tags) {
        const k = t.tag.toLowerCase();
        if (!tagByKey.has(k)) tagByKey.set(k, t.tag);
      }
    }
    this.addMultiSelect(
      bar,
      "Filter by tag",
      "All tags",
      "tags",
      Array.from(tagByKey.keys())
        .sort()
        .map((k) => ({ value: k, text: `#${tagByKey.get(k) ?? k}` })),
      this.filterTags,
    );

    this.addMultiSelect(
      bar,
      "Filter by access",
      "Any access",
      "surfaces",
      [
        { value: "rightclick", text: "Right-click" },
        { value: "ribbon", text: "Ribbon" },
      ],
      this.filterAccess,
    );
  }

  /**
   * A custom multi-select dropdown: a form-field-styled button showing the
   * current selection, and a checkbox popup that stays open across toggles so
   * multiple values can be picked. Selecting toggles membership in `selected`
   * (OR within the facet) and re-renders the list live. Closes on outside click
   * or Escape. `noun` labels the "N selected" summary (e.g. "agents").
   */
  private addMultiSelect(
    bar: HTMLElement,
    label: string,
    allLabel: string,
    noun: string,
    options: { value: string; text: string }[],
    selected: Set<string>,
  ): void {
    const field = bar.createDiv({ cls: "skill-layer-filter" });
    // The document this view lives in (handles pop-out windows correctly, and
    // keeps add/removeEventListener on the same document).
    const doc = field.ownerDocument;
    const btn = field.createEl("button", {
      cls: "skill-layer-filter-select",
      attr: { "aria-label": label, "aria-haspopup": "listbox" },
    });
    const labelSpan = btn.createSpan({ cls: "skill-layer-filter-label" });
    const chev = btn.createSpan({ cls: "skill-layer-filter-chevron" });
    setIcon(chev, "chevron-down");

    const summary = (): void => {
      if (selected.size === 0) labelSpan.setText(allLabel);
      else if (selected.size === 1) {
        const only = Array.from(selected)[0];
        const opt = options.find((o) => o.value === only);
        labelSpan.setText(opt ? opt.text : `1 ${noun}`);
      } else labelSpan.setText(`${selected.size} ${noun}`);
    };
    summary();

    const menu = field.createDiv({
      cls: "skill-layer-filter-menu",
      attr: { role: "listbox", "aria-multiselectable": "true" },
    });
    for (const o of options) {
      const row = menu.createDiv({
        cls: "skill-layer-filter-option",
        attr: { role: "option" },
      });
      const check = row.createSpan({ cls: "skill-layer-filter-check" });
      row.createSpan({ cls: "skill-layer-filter-optlabel", text: o.text });
      const sync = (): void => {
        const on = selected.has(o.value);
        check.empty();
        if (on) setIcon(check, "check");
        row.setAttr("aria-selected", String(on));
      };
      sync();
      this.makeActivatable(row, () => {
        if (selected.has(o.value)) selected.delete(o.value);
        else selected.add(o.value);
        sync();
        summary();
        this.renderList();
      });
    }

    let open = false;
    const onDocClick = (e: MouseEvent): void => {
      if (!field.contains(e.target as Node)) close();
    };
    const close = (): void => {
      if (!open) return;
      open = false;
      menu.removeClass("is-open");
      btn.removeClass("is-open");
      doc.removeEventListener("click", onDocClick, true);
    };
    const openMenu = (): void => {
      if (open) return;
      open = true;
      menu.addClass("is-open");
      btn.addClass("is-open");
      // Defer so the click that opened it doesn't immediately close it.
      window.setTimeout(
        () => doc.addEventListener("click", onDocClick, true),
        0,
      );
    };
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      if (open) close();
      else openMenu();
    });
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    });
  }

  /** The Sessions tab (M20): resumable conversations the plugin launched, newest
   *  first. Pruned live (dropped after 12h or when no longer resumable). Each row
   *  shows the skill, tool, and start time, with a Connect (open terminal) action. */
  private renderSessionsTab(c: HTMLElement): void {
    const sessions = this.plugin.livePrunedSessions();
    if (sessions.length === 0) {
      this.renderEmptyState(
        c,
        "No recent sessions. Launch a skill and it appears here — sessions drop " +
          "off after 12 hours or once they're no longer resumable.",
      );
      return;
    }
    const list = c.createDiv({ cls: "skill-layer-list" });
    const now = Date.now();
    for (const s of sessions) this.renderSessionRow(list, s, now);
  }

  /** One Sessions-tab row: skill + tool badge + start time, Connect / Forget. */
  private renderSessionRow(
    parent: HTMLElement,
    s: LaunchedSession,
    now: number,
  ): void {
    const el = parent.createDiv({ cls: "skill-layer-row" });
    const main = el.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    nameLine.createSpan({ text: s.skillName, cls: "skill-layer-row-name" });
    nameLine.createSpan({
      text: s.harnessLabel ?? s.tool,
      cls: "skill-layer-row-badge",
    });

    const started = new Date(s.startedAt);
    main.createDiv({
      cls: "skill-layer-row-desc",
      text: `Started ${relativeTime(s.startedAt, now)} · ${started.toLocaleString()}`,
    });
    main.createDiv({ cls: "skill-layer-row-path", text: resumeTargetLabel(s) });

    const actions = el.createDiv({ cls: "skill-layer-row-actions" });
    const connect = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-launch",
      attr: { "aria-label": `Connect to the ${s.skillName} session in a terminal` },
    });
    setIcon(connect.createSpan({ cls: "skill-layer-action-icon" }), "terminal");
    connect.createSpan({ text: " Connect" });
    connect.addEventListener("click", () => this.plugin.openSessionTerminal(s));

    const forget = actions.createEl("button", {
      cls: "skill-layer-action",
      attr: { "aria-label": `Forget the ${s.skillName} session` },
    });
    setIcon(forget.createSpan({ cls: "skill-layer-action-icon" }), "x");
    forget.createSpan({ text: " Forget" });
    forget.addEventListener("click", () => void this.plugin.forgetSession(s.key));
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
    refreshBtn.addEventListener("click", () => void this.plugin.refreshAll());

    const agents = this.plugin.getCustomAgents();
    const model = buildAgentsTabModel(agents);

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
    launchBtn.addEventListener("click", () => {
      void this.plugin.launchCustomAgent(row.path);
    });

    const openBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Open file",
    });
    openBtn.addEventListener("click", () => {
      void this.plugin.openCustomAgent(row.path);
    });

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
   * user's custom harnesses. Add/remove is done in Settings → Skill and Harness Manager (this
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
    refreshBtn.addEventListener("click", () => void this.plugin.refreshAll());

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

    const hint = c.createDiv({ cls: "skill-layer-count" });
    hint.setText("Add custom harnesses in Settings → Skill and Harness Manager.");

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

    const { items: all, noun } = this.browsing;

    const skills = all.filter((s) => this.matches(s));

    if (skills.length === 0) {
      this.renderEmptyState(
        container,
        all.length === 0
          ? `No ${noun}s found. Add scan roots in Settings → Skill and Harness Manager, then Rescan.`
          : `No ${noun}s match the current filters.`,
      );
      return;
    }

    // Group by source folder, rendered as a collapsible tree that mirrors
    // Obsidian's file explorer: a folder title (chevron + name + count) with the
    // items nested under a left indent-guide line, so items read as belonging to
    // their source folder (.claude, .agents, cursor, …).
    const groups = new Map<string, Skill[]>();
    for (const s of skills) {
      const g = groups.get(s.sourceLabel) ?? [];
      g.push(s);
      groups.set(s.sourceLabel, g);
    }

    for (const label of Array.from(groups.keys()).sort()) {
      const items = groups.get(label) ?? [];
      const collapsed = this.collapsedGroups.has(label);
      const folder = container.createDiv({ cls: "skill-layer-tree-folder" });

      // A DIV (role=button), NOT a <button> — Obsidian's default button chrome
      // (grey background, box-shadow, radius) otherwise wins over our transparent
      // styling and draws a grey box around the folder header.
      const title = folder.createDiv({
        cls: "skill-layer-tree-folder-title",
        attr: {
          "aria-expanded": String(!collapsed),
          "aria-label": `${label} (${items.length} ${this.browsing.noun}${items.length === 1 ? "" : "s"})`,
        },
      });
      const chevron = title.createSpan({ cls: "skill-layer-tree-chevron" });
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
      title.createSpan({ cls: "skill-layer-tree-folder-name", text: label });
      this.makeActivatable(title, () => {
        if (collapsed) this.collapsedGroups.delete(label);
        else this.collapsedGroups.add(label);
        this.renderList();
      });

      if (!collapsed) {
        const children = folder.createDiv({ cls: "skill-layer-tree-children" });
        for (const skill of items) this.renderRow(children, skill);
      }
    }
  }

  /** Toggle a tag in the Tag facet (called from a row tag chip). Re-renders the
   *  whole tab so the Tag dropdown's checkboxes stay in sync with the chips. */
  private toggleTagFilter(tagLower: string): void {
    if (this.filterTags.has(tagLower)) this.filterTags.delete(tagLower);
    else this.filterTags.add(tagLower);
    this.renderActiveTab();
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
    // Multi-select facets: empty set = no constraint; else OR within the facet.
    if (this.filterAgents.size && !this.filterAgents.has(this.agentLabelOf(s))) {
      return false;
    }
    if (
      this.filterHarnesses.size &&
      !this.filterHarnesses.has(this.plugin.harnessLabelFor(s.id))
    ) {
      return false;
    }
    if (
      this.filterTags.size &&
      !s.tags.some((t) => this.filterTags.has(t.tag.toLowerCase()))
    ) {
      return false;
    }
    if (this.filterAccess.size) {
      const rc = this.filterAccess.has("rightclick") && this.plugin.isRightClickEnabled(s.id);
      const pin = this.filterAccess.has("ribbon") && this.plugin.isPinned(s.id);
      if (!rc && !pin) return false;
    }
    return true;
  }

  /**
   * Make a non-<button> element keyboard-activatable (a11y): role=button,
   * focusable, and Enter/Space triggers the same handler as click. Used for the
   * clickable chips/pills that can't be real buttons (they nest a remove-×).
   */
  private makeActivatable(el: HTMLElement, onActivate: () => void): void {
    el.setAttr("role", "button");
    el.setAttr("tabindex", "0");
    el.addEventListener("click", onActivate);
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    });
  }

  private renderRow(parent: HTMLElement, skill: Skill): void {
    const row = parent.createDiv({ cls: "skill-layer-row" });

    const main = row.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    nameLine.createSpan({ text: skill.name, cls: "skill-layer-row-name" });

    main.createDiv({ cls: "skill-layer-row-desc", text: skill.description });
    // Path is single-line truncated (CSS); full path in a tooltip.
    main
      .createDiv({ cls: "skill-layer-row-path", text: skill.path })
      .setAttr("title", skill.path);

    this.renderRowMeta(main, skill);
    this.renderRowTags(main, skill);

    // Cleaned-up row (M16): only the two primary actions live here — Launch
    // (spawn a one-shot run) and Open file — plus a ⚙ that opens the per-skill
    // Configuration modal holding everything else (Copy invocation, right-click
    // toggle, Run-with agent, Harness, ribbon pin/icon). See SkillConfigModal.
    const actions = row.createDiv({ cls: "skill-layer-row-actions" });

    const noun = skill.kind === "command" ? "command" : "skill";
    const launchBtn = actions.createEl("button", {
      cls: "skill-layer-action skill-layer-action-launch",
      attr: { "aria-label": `Run the ${skill.name} ${noun}` },
    });
    setIcon(launchBtn.createSpan({ cls: "skill-layer-action-icon" }), "play");
    launchBtn.createSpan({ text: noun === "command" ? " Run command" : " Run skill" });
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
      this.makeActivatable(el, () =>
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
          (this.filterTags.has(t.tag.toLowerCase()) ? " is-active" : ""),
      });
      chip.createSpan({ cls: "skill-layer-chip-label", text: `#${t.tag}` });
      if (t.origin === "folder") {
        chip.setAttr("title", "auto from folder");
        chip.setAttr("aria-label", `${t.tag} (auto from folder)`);
      } else if (t.origin === "description") {
        chip.setAttr("title", "from description text — edit the note to change");
        chip.setAttr("aria-label", `${t.tag} (from description text — read-only)`);
      }
      // Clicking anywhere on the chip toggles its filter (keyboard-activatable).
      chip.setAttr("aria-pressed", String(this.filterTags.has(t.tag.toLowerCase())));
      this.makeActivatable(chip, () => this.toggleTagFilter(t.tag.toLowerCase()));
      // Only frontmatter chips get a remove ×; it stops propagation (click AND
      // key) so removing doesn't also toggle the filter.
      if (removable) {
        const x = chip.createSpan({ cls: "skill-layer-chip-x" });
        setIcon(x, "x");
        x.setAttr("aria-label", `Remove tag ${t.tag}`);
        x.setAttr("role", "button");
        x.setAttr("tabindex", "0");
        const removeTag = async () => {
          await this.plugin.removeTag(skill, t.tag);
          this.renderList();
        };
        x.addEventListener("click", (evt) => {
          evt.stopPropagation();
          void removeTag();
        });
        x.addEventListener("keydown", (evt: KeyboardEvent) => {
          if (evt.key === "Enter" || evt.key === " ") {
            evt.preventDefault();
            evt.stopPropagation();
            void removeTag();
          }
        });
      }
    }

    // "+ tag" affordance.
    const addChip = wrap.createSpan({
      cls: "skill-layer-chip skill-layer-chip-add",
      text: "+ tag",
    });
    addChip.setAttr("aria-label", `Add a tag to ${skill.name}`);
    this.makeActivatable(addChip, () => this.showAddTagInput(wrap, addChip, skill));
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
