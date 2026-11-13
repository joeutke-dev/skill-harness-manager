// Schedules — pure model + timing logic for the Schedules tab.
//
// Modelled on Databricks Jobs: a schedule is a TASK (run a skill, or run a free
// prompt) plus a TRIGGER — RECURRING (a time of day on chosen weekdays) or ONCE
// (a later date and time) — with Pause and a run history. Runs are always
// headless. Unlike Jobs, a run missed because the laptop was asleep (or Obsidian
// closed) is caught up once when you're back instead of silently skipped.
//
// The scheduler only runs while Obsidian is open. main.ts ticks every 30s; a gap
// between ticks much longer than that means the machine slept, which counts as a
// WAKE (as does Obsidian starting). Everything in this file is side-effect-free
// (no Obsidian, no timers, no fs) so the smoke suite can drive it with fake
// clocks. Times are LOCAL wall-clock (the user's timezone).

/** Day-of-week numbers as JS `Date#getDay()` (0 = Sunday). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const ALL_DAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** When a schedule fires. */
export type ScheduleTrigger =
  /** Recurring: at `time` (HH:MM, local) on the chosen weekdays — every day when all 7. */
  | { kind: "weekly"; time: string; days: Weekday[] }
  /** Once, at a later local date/time (epoch ms). */
  | { kind: "once"; at: number };

/** What a schedule runs. */
export type ScheduleTask =
  /** Run a discovered skill/command (by id; name kept to re-find it if moved). */
  | { kind: "skill"; skillId: string; skillName: string; itemKind?: "skill" | "command"; prompt?: string }
  /** Run a free prompt through a harness. */
  | { kind: "prompt"; prompt: string; harnessId?: string };

/** One entry in a schedule's run history. */
export interface ScheduleRun {
  /** When it fired (epoch ms). */
  at: number;
  /** Why it fired. */
  reason: "schedule" | "catch-up" | "manual";
  /** Session it started (Sessions tab key), when it launched. */
  sessionKey?: string;
  /**
   * launched → the run started (live status comes from its session);
   * done / needs-input / errored / stopped → its session's final status;
   * failed → couldn't launch (skill missing, no harness…).
   */
  status: "launched" | "done" | "needs-input" | "errored" | "stopped" | "failed";
  note?: string;
}

export interface Schedule {
  id: string;
  name: string;
  /** Running (true) or Paused (false) — toggled from the Schedules tab row. */
  enabled: boolean;
  task: ScheduleTask;
  trigger: ScheduleTrigger;
  createdAt: number;
  /** Scheduler cursor: occurrences at or before this have been handled. */
  cursor: number;
  /** A "once" schedule that has fired. */
  done?: boolean;
  /** Newest first, capped at RUN_HISTORY_MAX. */
  runs: ScheduleRun[];
}

export const RUN_HISTORY_MAX = 10;
/** A due run detected later than this was missed (the machine was asleep / Obsidian closed). */
export const MISSED_GRACE_MS = 3 * 60 * 1000;
/** A gap between scheduler ticks longer than this means the machine slept. */
export const WAKE_GAP_MS = 3 * 60 * 1000;
/** After a wake (or startup), wait this long before firing, so network/VPN/auth recover. */
export const WAKE_SETTLE_MS = 60 * 1000;
/** Scheduler tick interval. */
export const TICK_MS = 30 * 1000;

// --- Time helpers ------------------------------------------------------------

/** Parse "HH:MM" (24h) → [h, m]; null when invalid. */
export function parseHHMM(s: string | undefined | null): [number, number] | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/** "08:30" → "8:30 AM". Falls back to the input when unparseable. */
export function formatClock(hhmm: string): string {
  const p = parseHHMM(hhmm);
  if (!p) return hhmm;
  const [h, m] = p;
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function weeklyCandidates(trigger: { time: string; days: Weekday[] }, around: number, from: number, to: number): number[] {
  const p = parseHHMM(trigger.time);
  if (!p || trigger.days.length === 0) return [];
  const base = new Date(around);
  const out: number[] = [];
  for (let i = from; i <= to; i++) {
    const c = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, p[0], p[1], 0, 0);
    if (trigger.days.includes(c.getDay() as Weekday)) out.push(c.getTime());
  }
  return out;
}

/** The first scheduled occurrence strictly after `after`, or null (none). */
export function nextOccurrence(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.kind === "once") return trigger.at > after ? trigger.at : null;
  return weeklyCandidates(trigger, after, 0, 8).find((t) => t > after) ?? null;
}

/** The latest scheduled occurrence at or before `now`, or null. */
export function latestOccurrence(trigger: ScheduleTrigger, now: number): number | null {
  if (trigger.kind === "once") return trigger.at <= now ? trigger.at : null;
  const c = weeklyCandidates(trigger, now, -8, 0).filter((t) => t <= now);
  return c.length ? c[c.length - 1] : null;
}

// --- Evaluation ----------------------------------------------------------------

/** What the scheduler should do with a schedule on this tick. */
export type ScheduleDecision =
  | { action: "none" }
  /** Fire it. `slot` becomes the new cursor; `missed` = caught up after being away. */
  | { action: "run"; slot: number; missed: boolean; reason: "schedule" | "catch-up" };

/**
 * Decide what to do with `s` at `now`. Paused / finished schedules never fire. A
 * schedule fires when an occurrence after its cursor has come due; if that
 * occurrence is older than MISSED_GRACE_MS it was missed while away (laptop
 * asleep / Obsidian closed) and is caught up now. Several missed occurrences
 * collapse into one run. The caller holds evaluation for
 * WAKE_SETTLE_MS after a wake so catch-ups don't start before the network is back.
 */
export function evaluateSchedule(s: Schedule, now: number): ScheduleDecision {
  if (!s.enabled || s.done) return { action: "none" };
  const due = nextOccurrence(s.trigger, s.cursor);
  if (due === null || due > now) return { action: "none" };
  const slot = latestOccurrence(s.trigger, now) ?? due;
  const missed = now - due > MISSED_GRACE_MS;
  return { action: "run", slot, missed, reason: missed ? "catch-up" : "schedule" };
}

/** True when the gap since the previous tick means the machine slept. */
export function isWakeGap(prevTick: number, now: number): boolean {
  return prevTick > 0 && now - prevTick > WAKE_GAP_MS;
}

/** When the schedule will next fire on its own, for display; null when it won't. */
export function nextRunAt(s: Schedule, now: number): number | null {
  if (!s.enabled || s.done) return null;
  const due = nextOccurrence(s.trigger, s.cursor);
  if (due === null) return null;
  // Overdue (e.g. paused through it): it fires on the next tick.
  return due <= now ? now : due;
}

/** Prepend a run to the history (newest first), capped. Returns a new array. */
export function addRun(runs: ScheduleRun[], run: ScheduleRun): ScheduleRun[] {
  return [run, ...runs].slice(0, RUN_HISTORY_MAX);
}

// --- Display -------------------------------------------------------------------

/** "Every day", "Weekdays", "Weekends", or "Mon, Wed, Fri". */
export function describeDays(days: Weekday[]): string {
  const set = new Set(days);
  if (set.size === 7) return "Every day";
  if (set.size === 5 && WEEKDAYS.every((d) => set.has(d))) return "Weekdays";
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  return ALL_DAYS.filter((d) => set.has(d)).map((d) => DAY_SHORT[d]).join(", ");
}

/** A short local date+time label, e.g. "Fri, Nov 14, 8:00 AM". */
export function formatWhen(t: number): string {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${date}, ${formatClock(`${hh}:${mm}`)}`;
}

/** One-line trigger summary for the Schedules list. */
export function describeTrigger(t: ScheduleTrigger): string {
  return t.kind === "once"
    ? `Once · ${formatWhen(t.at)}`
    : `${describeDays(t.days)} at ${formatClock(t.time)}`;
}

// --- Prompt tasks --------------------------------------------------------------

/**
 * The prompt for a PROMPT task: the user's instructions (which name any skills
 * to use themselves) + (optionally) the vault anchor. Custom harnesses strip
 * control characters, which would silently delete line breaks (an email body
 * would run together), so line breaks are written as a literal `\n` with a note
 * telling the model so.
 */
export function buildPromptTaskPrompt(o: {
  prompt: string;
  vaultPath: string;
  appendAnchor: boolean;
}): string {
  const text = o.prompt.replace(/\r\n?/g, "\n").trim();
  const body = text.includes("\n")
    ? `(Line breaks in these instructions are written as \\n.) ${text.replace(/\n/g, "\\n")}`
    : text;
  const anchor = o.appendAnchor
    ? ` Operate in this vault: ${o.vaultPath}. Write any files into this vault directory only.` +
      " Do not create a git worktree or delegate the final file write."
    : "";
  return `${body}${anchor}`;
}

// --- Persistence ---------------------------------------------------------------

function isWeekday(n: unknown): n is Weekday {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 6;
}

function normalizeTrigger(raw: unknown): ScheduleTrigger | null {
  const t = raw as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  switch (t.kind) {
    case "once":
      return typeof t.at === "number" && Number.isFinite(t.at) ? { kind: "once", at: t.at } : null;
    case "weekly": {
      const days = Array.isArray(t.days) ? Array.from(new Set(t.days.filter(isWeekday))).sort() : [];
      if (!parseHHMM(t.time as string) || days.length === 0) return null;
      return { kind: "weekly", time: String(t.time).trim(), days: days as Weekday[] };
    }
    default:
      return null;
  }
}

function normalizeTask(raw: unknown): ScheduleTask | null {
  const t = raw as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  if (t.kind === "skill" && typeof t.skillId === "string" && t.skillId) {
    return {
      kind: "skill",
      skillId: t.skillId,
      skillName: typeof t.skillName === "string" ? t.skillName : "",
      itemKind: t.itemKind === "command" ? "command" : "skill",
      prompt: typeof t.prompt === "string" ? t.prompt : undefined,
    };
  }
  if (t.kind === "prompt" && typeof t.prompt === "string") {
    return {
      kind: "prompt",
      prompt: t.prompt,
      harnessId: typeof t.harnessId === "string" && t.harnessId ? t.harnessId : undefined,
    };
  }
  return null;
}

const RUN_STATUSES = new Set(["launched", "done", "needs-input", "errored", "stopped", "failed"]);
const RUN_REASONS = new Set(["schedule", "catch-up", "manual"]);

/** Validate stored schedules (from data.json), dropping anything malformed. Never throws. */
export function normalizeSchedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return [];
  const out: Schedule[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) continue;
    const task = normalizeTask(r.task);
    const trigger = normalizeTrigger(r.trigger);
    if (!task || !trigger) continue;
    const createdAt = typeof r.createdAt === "number" ? r.createdAt : Date.now();
    const runs = Array.isArray(r.runs)
      ? (r.runs as Record<string, unknown>[])
          .filter((x) => x && typeof x.at === "number" && RUN_STATUSES.has(x.status as string))
          .map((x) => ({
            at: x.at as number,
            reason: (RUN_REASONS.has(x.reason as string) ? x.reason : "schedule") as ScheduleRun["reason"],
            status: x.status as ScheduleRun["status"],
            sessionKey: typeof x.sessionKey === "string" ? x.sessionKey : undefined,
            note: typeof x.note === "string" ? x.note : undefined,
          }))
          .slice(0, RUN_HISTORY_MAX)
      : [];
    out.push({
      id: r.id,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "Untitled schedule",
      enabled: r.enabled !== false,
      task,
      trigger,
      createdAt,
      cursor: typeof r.cursor === "number" ? r.cursor : createdAt,
      done: r.done === true ? true : undefined,
      runs,
    });
  }
  return out;
}

/** A fresh schedule id. */
export function newScheduleId(now: number, rand: () => number = Math.random): string {
  return `sch-${now.toString(36)}-${Math.floor(rand() * 1e9).toString(36)}`;
}
