// Setup skills bundled with the plugin. A release ships only main.js /
// manifest.json / styles.css, so each SKILL.md under src/skills/ is embedded as a
// string by esbuild's text loader (see esbuild.config.mjs) and written into the
// vault on demand from Settings ("Install setup skill"). Nothing is written
// automatically — cmux / Ghostty support is opt-in.

import SETUP_CMUX from "./skills/setup-cmux/SKILL.md";
import SETUP_GHOSTTY from "./skills/setup-ghostty/SKILL.md";

/** A skill the plugin can install into the vault. */
export interface BundledSkill {
  /** Skill name (= folder name). */
  name: string;
  /** Vault-relative path it is written to (a default scan root). */
  relPath: string;
  body: string;
}

export const BUNDLED_SKILLS: Record<"setup-cmux" | "setup-ghostty", BundledSkill> = {
  "setup-cmux": {
    name: "setup-cmux",
    relPath: ".agents/skills/setup-cmux/SKILL.md",
    body: SETUP_CMUX,
  },
  "setup-ghostty": {
    name: "setup-ghostty",
    relPath: ".agents/skills/setup-ghostty/SKILL.md",
    body: SETUP_GHOSTTY,
  },
};

export type BundledSkillId = keyof typeof BUNDLED_SKILLS;
