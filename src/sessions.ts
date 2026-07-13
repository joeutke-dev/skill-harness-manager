// M20 — Sessions tab: pure helpers for tracking sessions the plugin launched and
// reconnecting to them in a terminal. No Obsidian / no fs / no spawn (those live
// in main.ts); everything here is side-effect-free and unit-testable.
//
// A "session" is one skill launch. It is recorded IMMEDIATELY at launch (so it
// shows up instantly — the launches are headless/detached and, when routed to a
// remote omnigent server, the conversation lives server-side and is never
// written to any local store, so there is nothing reliable to poll for). Because
// we don't capture a specific conversation id, "Connect" reopens via each tool's
// "continue most recent" mechanism, scoped as tightly as the tool allows:
//   - omnigent → `omnigent run <agent?> --server <url?> --harness <h?> -c`
//                (-c = continue the most recent conversation FOR THIS AGENT)
//   - claude   → `claude --continue`     (most recent in this cwd)
//   - codex    → `codex resume --last`   (most recent codex session)
//   - isaac    → `isaac resume`          (interactive picker of recent sessions;
//                a Claude Code CLI wrapper used by some custom harnesses)
// A launch through any OTHER (generic) custom harness has no known resume story
// and is not tracked. Precise per-conversation reconnect is a future iteration.

import { isValidOmnigentServer, shellSingleQuote } from "./launch";

// "custom" = a custom harness whose binary we don't recognize (universal
// tracking): it's still recorded, and Connect does a best-effort resume, falling
// back to a terminal hint to set a Resume command for the harness.
export type SessionTool = "omnigent" | "claude" | "codex" | "isaac" | "custom";

/** One tracked launch. Persisted in settings; pruned after 12h. */
export interface LaunchedSession {
  /** Stable de-dupe key (tool + launch time + nonce). */
  key: string;
  tool: SessionTool;
  /** The skill (or command) name that started it. */
  skillName: string;
  /** Absolute binary used to launch (reused verbatim for the resume command). */
  binaryPath: string;
  /** Launch cwd (the vault) — resume runs here. */
  cwd: string;
  /** Custom-harness id (to look up a user-set resume command), if launched via one. */
  harnessId?: string;
  /** Custom-harness display label (shown on the row instead of the tool). */
  harnessLabel?: string;
  /** omnigent custom-agent positional (bundle/file path), if any. */
  agentArg?: string;
  /** omnigent `--harness` value in effect, if any. */
  harness?: string;
  /** omnigent `--server` value in effect, re-applied on resume. */
  server?: string;
  /** Launch time, epoch ms. */
  startedAt: number;
}

/** Sessions older than this are dropped from the UI (and storage). */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Whether a session has aged out (≥ 12h since launch). */
export function isSessionExpired(s: LaunchedSession, now: number): boolean {
  return now - s.startedAt >= SESSION_MAX_AGE_MS;
}

/** Map a custom-harness command's binary to a supported tool, or null. */
export function sessionToolFromCommand(binary: string): SessionTool | null {
  const base = (binary.split("/").pop() ?? binary).toLowerCase();
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  if (base === "isaac") return "isaac";
  return null;
}

/**
 * The argv that reconnects to a session (binary + inert args), using each tool's
 * "continue most recent" mechanism. omnigent re-declares the agent/harness/server
 * so `-c` resolves to the latest conversation for THAT agent on THAT server.
 */
export function buildResumeArgv(s: LaunchedSession): string[] {
  if (s.tool === "omnigent") {
    const argv = [s.binaryPath, "run"];
    if (s.agentArg) argv.push(s.agentArg);
    if (isValidOmnigentServer(s.server)) argv.push("--server", s.server.trim());
    if (s.harness) argv.push("--harness", s.harness);
    argv.push("-c");
    return argv;
  }
  if (s.tool === "claude") return [s.binaryPath, "--continue"];
  if (s.tool === "isaac") return [s.binaryPath, "resume"];
  if (s.tool === "codex") return [s.binaryPath, "resume", "--last"];
  // "custom": best-effort guess (the most common continue flag). If it's wrong,
  // the terminal script surfaces a hint to set a Resume command for the harness.
  return [s.binaryPath, "--continue"];
}

/**
 * A macOS `.command` script that `cd`s into `cwd` and runs the resolved resume
 * `argv`. Written to a temp file and `open`ed so it launches in the user's
 * DEFAULT terminal. Every element is POSIX single-quoted so paths/ids with
 * metacharacters stay one inert argument. On a NON-ZERO exit (best-effort resume
 * failed / session not resumable) it prints `failHint` so the user isn't left
 * guessing. (Not `exec` — we need to observe the exit code to show the hint.)
 */
export function buildTerminalScript(
  argv: string[],
  cwd: string,
  failHint: string,
): string {
  const cmd = argv.map(shellSingleQuote).join(" ");
  const hint = failHint.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    "#!/bin/bash",
    `cd ${shellSingleQuote(cwd)} || exit 1`,
    cmd,
    "code=$?",
    'if [ "$code" -ne 0 ]; then',
    '  echo ""',
    `  echo "${hint}"`,
    "fi",
    "",
  ].join("\n");
}

/** Short label describing the reconnect target (shown on the row). */
export function resumeTargetLabel(s: LaunchedSession): string {
  if (s.tool === "omnigent") {
    const agent = s.agentArg
      ? (s.agentArg.split("/").pop() ?? s.agentArg)
      : "default agent";
    const h = s.harness ? ` · ${s.harness}` : "";
    return `omnigent · ${agent}${h} · continues latest`;
  }
  if (s.tool === "claude") return "claude · continues latest in vault";
  if (s.tool === "isaac") return "isaac · resume picker";
  if (s.tool === "codex") return "codex · resumes last session";
  return "custom harness · best-effort resume";
}

/** Human "how long ago" label for a start time (e.g. "3m ago", "2h ago"). */
export function relativeTime(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}
