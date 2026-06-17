import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type SkillLayerPlugin from "./main";
import { HarnessChoice, Skill } from "./types";

export const SKILL_LAYER_VIEW = "skill-layer-browser";

export class SkillBrowserView extends ItemView {
  private plugin: SkillLayerPlugin;
  private filter = "";
  /** Active tag filters (lowercased), AND-combined with the text filter. */
  private activeTags = new Set<string>();
  private listEl: HTMLElement | null = null;

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
    this.renderList();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Called by the plugin after a rescan / tag write so the view stays current. */
  refresh(): void {
    this.renderList();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("skill-layer-view");

    const header = root.createDiv({ cls: "skill-layer-header" });
    header.createEl("h3", { text: "Skill Layer", cls: "skill-layer-title" });

    const rescanBtn = header.createEl("button", {
      cls: "skill-layer-rescan",
      attr: { "aria-label": "Rescan skills" },
    });
    setIcon(rescanBtn, "refresh-cw");
    rescanBtn.createSpan({ text: "Rescan" });
    rescanBtn.addEventListener("click", async () => {
      await this.plugin.rescan();
      this.renderList();
    });

    const search = root.createEl("input", {
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

    this.listEl = root.createDiv({ cls: "skill-layer-list" });
    this.renderList();
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
      const empty = container.createDiv({ cls: "skill-layer-empty" });
      empty.setText(
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
      const x = chip.createSpan({ cls: "skill-layer-chip-x", text: "×" });
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
    nameLine.createSpan({
      text: skill.detection,
      cls: "skill-layer-row-badge",
    });

    main.createDiv({ cls: "skill-layer-row-desc", text: skill.description });
    main.createDiv({ cls: "skill-layer-row-path", text: skill.path });

    this.renderRowTags(main, skill);

    const actions = row.createDiv({ cls: "skill-layer-row-actions" });

    const openBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Open file",
    });
    openBtn.addEventListener("click", () => this.plugin.openSkill(skill));

    // Launch = spawn a one-shot omnigent run (UI-visible).
    const launchBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Launch",
    });
    launchBtn.addEventListener("click", () => this.plugin.launchSkill(skill));

    // Copy invocation = clipboard only (the pre-spawn behavior, kept).
    const copyBtn = actions.createEl("button", {
      cls: "skill-layer-action",
      text: "Copy invocation",
    });
    copyBtn.addEventListener("click", () => this.plugin.copyInvocation(skill));

    // Right-click menu toggle (M3): when enabled, this skill appears in the
    // file-explorer right-click as `Run "<name>" here` against the clicked file.
    const rcEnabled = this.plugin.isRightClickEnabled(skill.id);
    const rcBtn = actions.createEl("button", {
      cls: "skill-layer-action" + (rcEnabled ? " is-pinned" : ""),
      text: rcEnabled ? "✓ Right-click menu" : "Add to right-click menu",
      attr: {
        "aria-label": rcEnabled
          ? `Remove ${skill.name} from the file right-click menu`
          : `Add ${skill.name} to the file right-click menu`,
      },
    });
    rcBtn.addEventListener("click", async () => {
      await this.plugin.toggleRightClick(skill);
      this.renderList();
    });

    // Per-skill harness selector. Default "omnigent" preserves the global
    // behavior; "claude" launches via omnigent's Claude harness. Selecting a
    // value persists settings.skillHarness[skill.id] (the default deletes the
    // key to keep data.json clean) through the same saveSettings path.
    const harnessSel = actions.createEl("select", {
      cls: "skill-layer-action skill-layer-harness-select",
      attr: { "aria-label": `Harness for ${skill.name}` },
    }) as HTMLSelectElement;
    harnessSel.createEl("option", {
      text: "Harness: omnigent (default)",
      value: "omnigent",
    });
    harnessSel.createEl("option", {
      text: "Harness: claude",
      value: "claude",
    });
    harnessSel.value = this.plugin.harnessFor(skill.id);
    harnessSel.addEventListener("change", async () => {
      await this.plugin.setSkillHarness(
        skill.id,
        harnessSel.value as HarnessChoice,
      );
    });

    if (this.plugin.isPinned(skill.id)) {
      // Show the current glyph; clicking re-opens the picker to change it.
      const changeBtn = actions.createEl("button", {
        cls: "skill-layer-action is-pinned",
        attr: { "aria-label": `Change ribbon icon for ${skill.name}` },
      });
      const glyph = changeBtn.createSpan({ cls: "skill-layer-action-icon" });
      setIcon(glyph, this.plugin.iconFor(skill.id));
      changeBtn.createSpan({ text: " Change icon" });
      changeBtn.addEventListener("click", () => this.plugin.openIconPicker(skill));

      const unpinBtn = actions.createEl("button", {
        cls: "skill-layer-action",
        text: "Unpin",
      });
      unpinBtn.addEventListener("click", async () => {
        await this.plugin.unpinById(skill.id);
        this.renderList();
      });
    } else {
      // Pin: reuse a remembered icon immediately if it still resolves,
      // otherwise the picker opens (picking the icon IS the pin).
      const pinBtn = actions.createEl("button", {
        cls: "skill-layer-action",
        text: "Pin to ribbon",
      });
      pinBtn.addEventListener("click", () => this.plugin.requestPin(skill));
    }
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
        const x = chip.createSpan({ cls: "skill-layer-chip-x", text: "×" });
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
