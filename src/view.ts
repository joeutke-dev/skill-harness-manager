import { ItemView, Menu, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import { AgentConfigModal, LaunchModal, PromptModal, SkillConfigModal } from "./configModal";
import { inferSourceLabel } from "./parse";
import type SkillLayerPlugin from "./main";
import { DEFAULT_TAB, SkillLayerTab, TABS } from "./tabs";
import { Skill } from "./types";
import type { CustomHarness } from "./launch";
import { LaunchedSession, relativeTime, resumeTargetLabel } from "./sessions";

export const SKILL_LAYER_VIEW = "skill-layer-browser";

/** A row in the Agents tab (unified across omnigent bundles + Claude/Codex subagents). */
interface AgentBrowserRow {
  title: string;
  subtitle: string;
  /** Absolute launch/open path (a bundle dir/YAML, or a subagent `.md`). */
  path: string;
  /** Source-folder group label, e.g. `.omnigent/agent-configs` or `.claude/agents`. */
  folder: string;
  /** True only for omnigent bundle agents (standalone `omnigent run` launchable). */
  launchable: boolean;
}

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
  /** EXPANDED source-folder groups in the tree, keyed by group label. Sections
   *  default to COLLAPSED; membership here means the user opened it this session. */
  private expandedGroups = new Set<string>();
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
    // Tag the view when the Minimal theme is active so styles.css can special-case
    // it: Minimal collapses --background-secondary(-alt) to the page color, which
    // flattens the browser-tab look, so a scoped override restores a distinct
    // strip. Every other theme keeps the original colors untouched.
    root.toggleClass("skill-layer-minimal", this.isMinimalTheme());

    // No rescan button (it ate the top space) — the view rescans on open and on
    // file changes; per-tab Refresh controls remain on Agents/Harnesses. The tab
    // bar sits at the very top now.
    this.renderTabBar(root);

    this.tabContentEl = root.createDiv({ cls: "skill-layer-tabcontent" });
    this.renderActiveTab();
  }

  /** True when the Minimal community theme is the active theme (read from the
   *  untyped `customCss` API — `theme`/`cssTheme` holds the active theme name). */
  private isMinimalTheme(): boolean {
    const css = (this.app as unknown as {
      customCss?: { theme?: string; cssTheme?: string };
    }).customCss;
    const name = css?.theme ?? css?.cssTheme ?? "";
    return name === "Minimal";
  }

  /** The Skills | Agents tab bar; clicking a tab switches the rendered content. */
  private renderTabBar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "skill-layer-tabbar", attr: { role: "tablist" } });
    TABS.forEach((tab, i) => {
      const active = this.activeTab === tab.id;
      // Show a divider after this tab only when it AND its next sibling are both
      // inactive — so the lines on BOTH sides of the selected tab disappear (the
      // active tab flares out of the strip and needs no flanking dividers).
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
    // Every tab ends with a muted purpose blurb (icon + 1–2 sentences).
    this.renderTabFooter(c, this.tabFooterText(this.activeTab));
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

  /**
   * A per-tab purpose footer: the same muted brain-circuit glyph + one-to-two
   * sentence description of what the tab is for, pinned at the bottom of the tab.
   * Shown on every tab (even when it has content) so the tab's purpose is always
   * visible.
   */
  private renderTabFooter(parent: HTMLElement, text: string): void {
    const footer = parent.createDiv({ cls: "skill-layer-empty skill-layer-tab-footer" });
    setIcon(footer.createSpan(), "brain-circuit");
    footer.createSpan({ text });
  }

  /** One-to-two sentence purpose blurb per tab (shown at the tab's bottom). */
  private tabFooterText(tab: SkillLayerTab): string {
    switch (tab) {
      case "commands":
        return "Commands are Markdown prompt files invoked as /name (e.g. in .claude/commands/) — the simpler, single-file form of a skill. Run one through this UI, add it to the right-click menu, or pin it to the ribbon.";
      case "sessions":
        return "Sessions are the skills you've launched. Use the Connect button to connect to the session in your terminal; sessions are removed after 12 hours.";
      case "agents":
        return "Agents are AI assistants that direct their own tools and steps to complete a task, defined in config (e.g. YAML) or code (a Python SDK). Launch a session with one, or open its config to edit it.";
      case "harnesses":
        return "A harness is the runtime that actually runs a skill — it feeds the prompt to your CLI and loops until the task is done. Add your harnesses above; with more than one, use “Set as default” to pick which one a skill's Default harness uses.";
      default:
        return "Skills are reusable instructions in a SKILL.md file (frontmatter + steps) that an assistant loads when relevant or you invoke as /name. They live in a tool's skills folder (e.g. .claude/skills/). Run one through this UI, add it to the right-click menu, or pin it to the ribbon.";
    }
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

  /** The effective Agent label for a skill: the Claude subagent when it runs
   *  through a custom harness, else its stored agent label. Mirrors the row pill. */
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
        { value: "selection", text: "Selection" },
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

  /**
   * The Agents tab: a Refresh control + every discovered agent, grouped by its
   * actual source folder (like Skills/Commands). Agents come from two sources:
   *  • omnigent bundle agents (`.omnigent/agent-configs`) — LAUNCHABLE as a
   *    standalone `omnigent run <agent>` session;
   *  • Claude/Codex/Cursor subagents (`.claude/agents`, `.codex/agents`, …) —
   *    NOT standalone-launchable (they run via a harness), so they show only
   *    Open file.
   */
  private renderAgentsTab(c: HTMLElement): void {
    const toolbar = c.createDiv({ cls: "skill-layer-agents-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "skill-layer-rescan",
      attr: { "aria-label": "Refresh agents" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.createSpan({ text: "Refresh" });
    refreshBtn.addEventListener("click", () => void this.plugin.refreshAll());

    const rows = this.buildAgentRows();
    if (rows.length === 0) {
      this.renderEmptyState(
        c,
        "No agents found. Define one in .omnigent/agent-configs/ (omnigent) or " +
          ".claude/agents / .codex/agents (Claude/Codex), then Refresh.",
      );
      return;
    }

    // Group by source folder, sorted, mirroring the Skills tab's tree.
    const groups = new Map<string, AgentBrowserRow[]>();
    for (const r of rows) {
      const g = groups.get(r.folder) ?? [];
      g.push(r);
      groups.set(r.folder, g);
    }
    const list = c.createDiv({ cls: "skill-layer-list" });
    for (const label of Array.from(groups.keys()).sort()) {
      const items = groups.get(label) ?? [];
      const collapsed = !this.expandedGroups.has(label); // default-closed
      const folder = list.createDiv({ cls: "skill-layer-tree-folder" });
      const title = folder.createDiv({
        cls: "skill-layer-tree-folder-title",
        attr: {
          "aria-expanded": String(!collapsed),
          "aria-label": `${label} (${items.length} agent${items.length === 1 ? "" : "s"})`,
        },
      });
      const chevron = title.createSpan({ cls: "skill-layer-tree-chevron" });
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
      title.createSpan({ cls: "skill-layer-tree-folder-name", text: label });
      this.makeActivatable(title, () => {
        if (collapsed) this.expandedGroups.add(label);
        else this.expandedGroups.delete(label);
        this.renderActiveTab();
      });
      if (!collapsed) {
        const children = folder.createDiv({ cls: "skill-layer-tree-children" });
        for (const row of items) this.renderAgentRow(children, row);
      }
    }
  }

  /** Unified agent rows across omnigent bundles + Claude/Codex/Cursor subagents. */
  private buildAgentRows(): AgentBrowserRow[] {
    const rows: AgentBrowserRow[] = [];
    // omnigent bundle agents — launchable standalone via `omnigent run`.
    for (const a of this.plugin.getCustomAgents()) {
      rows.push({
        title: a.name,
        subtitle: a.description ?? "",
        path: a.path,
        folder: ".omnigent/agent-configs",
        launchable: true,
      });
    }
    // Claude/Codex/Cursor subagents — grouped by their real agents folder.
    for (const a of this.plugin.getClaudeAgents()) {
      rows.push({
        title: a.name,
        subtitle: a.description ?? "",
        path: a.path,
        folder: inferSourceLabel(a.path),
        launchable: false,
      });
    }
    return rows;
  }

  /** One Agents-tab row. Launchable (omnigent) rows get Launch + ⚙; others get Open only. */
  private renderAgentRow(parent: HTMLElement, row: AgentBrowserRow): void {
    const el = parent.createDiv({ cls: "skill-layer-row" });

    const main = el.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    const nameEl = nameLine.createSpan({
      text: row.title,
      cls: "skill-layer-row-name",
    });
    if (row.subtitle) nameEl.setAttr("title", row.subtitle);
    nameLine.createSpan({ text: "agent", cls: "skill-layer-row-badge" });

    if (row.subtitle) {
      main.createDiv({ cls: "skill-layer-row-desc", text: row.subtitle });
    }
    main.createDiv({ cls: "skill-layer-row-path", text: row.path });

    const actions = el.createDiv({ cls: "skill-layer-row-actions" });

    // Only omnigent bundle agents can be launched as a standalone session.
    if (row.launchable) {
      const launchBtn = actions.createEl("button", {
        cls: "skill-layer-action skill-layer-action-launch",
        attr: { "aria-label": `Launch a session with ${row.title}` },
      });
      setIcon(launchBtn.createSpan({ cls: "skill-layer-action-icon" }), "play");
      launchBtn.createSpan({ text: " Launch session" });
      launchBtn.addEventListener("click", () => {
        void this.plugin.launchCustomAgent(row.path);
      });
    }

    const openBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Open file",
    });
    openBtn.addEventListener("click", () => {
      void this.plugin.openCustomAgent(row.path);
    });

    // The ⚙ (Copy invocation) is omnigent-specific, so only on launchable rows.
    if (row.launchable) {
      const cfgBtn = actions.createEl("button", {
        cls: "skill-layer-action skill-layer-action-gear",
        attr: { "aria-label": `Configure ${row.title}` },
      });
      setIcon(cfgBtn, "settings");
      cfgBtn.addEventListener("click", () =>
        new AgentConfigModal(this.app, this.plugin, row.path, row.title).open(),
      );
    }
  }

  /**
   * The Harnesses tab: the place to MANAGE harnesses. An add form (name +
   * command + optional resume command) at the top, then a row per harness with an
   * editable resume command, a Set-as-default control, and Remove. Only harnesses
   * the user adds appear — nothing is auto-discovered. The default (what a skill's
   * "Default" harness resolves to) is a lone harness automatically, or whichever
   * the user marks when there are several.
   */
  private renderHarnessesTab(c: HTMLElement): void {
    this.renderAddHarnessForm(c);

    const harnesses = this.plugin.getCustomHarnesses();
    const defaultId = this.plugin.resolveDefaultHarness()?.id ?? "";
    const list = c.createDiv({ cls: "skill-layer-list" });
    for (const h of harnesses) {
      this.renderHarnessRow(list, h, defaultId, harnesses.length);
    }
  }

  /** The add-a-harness form: name + command (must contain {prompt}) + optional
   *  resume command. Reuses the shared form styling. */
  private renderAddHarnessForm(c: HTMLElement): void {
    const form = c.createDiv({ cls: "skill-layer-script-form" });
    form.createEl("div", { cls: "skill-layer-script-form-title", text: "Add a harness" });

    const nameInput = form.createEl("input", {
      cls: "skill-layer-script-name",
      attr: { type: "text", placeholder: "Name (e.g. ucode claude)", "aria-label": "Harness name" },
    });
    const cmdInput = form.createEl("input", {
      cls: "skill-layer-script-name",
      attr: {
        type: "text",
        placeholder: "/usr/local/bin/claude -p {prompt}",
        "aria-label": "Harness command (absolute binary, must contain {prompt})",
      },
    });
    const resumeInput = form.createEl("input", {
      cls: "skill-layer-script-name",
      attr: {
        type: "text",
        placeholder: "Resume command (optional) — e.g. /usr/local/bin/claude --resume",
        "aria-label": "Resume command",
      },
    });

    const controls = form.createDiv({ cls: "skill-layer-script-controls" });
    const add = controls.createEl("button", {
      cls: "skill-layer-action skill-layer-action-launch",
      text: "Add harness",
    });
    add.addEventListener("click", () => {
      void this.submitAddHarness(nameInput, cmdInput, resumeInput);
    });

    // Register-by-prompt, below the Add button: a sentence with an inline Copy
    // button (copies a prompt the user runs in their coding agent so it adds
    // itself as a harness) and an inline Refresh button (reloads data.json to pick
    // up what the agent just wrote).
    const register = form.createDiv({ cls: "skill-layer-harness-register" });
    register.createSpan({ text: "Or copy" });
    const copyBtn = register.createEl("button", {
      cls: "skill-layer-action",
      attr: { "aria-label": "Copy the self-registration prompt", title: "Copy prompt" },
    });
    setIcon(copyBtn.createSpan({ cls: "skill-layer-action-icon" }), "copy");
    copyBtn.addEventListener("click", () => {
      void (async () => {
        try {
          await navigator.clipboard.writeText(this.plugin.harnessRegistrationPrompt());
          new Notice("Copied the self-registration prompt.");
        } catch {
          new Notice("Skill and Harness Manager: copy failed.");
        }
      })();
    });
    register.createSpan({
      text: "the prompt to your agent to have it register itself",
    });
    const refreshBtn = register.createEl("button", {
      cls: "skill-layer-action",
      attr: { "aria-label": "Refresh harnesses from disk", title: "Refresh" },
    });
    setIcon(refreshBtn.createSpan({ cls: "skill-layer-action-icon" }), "refresh-cw");
    refreshBtn.addEventListener("click", () => {
      void (async () => {
        await this.plugin.reloadSettingsFromDisk();
        this.renderActiveTab();
      })();
    });
  }

  /** Add the harness, then apply its resume command (if given) and re-render. */
  private async submitAddHarness(
    nameInput: HTMLInputElement,
    cmdInput: HTMLInputElement,
    resumeInput: HTMLInputElement,
  ): Promise<void> {
    const err = await this.plugin.addCustomHarness(nameInput.value, cmdInput.value);
    if (err) {
      new Notice(`Skill and Harness Manager: ${err}`);
      return;
    }
    // addCustomHarness appended the new harness last; set its resume if provided.
    const added = this.plugin.getCustomHarnesses().slice(-1)[0];
    const resume = resumeInput.value.trim();
    if (added && resume) {
      const rErr = await this.plugin.setCustomHarnessResume(added.id, resume);
      if (rErr) new Notice(`Skill and Harness Manager: ${rErr}`);
    }
    this.renderActiveTab();
  }

  /** One harness row: name (+ default badge), command, an editable resume command,
   *  Set-as-default (only with 2+ harnesses and not already the default), Remove. */
  private renderHarnessRow(
    parent: HTMLElement,
    h: CustomHarness,
    defaultId: string,
    count: number,
  ): void {
    const el = parent.createDiv({ cls: "skill-layer-row" });
    const main = el.createDiv({ cls: "skill-layer-row-main" });
    const nameLine = main.createDiv({ cls: "skill-layer-row-nameline" });
    nameLine.createSpan({ text: h.label, cls: "skill-layer-row-name" });
    if (h.id === defaultId) {
      nameLine.createSpan({ text: "default", cls: "skill-layer-row-badge" });
    }
    main.createDiv({ cls: "skill-layer-row-path", text: h.command.join(" ") });

    // Editable resume command — what the Sessions tab's Connect runs to reconnect.
    const resumeInput = main.createEl("input", {
      cls: "skill-layer-script-name",
      attr: {
        type: "text",
        placeholder: "Resume command (optional) — e.g. /usr/local/bin/claude --resume",
        "aria-label": `Resume command for ${h.label}`,
      },
    });
    resumeInput.value = (h.resumeCommand ?? []).join(" ");
    resumeInput.addEventListener("change", () => {
      void (async () => {
        const err = await this.plugin.setCustomHarnessResume(h.id, resumeInput.value);
        if (err) new Notice(`Skill and Harness Manager: ${err}`);
      })();
    });

    const actions = el.createDiv({ cls: "skill-layer-row-actions" });
    if (count > 1 && h.id !== defaultId) {
      const setDef = actions.createEl("button", {
        cls: "skill-layer-action",
        text: "Set as default",
      });
      setDef.addEventListener("click", () => {
        void (async () => {
          await this.plugin.setDefaultHarness(h.id);
          this.renderActiveTab();
        })();
      });
    }
    const del = actions.createEl("button", {
      cls: "skill-layer-action",
      attr: { "aria-label": `Remove ${h.label}` },
    });
    setIcon(del.createSpan({ cls: "skill-layer-action-icon" }), "trash");
    del.createSpan({ text: " Remove" });
    del.addEventListener("click", () => {
      void (async () => {
        await this.plugin.removeCustomHarness(h.id);
        this.renderActiveTab();
      })();
    });
  }

  private renderList(): void {
    const container = this.listEl;
    if (!container) return;
    container.empty();

    const { items: all, noun } = this.browsing;
    const kind: "skill" | "command" = this.activeTab === "commands" ? "command" : "skill";
    const unfiltered = !this.filter && !this.hasActiveFacets();

    const skills = all.filter((s) => this.matches(s));

    // Group by source folder, rendered as a collapsible tree that mirrors
    // Obsidian's file explorer.
    const groups = new Map<string, Skill[]>();
    for (const s of skills) {
      const g = groups.get(s.sourceLabel) ?? [];
      g.push(s);
      groups.set(s.sourceLabel, g);
    }
    // When unfiltered, also surface tool folders that EXIST on disk but hold no
    // items yet (e.g. a folder the user just added) so each has a section with a
    // per-section "+" to add its first skill/command.
    if (unfiltered) {
      for (const seg of this.plugin.existingToolFolders(kind)) {
        if (!groups.has(seg)) groups.set(seg, []);
      }
    }

    if (groups.size === 0) {
      this.renderEmptyState(
        container,
        all.length === 0
          ? `No ${noun}s found yet. Use “+ Add folder” below to create one.`
          : `No ${noun}s match the current filters.`,
      );
      // Still show the add/remove folder controls below the empty state.
      if (unfiltered) this.renderAddFolderRow(container, kind);
      return;
    }

    for (const label of Array.from(groups.keys()).sort()) {
      const items = groups.get(label) ?? [];
      const collapsed = !this.expandedGroups.has(label); // default-closed
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
        if (collapsed) this.expandedGroups.add(label);
        else this.expandedGroups.delete(label);
        this.renderList();
      });
      // Per-section "+": create a new skill/command in THIS tool folder. Only for
      // real tool-folder groups (a segment we know how to create into).
      if (this.plugin.addableFolderSegments(kind).includes(label)) {
        const add = title.createSpan({
          cls: "skill-layer-tree-add",
          attr: {
            "aria-label": `Add a ${noun} in ${label}`,
            title: `Add a ${noun} in ${label}`,
            role: "button",
            tabindex: "0",
          },
        });
        setIcon(add.createSpan({ cls: "skill-layer-tree-add-icon" }), "plus");
        add.createSpan({ text: `Add a ${noun}` });
        const onAdd = (e: Event) => {
          e.stopPropagation(); // don't toggle the folder collapse
          this.promptCreateItem(kind, label);
        };
        add.addEventListener("click", onAdd);
        add.addEventListener("keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onAdd(e);
          }
        });
      }

      if (!collapsed) {
        const children = folder.createDiv({ cls: "skill-layer-tree-children" });
        if (items.length === 0) {
          children.createDiv({
            cls: "skill-layer-tree-empty",
            text: `No ${noun}s here yet — use + to add one.`,
          });
        }
        for (const skill of items) this.renderRow(children, skill);
      }
    }

    // Bottom folder controls: "Add a … folder" + "Remove a … folder".
    if (unfiltered) this.renderAddFolderRow(container, kind);
  }

  /** True when any multi-select facet filter is active (affects add-affordance visibility). */
  private hasActiveFacets(): boolean {
    return (
      this.filterAgents.size > 0 ||
      this.filterHarnesses.size > 0 ||
      this.filterTags.size > 0 ||
      this.filterAccess.size > 0
    );
  }

  /**
   * The folder controls above the tab-footer divider: "Add a <kind> folder" and,
   * when there's something removable, "Remove a <kind> folder" — both pill buttons
   * that open a chooser menu. Add offers the prescanned tool folders (+ external
   * picker); Remove offers the existing tool folders (deleted if empty) and any
   * user-added external scan roots.
   */
  private renderAddFolderRow(container: HTMLElement, kind: "skill" | "command"): void {
    const existing = this.plugin.existingToolFolders(kind);
    const existingSet = new Set(existing);
    const addable = this.plugin.addableFolderSegments(kind).filter((s) => !existingSet.has(s));
    const canAddExternal = this.plugin.canScanExternal();
    const canAdd = addable.length > 0 || canAddExternal;
    const removableRoots = this.plugin.getRemovableScanRoots();
    const canRemove = existing.length > 0 || removableRoots.length > 0;
    if (!canAdd && !canRemove) return;

    const row = container.createDiv({ cls: "skill-layer-addfolder" });
    if (canAdd) {
      const onAdd = () => this.promptAddFolder(addable, canAddExternal);
      this.makeFolderButton(row, `Add a ${kind} folder`, "plus", onAdd);
    }
    if (canRemove) {
      const onRemove = () => this.promptRemoveFolder(existing, removableRoots);
      this.makeFolderButton(row, `Remove a ${kind} folder`, "minus", onRemove);
    }
  }

  /** A pill button (click + keyboard) for the folder-controls row. */
  private makeFolderButton(
    row: HTMLElement,
    label: string,
    icon: string,
    onClick: () => void,
  ): void {
    const btn = row.createEl("div", {
      cls: "skill-layer-tree-add",
      attr: { "aria-label": label, title: label, role: "button", tabindex: "0" },
    });
    setIcon(btn.createSpan({ cls: "skill-layer-tree-add-icon" }), icon);
    btn.createSpan({ text: label });
    btn.addEventListener("click", onClick);
    btn.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    });
  }

  /**
   * Chooser for removing a folder: the existing tool folders for this kind (each
   * deleted from disk only when empty — a non-empty folder is refused with a
   * Notice so skills/commands are never lost) followed by any user-added external
   * scan roots (removed from the scan list, files untouched).
   */
  private promptRemoveFolder(
    toolFolders: string[],
    roots: ReturnType<SkillLayerPlugin["getRemovableScanRoots"]>,
  ): void {
    const menu = new Menu();
    for (const seg of toolFolders) {
      menu.addItem((item) =>
        item
          .setTitle(seg)
          .setIcon("folder")
          .onClick(async () => {
            const err = await this.plugin.removeToolFolder(seg);
            if (err) new Notice(`Skill and Harness Manager: ${err}`);
          }),
      );
    }
    if (toolFolders.length > 0 && roots.length > 0) menu.addSeparator();
    for (const r of roots) {
      const label = r.path === "" ? "(vault root)" : r.path;
      menu.addItem((item) =>
        item
          .setTitle(label)
          .setIcon("folder-x")
          .onClick(async () => {
            await this.plugin.removeScanRoot(r);
            new Notice(`Skill and Harness Manager: removed scan root ${label}`);
          }),
      );
    }
    menu.showAtMouseEvent(
      (activeWindow.event as MouseEvent) ?? new MouseEvent("click"),
    );
  }

  /**
   * Show a chooser of prescanned tool folders (creating one adds an empty
   * section), followed — on desktop — by an "Open file explorer…" option that
   * opens the OS folder picker and adds the chosen folder as an external scan
   * root. This is the easy path for pointing the plugin at a skills folder that
   * lives OUTSIDE the vault (e.g. ~/.claude/skills).
   */
  private promptAddFolder(segments: string[], canAddExternal: boolean): void {
    const menu = new Menu();
    for (const seg of segments) {
      menu.addItem((item) =>
        item
          .setTitle(seg)
          .setIcon("folder")
          .onClick(async () => {
            const err = await this.plugin.createToolFolder(seg);
            if (err) new Notice(`Skill and Harness Manager: ${err}`);
          }),
      );
    }
    if (canAddExternal) {
      if (segments.length > 0) menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Open file explorer…")
          .setIcon("folder-open")
          .onClick(() => {
            this.plugin.pickExternalFolder((abs) => {
              void (async () => {
                const err = await this.plugin.addExternalScanRoot(abs);
                if (err) new Notice(`Skill and Harness Manager: ${err}`);
                else new Notice(`Skill and Harness Manager: added scan root ${abs}`);
              })();
            });
          }),
      );
    }
    // Anchor near the button: show at the current mouse position.
    menu.showAtMouseEvent(
      (activeWindow.event as MouseEvent) ?? new MouseEvent("click"),
    );
  }

  /** Prompt for a name, then create a skill/command in `folderSeg` and open it. */
  private promptCreateItem(kind: "skill" | "command", folderSeg: string): void {
    new PromptModal(this.app, {
      title: `New ${kind} in ${folderSeg}`,
      placeholder: kind === "command" ? "command-name" : "skill-name",
      cta: "Create",
      onSubmit: async (name) => {
        const err =
          kind === "command"
            ? await this.plugin.createCommandInFolder(folderSeg, name)
            : await this.plugin.createSkillInFolder(folderSeg, name);
        if (err) new Notice(`Skill and Harness Manager: ${err}`);
      },
    }).open();
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
      const sel = this.filterAccess.has("selection") && this.plugin.isEditorMenuEnabled(s.id);
      const pin = this.filterAccess.has("ribbon") && this.plugin.isPinned(s.id);
      if (!rc && !sel && !pin) return false;
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
    // Agent source depends on the harness (M17): a skill running through a custom
    // harness uses Claude subagents (.claude/agents); otherwise its stored agent.
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
