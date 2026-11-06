import { App, Modal, Notice, Setting } from "obsidian";
import type SkillLayerPlugin from "./main";
import type { LaunchedSession } from "./sessions";
import { formatDuration, statusLabel } from "./sessionMonitor";

/**
 * Session DETAILS modal (Sessions tab → Details, or an alert's Details button):
 * status, the model's question or final reply, the recent steps it took, and the
 * stderr tail — with Copy reply, plus Connect once the run has ended. Refreshes
 * itself every 2s while the run is still going.
 */
export class SessionDetailsModal extends Modal {
  private plugin: SkillLayerPlugin;
  private session: LaunchedSession;
  private timer: number | null = null;

  constructor(app: App, plugin: SkillLayerPlugin, session: LaunchedSession) {
    super(app);
    this.plugin = plugin;
    this.session = session;
  }

  onOpen(): void {
    this.modalEl.addClass("skill-layer-config-modal", "skill-layer-session-modal");
    this.render();
    // While the run is live, refresh every 2s (keeping the scroll position).
    this.timer = window.setInterval(() => {
      if (!this.plugin.isSessionLive(this.session) && !this.wasLive) return;
      const top = this.modalEl.scrollTop;
      this.render();
      this.modalEl.scrollTop = top;
    }, 2000);
  }

  /** True on the render where the run was still live (one more render after it ends). */
  private wasLive = false;

  private render(): void {
    const s = this.session;
    const live = this.plugin.isSessionLive(s);
    this.wasLive = live;
    const d = this.plugin.describeSession(s);
    const { state, stderr } = this.plugin.readSessionDetails(s);
    this.titleEl.setText(`“${s.skillName}” session${live ? " · live" : ""}`);
    const c = this.contentEl;
    c.empty();

    const head = c.createDiv({ cls: "skill-layer-session-head" });
    head.createSpan({
      cls: `skill-layer-status-pill mod-${d.status}`,
      text: statusLabel(d.status),
    });
    if (d.longRunning) {
      head.createSpan({ cls: "skill-layer-status-pill mod-long-running", text: "Long-running" });
    }
    head.createSpan({ cls: "skill-layer-session-detail", text: d.detail });

    const facts: Array<[string, string]> = [
      ["Harness", s.harnessLabel ?? s.tool],
      ["Started", new Date(s.startedAt).toLocaleString()],
      [
        d.finished ? "Ran for" : "Running for",
        formatDuration((s.endedAt ?? Date.now()) - s.startedAt),
      ],
    ];
    const sid = s.sessionId ?? state.sessionId;
    if (sid) facts.push(["Session ID", sid]);
    const r = state.result;
    const turns = r?.numTurns ?? s.outcome?.numTurns;
    const cost = r?.costUsd ?? s.outcome?.costUsd;
    if (turns !== undefined) facts.push(["Turns", String(turns)]);
    if (cost !== undefined) facts.push(["Cost", `$${cost.toFixed(2)}`]);
    const dl = c.createEl("dl", { cls: "skill-layer-session-facts" });
    for (const [k, v] of facts) {
      dl.createEl("dt", { text: k });
      dl.createEl("dd", { text: v });
    }

    const reply = r?.text || s.outcome?.resultText || state.lastText || "";
    if (d.status === "needs-input" && d.question) {
      c.createEl("h4", { text: "What it needs from you" });
      c.createDiv({ cls: "skill-layer-session-question", text: d.question });
    }
    if (reply) {
      c.createEl("h4", { text: d.finished ? "Final reply" : "Latest message" });
      c.createEl("pre", { cls: "skill-layer-session-pre", text: reply });
    }
    if (state.steps.length > 0) {
      c.createEl("h4", { text: `Recent steps (${state.steps.length})` });
      const ol = c.createEl("ol", { cls: "skill-layer-session-steps" });
      for (const step of state.steps.slice(-15)) ol.createEl("li", { text: step });
    }
    if (stderr) {
      c.createEl("h4", { text: "Error output" });
      c.createEl("pre", { cls: "skill-layer-session-pre mod-stderr", text: stderr });
    }
    if (!s.logPath) {
      c.createEl("p", {
        cls: "skill-layer-launch-hint",
        text: "No output was captured for this session (it was launched in a terminal or before session tracking).",
      });
    }

    const buttons = new Setting(c);
    if (reply) {
      buttons.addButton((b) =>
        b.setButtonText("Copy reply").onClick(async () => {
          await navigator.clipboard.writeText(reply);
          new Notice("Copied the session's reply.");
        }),
      );
    }
    if (!live) {
      buttons.addButton((b) =>
        b
          .setButtonText("Connect")
          .setCta()
          .onClick(() => {
            this.close();
            this.plugin.openSessionTerminal(s);
          }),
      );
    }
  }

  onClose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.contentEl.empty();
  }
}
