import { App, Modal, Notice, Setting } from "obsidian";
import type SkillLayerPlugin from "./main";
import {
  ALL_DAYS,
  describeTrigger,
  newScheduleId,
  parseHHMM,
  Schedule,
  ScheduleTask,
  ScheduleTrigger,
  Weekday,
  WEEKDAYS,
} from "./schedules";
import { Skill } from "./types";

type TriggerKind = ScheduleTrigger["kind"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Local "YYYY-MM-DDTHH:MM" for a datetime-local input. */
function toLocalInput(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parse a datetime-local value as LOCAL time; NaN when invalid. */
function fromLocalInput(v: string): number {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

/**
 * Create / edit a schedule — styled like the skill ⚙ Configure popup: a flat
 * list of rows, each a name + one-line description + control. Two task types (a
 * skill, or a free prompt that names any skills itself) and two triggers:
 * Recurring (a time on chosen days) or Once (a later date and time). Scheduled
 * runs are always headless and catch up once if missed. Pause / delete live on
 * the Schedules-tab row. Saved through `plugin.saveSchedule`, which owns the
 * cursor / one-shot bookkeeping.
 */
export class ScheduleModal extends Modal {
  private plugin: SkillLayerPlugin;
  private isNew: boolean;
  private draft: Schedule;
  // Per-kind trigger fields, kept while the user flips between trigger kinds.
  private onceAt: number;
  private weeklyTime = "08:00";
  private weeklyDays: Weekday[] = [...WEEKDAYS];
  private triggerKind: TriggerKind;
  // Per-kind task fields.
  private taskKind: ScheduleTask["kind"];
  private skillId = "";
  private skillPrompt = "";
  private prompt = "";
  private harnessId = "";

  constructor(app: App, plugin: SkillLayerPlugin, existing?: Schedule, skill?: Skill) {
    super(app);
    this.plugin = plugin;
    this.isNew = !existing;
    const now = Date.now();
    const nextHour = Math.ceil((now + 60_000) / 3_600_000) * 3_600_000;
    this.onceAt = nextHour;
    const fresh: Schedule = {
      id: newScheduleId(now),
      name: skill ? skill.name : "",
      enabled: true,
      task: skill
        ? { kind: "skill", skillId: skill.id, skillName: skill.name, itemKind: skill.kind ?? "skill" }
        : { kind: "skill", skillId: "", skillName: "" },
      trigger: { kind: "weekly", time: "08:00", days: [...WEEKDAYS] },
      createdAt: now,
      cursor: now,
      runs: [],
    };
    this.draft = existing
      ? { ...existing, task: { ...existing.task } as ScheduleTask, trigger: { ...existing.trigger } as ScheduleTrigger }
      : fresh;
    // Unpack the draft into the per-kind fields.
    const t = this.draft.trigger;
    this.triggerKind = t.kind;
    if (t.kind === "once") this.onceAt = t.at;
    else {
      this.weeklyTime = t.time;
      this.weeklyDays = [...t.days];
    }
    const k = this.draft.task;
    this.taskKind = k.kind;
    if (k.kind === "skill") {
      this.skillId = k.skillId;
      this.skillPrompt = k.prompt ?? "";
    } else {
      this.prompt = k.prompt;
      this.harnessId = k.harnessId ?? "";
    }
  }

  onOpen(): void {
    this.titleEl.setText(this.isNew ? "New schedule" : `Edit “${this.draft.name}”`);
    this.modalEl.addClass("skill-layer-config-modal", "skill-layer-schedule-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** All runnable items (skills + commands), sorted by name. */
  private items(): Skill[] {
    return [...this.plugin.getSkills(), ...this.plugin.getCommands()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    const items = this.items();

    new Setting(c)
      .setName("Name")
      .setDesc("How it shows in the Schedules tab.")
      .addText((t) =>
        t
          .setPlaceholder("Morning daily note")
          .setValue(this.draft.name)
          .onChange((v) => (this.draft.name = v)),
      );

    new Setting(c)
      .setName("Runs")
      .setDesc(this.taskKind === "skill" ? "One of your skills or commands." : "Your own prompt.")
      .addDropdown((d) => {
        d.addOption("skill", "A skill");
        d.addOption("prompt", "A prompt");
        d.setValue(this.taskKind);
        d.onChange((v) => {
          this.taskKind = v === "prompt" ? "prompt" : "skill";
          this.render();
        });
      });

    if (this.taskKind === "skill") {
      new Setting(c)
        .setName("Skill")
        .setDesc("Runs headless in the background.")
        .addDropdown((d) => {
          d.addOption("", "Choose…");
          for (const it of items) {
            d.addOption(it.id, it.kind === "command" ? `/${it.name}` : it.name);
          }
          // A schedule whose skill moved/vanished still shows its stored name.
          if (this.skillId && !items.some((x) => x.id === this.skillId) && this.draft.task.kind === "skill") {
            d.addOption(this.skillId, `${this.draft.task.skillName} (not found)`);
          }
          d.setValue(this.skillId);
          d.onChange((v) => {
            this.skillId = v;
            const it = items.find((x) => x.id === v);
            if (it && !this.draft.name.trim()) {
              this.draft.name = it.name;
              this.render();
            }
          });
        });
      this.textArea(c, "Extra instructions", "Optional. Added after the skill name.", this.skillPrompt, 3, "", (v) => (this.skillPrompt = v));
    } else {
      this.textArea(
        c,
        "Prompt",
        "Name any skill to use in it. Line breaks are kept.",
        this.prompt,
        7,
        "Use the gmail skill to send an email to … with this body:\n\nHi …",
        (v) => (this.prompt = v),
      );
      new Setting(c)
        .setName("Harness")
        .setDesc("Runs headless in the background. Default uses your default harness.")
        .addDropdown((d) => {
          const def = this.plugin.resolveDefaultHarness();
          d.addOption("", def ? `Default (${def.label})` : "Default (none set)");
          for (const h of this.plugin.getScheduleHarnessOptions()) d.addOption(h.id, h.label);
          d.setValue(this.harnessId);
          d.onChange((v) => (this.harnessId = v));
        });
    }

    new Setting(c)
      .setName("When")
      .setDesc(
        this.triggerKind === "weekly"
          ? "Repeats on the days you pick. Missed runs catch up when you're back."
          : "Runs one time. If the laptop is asleep then, it runs when you're back.",
      )
      .addDropdown((d) => {
        d.addOption("weekly", "Recurring");
        d.addOption("once", "Once");
        d.setValue(this.triggerKind);
        d.onChange((v) => {
          this.triggerKind = v === "once" ? "once" : "weekly";
          this.render();
        });
      });

    if (this.triggerKind === "once") {
      new Setting(c).setName("Date and time").addText((t) => {
        t.inputEl.type = "datetime-local";
        t.setValue(toLocalInput(this.onceAt)).onChange((v) => {
          const n = fromLocalInput(v);
          if (Number.isFinite(n)) this.onceAt = n;
        });
      });
    } else {
      new Setting(c).setName("Time").addText((t) => {
        t.inputEl.type = "time";
        t.setValue(this.weeklyTime).onChange((v) => {
          if (parseHHMM(v)) this.weeklyTime = v;
        });
      });
      const days = new Setting(c).setName("Days");
      const row = days.controlEl.createDiv({ cls: "skill-layer-schedule-days" });
      for (const d of ALL_DAYS) {
        const on = this.weeklyDays.includes(d);
        const b = row.createEl("button", {
          cls: "skill-layer-schedule-day" + (on ? " is-on" : ""),
          text: DAY_LETTERS[d],
          attr: { "aria-label": DAY_NAMES[d], "aria-pressed": String(on) },
        });
        b.addEventListener("click", () => {
          this.weeklyDays = on ? this.weeklyDays.filter((x) => x !== d) : [...this.weeklyDays, d];
          this.render();
        });
      }
    }

    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b
          .setButtonText(this.isNew ? "Create schedule" : "Save")
          .setCta()
          .onClick(() => void this.save()),
      );
  }

  /** A full-width textarea row (name + description above, text below). */
  private textArea(
    c: HTMLElement,
    name: string,
    desc: string,
    value: string,
    rows: number,
    placeholder: string,
    onChange: (v: string) => void,
  ): void {
    new Setting(c)
      .setName(name)
      .setDesc(desc)
      .setClass("skill-layer-schedule-textrow")
      .addTextArea((t) => {
        t.setPlaceholder(placeholder).setValue(value).onChange(onChange);
        t.inputEl.rows = rows;
        t.inputEl.addClass("skill-layer-schedule-textarea");
      });
  }

  /** Validate the form into a Schedule and save it; Notices on problems. */
  private async save(): Promise<void> {
    let trigger: ScheduleTrigger;
    if (this.triggerKind === "once") {
      if (!(this.onceAt > Date.now())) {
        new Notice("Pick a date and time in the future.");
        return;
      }
      trigger = { kind: "once", at: this.onceAt };
    } else {
      if (!parseHHMM(this.weeklyTime) || this.weeklyDays.length === 0) {
        new Notice("Pick a time and at least one day.");
        return;
      }
      trigger = { kind: "weekly", time: this.weeklyTime, days: [...this.weeklyDays].sort() as Weekday[] };
    }

    let task: ScheduleTask;
    if (this.taskKind === "skill") {
      const it = this.items().find((x) => x.id === this.skillId);
      const prev = this.draft.task.kind === "skill" ? this.draft.task : null;
      if (!this.skillId || (!it && prev?.skillId !== this.skillId)) {
        new Notice("Choose a skill to run.");
        return;
      }
      const extra = this.skillPrompt.trim();
      task = {
        kind: "skill",
        skillId: this.skillId,
        skillName: it?.name ?? prev?.skillName ?? "",
        itemKind: it?.kind ?? prev?.itemKind ?? "skill",
        prompt: extra || undefined,
      };
    } else {
      if (!this.prompt.trim()) {
        new Notice("Write the prompt to run.");
        return;
      }
      if (!this.harnessId && !this.plugin.resolveDefaultHarness()) {
        new Notice("No default harness is set. Pick a harness, or set a default in the Config tab.");
        return;
      }
      task = { kind: "prompt", prompt: this.prompt, harnessId: this.harnessId || undefined };
    }

    const name = this.draft.name.trim() || (task.kind === "skill" ? task.skillName : "Scheduled prompt");
    await this.plugin.saveSchedule({ ...this.draft, name, task, trigger });
    new Notice(`${this.isNew ? "Scheduled" : "Saved"} “${name}”: ${describeTrigger(trigger)}.`);
    this.close();
  }
}
