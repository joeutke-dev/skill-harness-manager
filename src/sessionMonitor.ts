// Session monitoring: pure helpers that turn a headless launch's captured
// output into a live status (running / stalled / needs input / errored / done).
// No Obsidian, fs or spawn here (main.ts owns the I/O); everything is
// side-effect-free and unit-tested in test/smoke.mjs.
//
// How it works: a headless launch writes stdout/stderr to per-session log files.
// Claude-family harnesses (`claude`, `isaac`, `ucode claude`) are launched with
// `--output-format stream-json --verbose`, so stdout is one JSON event per line:
// the session id (first line), every tool call, and a final `result` event. That
// gives an exact session id for Connect, the current step, and a reliable
// "finished" signal. Other harnesses get process-level tracking only (alive,
// exit code, stderr tail, how long it's been quiet).
//
// "Needs input" is ONLY set when the model actually needs the user: it ended
// its run with a `NEEDS INPUT:` line (it's told to in headless mode, because a
// `-p` run can't wait for an answer: it just ends with the question), or a tool
// call was blocked on permission. Silence alone is "stalled", never "needs input".

import type { LaunchedSession } from "./sessions";

export type SessionStatus =
  | "running"
  | "stalled"
  | "needs-input"
  | "errored"
  | "done"
  | "stopped"
  | "terminal"
  | "untracked"
  | "resumed";

export type AlertKind = "needs-input" | "errored" | "stalled" | "long-running";

export const DEFAULT_STALL_MINUTES = 5;
export const DEFAULT_LONG_RUN_MINUTES = 30;

/** The line a headless run ends with when it can't continue without the user. */
export const NEEDS_INPUT_MARKER = "NEEDS INPUT:";

/** Appended to headless prompts (Settings toggle) so a run can flag that it needs the user. */
export const NEEDS_INPUT_INSTRUCTION =
  "This session is running headless: nobody can answer questions or approve " +
  "anything until it ends. Don't stop to ask unless you truly cannot finish " +
  "without the user. If you can't, stop and make the last line of your reply " +
  "start with `NEEDS INPUT:` followed by exactly what you need from the user.";

/** How many recent steps a stream state keeps (for the row + details modal). */
const MAX_STEPS = 25;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/**
 * True when `argv` is a Claude-family HEADLESS run whose stdout can be switched
 * to stream-json: `claude … -p`, `isaac … -p`, or `ucode claude … -p`.
 */
export function isClaudeHeadlessArgv(argv: string[]): boolean {
  if (argv.length === 0) return false;
  const bin = baseName(argv[0]).toLowerCase().replace(/\.exe$/, "");
  const family =
    bin === "claude" || bin === "isaac" || (bin === "ucode" && argv[1] === "claude");
  if (!family) return false;
  return argv.slice(1).some((a) => a === "-p" || a === "--print");
}

/**
 * Add `--output-format stream-json --verbose` to a Claude-family headless argv
 * so its progress can be tracked. Leaves the argv alone when the harness command
 * already sets an output format; `streaming` says whether the result is
 * stream-json (i.e. trackable).
 */
export function withStreamJson(argv: string[]): { argv: string[]; streaming: boolean } {
  if (!isClaudeHeadlessArgv(argv)) return { argv, streaming: false };
  const i = argv.findIndex((a) => a === "--output-format" || a.startsWith("--output-format="));
  if (i >= 0) {
    const value = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
    return { argv, streaming: value === "stream-json" };
  }
  const out = [...argv, "--output-format", "stream-json"];
  if (!argv.includes("--verbose")) out.push("--verbose");
  return { argv: out, streaming: true };
}

// --- Stream-json parsing ---------------------------------------------------

export interface StreamResult {
  isError: boolean;
  subtype: string;
  text: string;
  numTurns?: number;
  costUsd?: number;
  durationMs?: number;
  /** Tool names whose calls were blocked on permission. */
  denials: string[];
}

export interface StreamState {
  sessionId?: string;
  /**
   * Background tasks the session is currently running (descriptions), from the
   * latest `background_tasks_changed` event. A headless run that starts
   * background jobs ends a turn (emitting a `result`) and is woken again as they
   * progress, so the process stays alive across several results.
   */
  backgroundTasks: string[];
  /** True while a turn is in progress (between `init`/assistant events and a `result`). */
  turnOpen: boolean;
  /** Most recent steps, oldest first (e.g. "Bash: npm test"). */
  steps: string[];
  /** Last assistant text seen (fallback summary). */
  lastText?: string;
  /** The LATEST result (each turn emits one; only the last one is final). */
  result?: StreamResult;
  /** Number of parsed events. */
  events: number;
}

export function emptyStreamState(): StreamState {
  return { steps: [], events: 0, backgroundTasks: [], turnOpen: false };
}

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** True for a session id that's safe to hand to a resume command. */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

function oneLine(s: string, max = 90): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** A short human summary of a tool call, e.g. `Bash: npm test` or `Edit: main.ts`. */
export function summarizeToolUse(name: string, input: unknown): string {
  const inp = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof inp[k] === "string" ? (inp[k] as string) : undefined;
  let detail: string | undefined;
  switch (name) {
    case "Bash":
      detail = str("description") ?? str("command");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      detail = str("file_path") ? baseName(str("file_path") as string) : undefined;
      break;
    case "Grep":
    case "Glob":
      detail = str("pattern");
      break;
    case "WebFetch":
      detail = str("url");
      break;
    case "WebSearch":
      detail = str("query");
      break;
    case "Skill":
      detail = str("skill");
      break;
    case "Agent":
    case "Task":
      detail = str("description");
      break;
    default: {
      const first = Object.values(inp).find((v) => typeof v === "string") as string | undefined;
      detail = first;
    }
  }
  return detail ? `${name}: ${oneLine(detail, 70)}` : name;
}

function pushStep(state: StreamState, step: string): void {
  state.steps.push(step);
  if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS);
}

/**
 * Fold one stdout line into the stream state. Non-JSON lines are ignored.
 * Returns true when the line was a parsed event.
 */
export function applyStreamLine(state: StreamState, line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return false;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }
  state.events++;
  if (!state.sessionId && isValidSessionId(ev.session_id)) state.sessionId = ev.session_id;

  if (ev.type === "system" && ev.subtype === "background_tasks_changed") {
    state.backgroundTasks = Array.isArray(ev.tasks)
      ? (ev.tasks as Array<Record<string, unknown>>).map((t) =>
          typeof t.description === "string" && t.description
            ? t.description
            : typeof t.task_type === "string"
              ? t.task_type
              : "background task",
        )
      : [];
  } else if (ev.type === "system" && ev.subtype === "init") {
    state.turnOpen = true;
  }

  if (ev.type === "assistant" || ev.type === "user") state.turnOpen = true;
  if (ev.type === "assistant") {
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const c of content as Array<Record<string, unknown>>) {
        if (c.type === "tool_use" && typeof c.name === "string") {
          pushStep(state, summarizeToolUse(c.name, c.input));
        } else if (c.type === "text" && typeof c.text === "string" && c.text.trim()) {
          state.lastText = c.text;
        }
      }
    }
  } else if (ev.type === "result") {
    state.turnOpen = false;
    const denials = Array.isArray(ev.permission_denials)
      ? (ev.permission_denials as Array<Record<string, unknown>>)
          .map((d) => (typeof d.tool_name === "string" ? d.tool_name : "a tool"))
      : [];
    state.result = {
      isError: ev.is_error === true,
      subtype: typeof ev.subtype === "string" ? ev.subtype : "",
      text: typeof ev.result === "string" ? ev.result : "",
      numTurns: typeof ev.num_turns === "number" ? ev.num_turns : undefined,
      costUsd: typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : undefined,
      durationMs: typeof ev.duration_ms === "number" ? ev.duration_ms : undefined,
      denials,
    };
  }
  return true;
}

/**
 * Split a chunk of newly read stdout into complete lines, carrying a trailing
 * partial line over to the next read.
 */
export function splitChunk(partial: string, chunk: string): { lines: string[]; partial: string } {
  const text = partial + chunk;
  const parts = text.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, partial: rest };
}

/**
 * The model's `NEEDS INPUT:` request, if its final reply contains one (the last
 * such line wins). Tolerates markdown around the marker (`**NEEDS INPUT:** …`).
 * Returns null when there's no marker, so a run that merely ended is never
 * misreported as needing input.
 */
export function extractNeedsInput(text: string): string | null {
  const re = /^[^A-Za-z0-9\n]*NEEDS INPUT[*_`]*:[*_`]*[ \t]*(.*)$/gim;
  let found: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found = m[1].replace(/[*_`]+$/g, "").trim();
  }
  if (found === null) return null;
  return found || "The session needs your input.";
}

// --- Status ------------------------------------------------------------------

export interface DerivedStatus {
  status: SessionStatus;
  /** Still alive past the long-running threshold (shown alongside the status). */
  longRunning: boolean;
  /** True once the run has ended (or reported its final result). */
  finished: boolean;
  /** One-line description for the row (current step, error, summary…). */
  detail: string;
  /** The model's question, for needs-input. */
  question?: string;
}

export interface StatusInput {
  session: LaunchedSession;
  /** Parsed stream (Claude-family sessions only). */
  stream?: StreamState;
  /** Whether the process is still alive. */
  alive: boolean;
  /** Last time the session wrote any output (epoch ms). */
  lastActivityAt: number;
  now: number;
  stallMinutes: number;
  longRunMinutes: number;
  /** Last few stderr lines, for error details. */
  stderrTail?: string;
}

/** "45s", "12m", "1h 05m". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return oneLine(line.replace(/^[#>*\-\s]+/, ""), 110);
}

/** Derive a session's status from its stream, process state and timing. */
export function deriveSessionStatus(input: StatusInput): DerivedStatus {
  const { session: s, stream, alive, now } = input;
  if (s.mode === "terminal") {
    return { status: "terminal", longRunning: false, finished: true, detail: "Opened in a terminal" };
  }
  if (!s.logPath) {
    return {
      status: "untracked",
      longRunning: false,
      finished: true,
      detail: "Launched before session tracking was available",
    };
  }

  const result = stream?.result;

  if (!alive) {
    const base = { longRunning: false, finished: true };
    if (s.stopped) return { ...base, status: "stopped", detail: "Stopped by you" };
    if (result) return { ...base, ...classifyResult(result) };
    const tail = input.stderrTail?.trim() ? ` — ${oneLine(input.stderrTail, 120)}` : "";
    if (typeof s.exitCode === "number" && s.exitCode !== 0) {
      return { ...base, status: "errored", detail: `Exited with code ${s.exitCode}${tail}` };
    }
    if (s.stream === "claude") {
      return { ...base, status: "errored", detail: `Ended without a final result${tail}` };
    }
    return {
      ...base,
      status: "done",
      detail: s.exitCode === 0 ? "Finished" : "Finished (exit status unknown)",
    };
  }

  // Still alive. A result here just ends a TURN: the run may be waiting on its
  // own background tasks and will be woken again, so it isn't finished yet.
  const longRunning = now - s.startedAt >= input.longRunMinutes * 60_000;
  if (result && stream && !stream.turnOpen) {
    const c = classifyResult(result);
    if (c.status === "needs-input") return { ...c, longRunning, finished: false };
    if (stream.backgroundTasks.length > 0) {
      const n = stream.backgroundTasks.length;
      return {
        status: "running",
        longRunning,
        finished: false,
        detail: `Waiting on ${n} background task${n === 1 ? "" : "s"}: ${oneLine(stream.backgroundTasks[0], 70)}`,
      };
    }
  }

  const idle = now - input.lastActivityAt;
  const last = stream?.steps[stream.steps.length - 1];
  if (idle >= input.stallMinutes * 60_000) {
    return {
      status: "stalled",
      longRunning,
      finished: false,
      detail: `No activity for ${formatDuration(idle)}${last ? ` · last: ${last}` : ""}`,
    };
  }
  return {
    status: "running",
    longRunning,
    finished: false,
    detail: last ?? (stream ? "Starting…" : "Running"),
  };
}

/** What a result says about the run: errored, needs input, or done. */
function classifyResult(
  result: StreamResult,
): { status: SessionStatus; detail: string; question?: string } {
  if (result.isError || (result.subtype && result.subtype !== "success")) {
    const why = result.text ? firstLine(result.text) : result.subtype || "unknown error";
    return { status: "errored", detail: `Claude reported an error: ${why}` };
  }
  if (result.denials.length > 0) {
    const tools = [...new Set(result.denials)].join(", ");
    return {
      status: "needs-input",
      detail: `Blocked waiting for permission: ${tools}`,
      question: `Approve ${tools}, or tell it how to continue.`,
    };
  }
  const q = extractNeedsInput(result.text);
  if (q !== null) return { status: "needs-input", detail: `Asked: ${oneLine(q, 110)}`, question: q };
  return { status: "done", detail: result.text ? firstLine(result.text) : "Finished" };
}

/**
 * A finished session the user has since Connected to was continued
 * interactively, so whatever it ended as (e.g. needs input) is no longer
 * current: show it as Resumed. The plugin can't see the interactive session, so
 * this is the last thing it knows.
 */
export function withResumed(d: DerivedStatus, resumedAt?: number): DerivedStatus {
  if (!resumedAt || !d.finished || d.status === "terminal" || d.status === "untracked") return d;
  return { ...d, status: "resumed", detail: "Continued in your terminal", question: undefined };
}

/**
 * Alerts to raise now: each kind fires at most once per session (`alerted`
 * holds what's already been shown).
 */
export function alertsToFire(d: DerivedStatus, alerted: readonly string[] = []): AlertKind[] {
  const out: AlertKind[] = [];
  if (d.status === "needs-input" || d.status === "errored" || d.status === "stalled") {
    out.push(d.status);
  }
  if (d.longRunning && !d.finished) out.push("long-running");
  return out.filter((k) => !alerted.includes(k));
}

export type SessionGroup = "attention" | "running" | "finished";

/** Which Sessions-tab group a session belongs in. Acknowledged items leave "attention". */
export function sessionGroup(d: DerivedStatus, acknowledged = false): SessionGroup {
  if (!d.finished) {
    return (d.status === "stalled" || d.status === "needs-input") && !acknowledged
      ? "attention"
      : "running";
  }
  if ((d.status === "needs-input" || d.status === "errored") && !acknowledged) return "attention";
  return "finished";
}

/** Short label for the status pill. */
export function statusLabel(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "Running";
    case "stalled":
      return "Stalled";
    case "needs-input":
      return "Needs input";
    case "errored":
      return "Errored";
    case "done":
      return "Done";
    case "stopped":
      return "Stopped";
    case "terminal":
      return "In terminal";
    case "untracked":
      return "Untracked";
    case "resumed":
      return "Resumed";
  }
}

// --- Resume -------------------------------------------------------------------

/**
 * Point a resume command at one exact session. `{session}` in the command is
 * replaced with the id; otherwise the id is appended when the command ends in a
 * resume flag/subcommand (`--resume`, `-r`, `resume`). Without an id, any
 * `{session}` token is dropped so the command falls back to the tool's picker /
 * most-recent behavior.
 */
export function resumeArgvForSession(argv: string[], sessionId?: string): string[] {
  if (!isValidSessionId(sessionId)) return argv.filter((a) => a !== "{session}");
  if (argv.includes("{session}")) return argv.map((a) => (a === "{session}" ? sessionId : a));
  const last = argv[argv.length - 1];
  if (last === "--resume" || last === "-r" || last === "resume") return [...argv, sessionId];
  return argv;
}

/** Filesystem-safe base name for a session's log files. */
export function sessionLogBase(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_");
}
