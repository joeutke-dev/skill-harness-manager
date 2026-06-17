import { App, FuzzySuggestModal, FuzzyMatch, getIconIds, setIcon } from "obsidian";

/**
 * Searchable Lucide icon picker built on Obsidian's bundled icon set
 * (`getIconIds` / `setIcon`) — no extra dependency, no icon font bundled.
 * Each suggestion previews the glyph next to its id.
 */
export class IconPickerModal extends FuzzySuggestModal<string> {
  private onChoose: (iconId: string) => void;

  constructor(app: App, currentIcon: string | undefined, onChoose: (iconId: string) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Search Lucide icons by name…");
    if (currentIcon) this.setInstructions([{ command: "current", purpose: `#${currentIcon}` }]);
  }

  getItems(): string[] {
    // All icon ids registered with the app (Lucide + any plugin-registered).
    return getIconIds();
  }

  getItemText(item: string): string {
    return item;
  }

  renderSuggestion(match: FuzzyMatch<string>, el: HTMLElement): void {
    el.addClass("skill-layer-icon-suggestion");
    const glyph = el.createSpan({ cls: "skill-layer-icon-glyph" });
    setIcon(glyph, match.item);
    el.createSpan({ cls: "skill-layer-icon-name", text: match.item });
  }

  onChooseItem(item: string): void {
    this.onChoose(item);
  }
}
