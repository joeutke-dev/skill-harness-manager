import { App, Modal, Setting } from "obsidian";
import {
  AGENT_DEFAULT_VALUE,
  BUILTIN_AGENTS,
  encodeCustomHarnessChoice,
  HARNESS_DEFAULT_VALUE,
} from "./launch";
import type SkillLayerPlugin from "./main";
import { Skill } from "./types";

/**
 * Per-skill CONFIGURATION modal — the ⚙ on a Skills-tab row (M16). This
 * consolidates the secondary controls that used to crowd every row (Copy
 * invocation, the right-click-menu toggle, the "Run with" agent selector, the
 * omnigent/custom Harness selector, and ribbon pinning/icon) into one popup, so
 * the row itself carries only the two primary actions (Launch + Open file) plus
 * this gear. Every control here drives the SAME plugin methods the inline
 * controls did — each already persists + re-validates fail-closed and refreshes
 * the underlying list view — so this is purely a relocation of the UI, no new
 * behavior. Each mutation re-renders the modal body so the toggle/pin labels
 * stay in sync while the popup is open.
 */
export class SkillConfigModal extends Modal {
  private plugin: SkillLayerPlugin;
  private skill: Skill;

  constructor(app: App, plugin: SkillLayerPlugin, skill: Skill) {
    super(app);
    this.plugin = plugin;
    this.skill = skill;
  }

  onOpen(): void {
    this.titleEl.setText(`Configure “${this.skill.name}”`);
    this.modalEl.addClass("skill-layer-config-modal");
    this.renderBody();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** (Re)build the settings list; called on open and after each mutation. */
  private renderBody(): void {
    const c = this.contentEl;
    c.empty();
    const skill = this.skill;

    // Order (M16): Harness → Agent → Add to Ribbon → right-click → Copy.

    // 1) Per-skill HARNESS (M15). Omnigent harnesses are labelled "omnigent - X"
    // to distinguish them from user-defined custom harnesses.
    new Setting(c)
      .setName("Harness")
      .setDesc("Pin a specific harness. Default uses omnigent's own configured harness.")
      .addDropdown((d) => {
        d.addOption(HARNESS_DEFAULT_VALUE, "Default");
        for (const name of this.plugin.getOmnigentHarnessOptions()) {
          d.addOption(name, `omnigent - ${name}`);
        }
        for (const h of this.plugin.getCustomHarnesses()) {
          d.addOption(encodeCustomHarnessChoice(h.id), h.label);
        }
        d.setValue(this.plugin.harnessOptionValue(skill.id));
        d.onChange(async (v) => {
          await this.plugin.setSkillHarness(skill.id, v);
          // The Agent selector's availability depends on this — re-render.
          this.renderBody();
        });
      });

    // 2) Per-skill AGENT — the source depends on the harness (M17):
    //   • custom (claude) harness → Claude subagents from `.claude/agents`,
    //     passed via the command's `{agent}` token.
    //   • Default / omnigent harness → omnigent YAML agents (polly/debby/bundles),
    //     passed as the `omnigent run` positional.
    const customHarness = this.plugin.skillUsesCustomHarness(skill.id);
    if (customHarness) {
      const claudeAgents = this.plugin.getClaudeAgents();
      const note = claudeAgents.length
        ? "Claude subagent (.claude/agents) to run as. Needs an {agent} token in the harness command."
        : "No .claude/agents subagents found. Add one, then Rescan.";
      new Setting(c)
        .setName("Agent")
        .setDesc(note)
        .addDropdown((d) => {
          d.addOption("", "Default");
          for (const a of claudeAgents) d.addOption(a.name, a.name);
          d.setValue(this.plugin.claudeAgentOptionValue(skill.id));
          d.onChange(async (v) => {
            await this.plugin.setSkillClaudeAgent(skill.id, v);
          });
        });
    } else {
      new Setting(c)
        .setName("Agent")
        .setDesc("Which omnigent agent runs this skill.")
        .addDropdown((d) => {
          d.addOption(AGENT_DEFAULT_VALUE, "Default");
          for (const name of BUILTIN_AGENTS) d.addOption(`builtin:${name}`, name);
          for (const agent of this.plugin.getCustomAgents()) {
            d.addOption(`custom:${agent.path}`, agent.name);
          }
          d.setValue(this.plugin.agentOptionValue(skill.id));
          d.onChange(async (v) => {
            await this.plugin.setSkillAgent(skill.id, v);
          });
        });
    }

    // 3) Add to Ribbon (pin) + per-skill icon.
    const pinned = this.plugin.isPinned(skill.id);
    const ribbon = new Setting(c)
      .setName("Add to Ribbon")
      .setDesc(
        pinned
          ? "Pinned to the ribbon for one-click launch. Change its icon or unpin."
          : "Pin this skill to the left ribbon for one-click launch.",
      );
    if (pinned) {
      ribbon.addExtraButton((b) =>
        b
          .setIcon(this.plugin.iconFor(skill.id))
          .setTooltip("Change ribbon icon")
          .onClick(() => this.plugin.openIconPicker(skill, () => this.renderBody())),
      );
      ribbon.addButton((b) =>
        b.setButtonText("Unpin").onClick(async () => {
          await this.plugin.unpinById(skill.id);
          this.renderBody();
        }),
      );
    } else {
      ribbon.addButton((b) =>
        b
          .setButtonText("Add to Ribbon")
          .onClick(() => this.plugin.requestPin(skill, () => this.renderBody())),
      );
    }

    // 4) Right-click (file-menu) toggle (M3).
    const rcOn = this.plugin.isRightClickEnabled(skill.id);
    new Setting(c)
      .setName("Add to right-click menu")
      .setDesc(
        `Show “Run "${skill.name}" here” in the file-explorer right-click menu.`,
      )
      .addToggle((t) =>
        t.setValue(rcOn).onChange(async () => {
          await this.plugin.toggleRightClick(skill);
          this.renderBody();
        }),
      );

    // 5) Copy invocation — clipboard only (the natural-language run prompt).
    new Setting(c)
      .setName("Copy invocation")
      .setDesc("Copy the command to run this skill to the clipboard.")
      .addButton((b) =>
        b.setButtonText("Copy").onClick(() => void this.plugin.copyInvocation(skill)),
      );
  }
}

/**
 * LAUNCH modal — opened by the Launch button on a Skills-tab row (M16). Instead
 * of firing a bare `Use the <name> skill.`, this lets the user add free-text
 * context first, so the session receives `Use the <name> skill. <their text>`
 * and can actually do something useful for skills that need more input. The
 * textarea is OPTIONAL: launching with it empty reproduces the previous
 * one-click behavior exactly. The text is passed to `launchSkill` as the
 * `userPrompt` arg and reaches argv only inside the single inert `-p` element.
 */
export class LaunchModal extends Modal {
  private plugin: SkillLayerPlugin;
  private skill: Skill;

  constructor(app: App, plugin: SkillLayerPlugin, skill: Skill) {
    super(app);
    this.plugin = plugin;
    this.skill = skill;
  }

  onOpen(): void {
    const skill = this.skill;
    this.titleEl.setText(`Run “${skill.name}”`);
    this.modalEl.addClass("skill-layer-config-modal");
    const c = this.contentEl;

    c.createEl("p", {
      cls: "skill-layer-launch-hint",
      text: `Sends “Use the ${skill.name} skill.” Add any extra context or instructions below (optional) and it will be appended to the prompt.`,
    });

    const ta = c.createEl("textarea", {
      cls: "skill-layer-launch-input",
      attr: {
        rows: "5",
        placeholder:
          "e.g. focus on the 7-Eleven account and include action items",
        "aria-label": `Extra prompt for ${skill.name}`,
      },
    });
    window.setTimeout(() => ta.focus(), 0);
    ta.addEventListener("keydown", (e) => {
      // ⌘/Ctrl+Enter launches; plain Enter stays a newline (free-text prompt).
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit(ta.value);
      }
    });

    const buttons = new Setting(c);
    buttons.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    buttons.addButton((b) =>
      b
        .setButtonText("Run skill")
        .setCta()
        .setTooltip("⌘/Ctrl + Enter")
        .onClick(() => this.submit(ta.value)),
    );
  }

  private submit(text: string): void {
    this.close();
    void this.plugin.launchSkill(this.skill, undefined, text);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Per-agent CONFIGURATION modal — the ⚙ on an Agents-tab row (M16). The Agents
 * row keeps its two primary actions (Launch session + Open file); its only
 * secondary control, Copy invocation, moves here for consistency with the
 * Skills tab. Drives the same plugin method as before.
 */
export class AgentConfigModal extends Modal {
  private plugin: SkillLayerPlugin;
  private agentPath: string;
  private agentName: string;

  constructor(app: App, plugin: SkillLayerPlugin, agentPath: string, agentName: string) {
    super(app);
    this.plugin = plugin;
    this.agentPath = agentPath;
    this.agentName = agentName;
  }

  onOpen(): void {
    this.titleEl.setText(`Configure “${this.agentName}”`);
    this.modalEl.addClass("skill-layer-config-modal");
    new Setting(this.contentEl)
      .setName("Copy invocation")
      .setDesc("Copy the omnigent command to start a session with this agent.")
      .addButton((b) =>
        b
          .setButtonText("Copy")
          .onClick(() => void this.plugin.copyCustomAgentInvocation(this.agentPath)),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
