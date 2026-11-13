// Ghostty integration — pure helpers.
//
// On macOS the `ghostty` CLI cannot open terminal windows, so before 1.3 the only
// way to run a command in Ghostty was `open -na Ghostty --args -e bash <script>`,
// which starts a SEPARATE Ghostty process (its own Dock icon / window set) for
// every run. Ghostty 1.3.0 added a native AppleScript dictionary
// (application → windows → tabs → terminals) with `new tab` / `new window` taking
// a surface configuration (initial working directory + initial input), plus
// `perform action "set_tab_title:…"`. When the installed Ghostty supports it the
// plugin opens each run as a TAB in the existing Ghostty window instead.
//
// macOS asks once ("Obsidian wants to control Ghostty") the first time the plugin
// sends Ghostty an AppleScript — that's the Automation (TCC) permission. The
// bundled `setup-ghostty` skill walks through upgrading + permissions.
//
// Pure (no Obsidian, no spawn, no fs) so the smoke suite can exercise it.

import { stripControlChars } from "./launch";

/** First Ghostty version with the AppleScript dictionary. */
export const GHOSTTY_APPLESCRIPT_MIN = "1.3.0";

/** Where new Ghostty runs open when AppleScript is available. */
export type GhosttyOpenIn = "tab" | "window";

/** Parse "1.2.3" / "1.3.0-dev+abc" → [1,2,3]; null when unparseable. */
export function parseVersion(v: string | undefined | null): [number, number, number] | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/** a >= b for dotted versions; false when either is unparseable. */
export function versionAtLeast(a: string | undefined | null, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return true;
}

/** True when this Ghostty version can be driven by AppleScript (≥ 1.3.0). */
export function ghosttySupportsAppleScript(version: string | undefined | null): boolean {
  return versionAtLeast(version, GHOSTTY_APPLESCRIPT_MIN);
}

/** Read CFBundleShortVersionString out of an app's Info.plist XML; "" when absent. */
export function readBundleVersion(infoPlistXml: string): string {
  const m = infoPlistXml.match(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/,
  );
  return m ? m[1].trim() : "";
}

/** Quote a value as an AppleScript string literal (escape `\` and `"`; no control chars). */
export function appleScriptString(s: string): string {
  return `"${stripControlChars(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Build the AppleScript that opens a Ghostty tab (or window) in `cwd`, types
 * `command` + Return into it, and titles the tab. Falls back to a new window when
 * Ghostty has no window open (or `openIn` is "window"). The command and title are
 * embedded as escaped string literals only — never as AppleScript source.
 */
export function buildGhosttyAppleScript(o: {
  cwd: string;
  command: string;
  title: string;
  openIn: GhosttyOpenIn;
}): string {
  const title = stripControlChars(o.title).replace(/\s+/g, " ").trim().slice(0, 60) || "Obsidian";
  const lines = [
    `tell application "Ghostty"`,
    `  activate`,
    `  set cfg to new surface configuration`,
    `  set initial working directory of cfg to ${appleScriptString(o.cwd)}`,
    `  set initial input of cfg to ${appleScriptString(o.command)} & linefeed`,
  ];
  if (o.openIn === "window") {
    lines.push(
      `  set win to new window with configuration cfg`,
      `  set term to focused terminal of selected tab of win`,
    );
  } else {
    lines.push(
      `  if (count of windows) is 0 then`,
      `    set win to new window with configuration cfg`,
      `    set term to focused terminal of selected tab of win`,
      `  else`,
      `    set newTab to new tab in front window with configuration cfg`,
      `    set term to focused terminal of newTab`,
      `  end if`,
    );
  }
  lines.push(
    `  perform action ${appleScriptString(`set_tab_title:${title}`)} on term`,
    `end tell`,
  );
  return lines.join("\n");
}
