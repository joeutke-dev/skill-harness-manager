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
  platform: NodeJS.Platform = process.platform,
  keepOpen = false,
): { ext: string; content: string } {
  if (platform === "win32") {
    return { ext: ".bat", content: buildBatchScript(argv, cwd, failHint, keepOpen) };
  }
  // macOS uses `.command` (double-clickable / `open`-able in Terminal); other
  // Unix uses `.sh`. Both share the same bash body.
  return {
    ext: platform === "darwin" ? ".command" : ".sh",
    content: buildBashScript(argv, cwd, failHint, keepOpen),
  };
}

/**
 * A terminal script that `cd`s into `cwd` and runs a RAW user-authored script
 * `body` (the Bash Scripts tab). Unlike `buildTerminalScript` this embeds the
 * body verbatim (it IS shell source the user wrote), not a quoted argv. `cwd` is
 * still POSIX/quote-escaped. Used for the visible-terminal script-run path.
 */
export function buildRawTerminalScript(
  body: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): { ext: string; content: string } {
  if (platform === "win32") {
    return {
      ext: ".bat",
      content: ["@echo off", `cd /d "${cwd.replace(/"/g, '""')}"`, body, ""].join(
        "\r\n",
      ),
    };
  }
  return {
    ext: platform === "darwin" ? ".command" : ".sh",
    content: [
      "#!/bin/bash",
      // Self-delete so terminal session-restore (e.g. Ghostty/macOS reopen) can't
      // re-run this script and spawn a duplicate. The open fd keeps running fine.
      'rm -f "$0"',
      `cd ${shellSingleQuote(cwd)} || exit 1`,
      body,
      "",
    ].join("\n"),
  };
}

function buildBashScript(
  argv: string[],
  cwd: string,
  failHint: string,
  keepOpen = false,
): string {
  const cmd = argv.map(shellSingleQuote).join(" ");
  const hint = failHint.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    "#!/bin/bash",
    // Self-delete so terminal session-restore (e.g. Ghostty/macOS reopen) can't
    // re-run this script and spawn a duplicate. The open fd keeps running fine.
    'rm -f "$0"',
    `cd ${shellSingleQuote(cwd)} || exit 1`,
    cmd,
    "code=$?",
    'if [ "$code" -ne 0 ]; then',
    '  echo ""',
    `  echo "${hint}"`,
    "fi",
  ];
  // Keep the window usable after the command exits: drop into an interactive
  // shell in the same cwd so the user can continue (e.g. resume the session).
  if (keepOpen) lines.push('exec "${SHELL:-/bin/bash}" -i');
  lines.push("");
  return lines.join("\n");
}

function buildBatchScript(
  argv: string[],
  cwd: string,
  failHint: string,
  keepOpen = false,
): string {
  const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const cmd = argv.map(q).join(" ");
  // Strip cmd.exe-special characters from the hint so `echo` prints it literally.
  const safeHint = failHint.replace(/[%&|<>^()"]/g, " ");
  const lines = [
    "@echo off",
    `cd /d ${q(cwd)}`,
    cmd,
    "if not errorlevel 1 goto :done",
    "echo.",
    `echo ${safeHint}`,
    ":done",
  ];
  // Keep the console open with a fresh prompt so the user can continue.
  if (keepOpen) lines.push("cmd /k");
  lines.push("");
  return lines.join("\r\n");
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
