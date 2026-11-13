// cmux (manaflow-ai/cmux) integration — pure helpers.
//
// cmux is a native macOS terminal (built on libghostty) organised as
// windows → workspaces (sidebar entries) → panes → surfaces (tabs). It ships a
// full CLI inside its app bundle (`cmux.app/Contents/Resources/bin/cmux`) that
// drives the running app over a Unix socket. The plugin uses it to open every
// terminal-mode run and every session Connect as a NEW TAB inside one dedicated
// workspace ("Obsidian Sessions" by default), creating that workspace on first
// use, and to post cmux notifications when headless runs finish or need input.
//
// Socket access: cmux's default `automation.socketControlMode` is `cmuxOnly`,
// which rejects any process not started inside cmux — i.e. Obsidian. The user
// must switch it to `password` (recommended; the bundled CLI reads the saved
// password itself, so the plugin never stores it) or `allowAll`. The bundled
// `setup-cmux` skill does this. `classifyCmuxError` turns the CLI's errors into
// an actionable state for Notices / the settings "Test connection" button.
//
// Everything here is side-effect-free (no Obsidian, no spawn, no fs) so the smoke
// suite can exercise it directly; main.ts owns the process calls.

import * as nodePath from "path";
import { shellSingleQuote, stripControlChars } from "./launch";

/** Default name of the cmux workspace that plugin runs open into. */
export const CMUX_DEFAULT_WORKSPACE = "Obsidian Sessions";

/** The CLI's path inside the app bundle (relative to `<dir>/cmux.app`). */
export const CMUX_BUNDLED_CLI = "Contents/Resources/bin/cmux";

/**
 * Where the cmux CLI may live, most-preferred first: the copy bundled inside the
 * app (always matches the running app's socket protocol), then a user-installed
 * symlink on a standard bin dir.
 */
export function cmuxCliCandidates(homedir: string, appDirs: string[]): string[] {
  return [
    ...appDirs.map((d) => nodePath.join(d, "cmux.app", CMUX_BUNDLED_CLI)),
    "/opt/homebrew/bin/cmux",
    "/usr/local/bin/cmux",
    `${homedir}/.local/bin/cmux`,
  ];
}

/** A cmux workspace as reported by `cmux workspace list --json`. */
export interface CmuxWorkspace {
  ref: string;
  id: string;
  title: string;
  customTitle: string | null;
}

/** Parse `cmux workspace list --json` output. Returns [] on anything malformed. */
export function parseCmuxWorkspaces(json: string): CmuxWorkspace[] {
  try {
    const data = JSON.parse(json) as { workspaces?: unknown };
    if (!data || !Array.isArray(data.workspaces)) return [];
    const out: CmuxWorkspace[] = [];
    for (const w of data.workspaces as Record<string, unknown>[]) {
      if (!w || typeof w.ref !== "string") continue;
      out.push({
        ref: w.ref,
        id: typeof w.id === "string" ? w.id : "",
        title: typeof w.title === "string" ? w.title : "",
        customTitle: typeof w.custom_title === "string" ? w.custom_title : null,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Normalise a workspace name for matching (trim + case-insensitive). */
function normName(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Find the plugin's workspace by name. Prefers a workspace whose CUSTOM title
 * matches (the one we created with `--name`) over one whose auto title happens
 * to match. Returns undefined when absent (caller creates it).
 */
export function findCmuxWorkspace(
  list: CmuxWorkspace[],
  name: string,
): CmuxWorkspace | undefined {
  const want = normName(name);
  if (!want) return undefined;
  return (
    list.find((w) => w.customTitle !== null && normName(w.customTitle) === want) ??
    list.find((w) => normName(w.title) === want)
  );
}

/** The effective workspace name: the setting, else the default. Control chars stripped. */
export function resolveCmuxWorkspaceName(setting: string | undefined | null): string {
  const v = stripControlChars(typeof setting === "string" ? setting : "").trim();
  return v || CMUX_DEFAULT_WORKSPACE;
}

/** A tab title safe to pass as a single argv element (no control chars, capped). */
export function cmuxTabTitle(s: string): string {
  const v = stripControlChars(s).replace(/\s+/g, " ").trim();
  return (v || "Obsidian").slice(0, 60);
}

/**
 * The text cmux types into the new tab's shell: run the plugin's temp launcher
 * script with bash. The path is POSIX single-quoted (it lives in os.tmpdir() and
 * its tag is already sanitised, but quote defensively).
 */
export function cmuxRunCommand(scriptPath: string): string {
  return `bash ${shellSingleQuote(scriptPath)}`;
}

/** `cmux new-workspace …` argv (after the binary). */
export function cmuxNewWorkspaceArgs(o: {
  name: string;
  cwd: string;
  command: string;
  focus: boolean;
}): string[] {
  return [
    "new-workspace",
    "--name",
    o.name,
    "--cwd",
    o.cwd,
    "--command",
    o.command,
    "--focus",
    String(o.focus),
  ];
}

/** `cmux new-surface …` argv — a new terminal tab in an existing workspace. */
export function cmuxNewSurfaceArgs(o: {
  workspace: string;
  cwd: string;
  command: string;
  focus: boolean;
}): string[] {
  return [
    "new-surface",
    "--type",
    "terminal",
    "--workspace",
    o.workspace,
    "--working-directory",
    o.cwd,
    "--command",
    o.command,
    "--focus",
    String(o.focus),
  ];
}

/** `cmux rename-tab …` argv. Without `surface`, cmux renames the workspace's focused tab. */
export function cmuxRenameTabArgs(o: {
  workspace: string;
  surface?: string;
  title: string;
}): string[] {
  const args = ["rename-tab", "--workspace", o.workspace];
  if (o.surface) args.push("--surface", o.surface);
  args.push("--", cmuxTabTitle(o.title));
  return args;
}

/** `cmux notify …` argv. Targets the plugin's workspace when known. */
export function cmuxNotifyArgs(o: {
  title: string;
  body?: string;
  workspace?: string;
}): string[] {
  const args = ["notify", "--title", stripControlChars(o.title).slice(0, 120)];
  const body = o.body ? o.body.replace(/[\r\n]+/g, " ") : "";
  const cleanBody = stripControlChars(body).trim().slice(0, 300);
  if (cleanBody) args.push("--body", cleanBody);
  if (o.workspace) args.push("--workspace", o.workspace);
  return args;
}

/** Refs printed by `new-workspace` / `new-surface` (`OK surface:1 pane:2 workspace:3`). */
export interface CmuxRefs {
  workspace?: string;
  pane?: string;
  surface?: string;
}

/** Pull the `kind:<n>` refs out of an `OK …` line. */
export function parseCmuxRefs(stdout: string): CmuxRefs {
  const out: CmuxRefs = {};
  for (const m of stdout.matchAll(/\b(workspace|pane|surface):([A-Za-z0-9-]+)/g)) {
    const kind = m[1] as keyof CmuxRefs;
    if (!out[kind]) out[kind] = `${m[1]}:${m[2]}`;
  }
  return out;
}

/** Why a cmux CLI call failed, in user-actionable terms. */
export type CmuxErrorKind = "access-denied" | "not-running" | "other";

/** Classify a cmux CLI failure from its stderr/stdout/message text. */
export function classifyCmuxError(text: string): CmuxErrorKind {
  const t = text.toLowerCase();
  if (/access denied|only processes started inside cmux|password|unauthori[sz]ed|authentication/.test(t)) {
    return "access-denied";
  }
  if (/no such file|connection refused|econnrefused|enoent|not running|failed to connect|could not connect|socket.*(missing|not found|unavailable)/.test(t)) {
    return "not-running";
  }
  return "other";
}

/** The Notice / settings text for a classified failure. */
export function cmuxErrorMessage(kind: CmuxErrorKind, detail = ""): string {
  switch (kind) {
    case "access-denied":
      return (
        "cmux refused the connection: its socket only allows processes started inside cmux. " +
        "Run the setup-cmux skill (Settings → Skill and Harness Manager → cmux → Install setup skill), " +
        "or set cmux Settings → Automation → socket control to Password."
      );
    case "not-running":
      return "cmux isn't running (or its socket isn't up yet). Open cmux and try again.";
    default:
      return `cmux command failed${detail ? `: ${detail.trim().slice(0, 200)}` : "."}`;
  }
}

/** Parse the `access_mode` out of `cmux capabilities --json`; "" when unknown. */
export function parseCmuxAccessMode(json: string): string {
  try {
    const v = (JSON.parse(json) as { access_mode?: unknown }).access_mode;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
