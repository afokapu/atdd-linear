/**
 * Teach the repository's agents how Linear is organised: a `linear` skill for every agent, and a managed
 * pointer block in AGENTS.md (Codex, Cursor and most agents) and CLAUDE.md (Claude Code). Existing files
 * and an existing block are kept unless `replace`; the rest of each instruction file is never touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SKILL_PATHS = [".agents/skills/linear/SKILL.md", ".claude/skills/linear/SKILL.md"];
export const INSTRUCTION_PATHS = ["AGENTS.md", "CLAUDE.md"];
const BLOCK = /<!-- atdd-linear:start[\s\S]*?<!-- atdd-linear:end -->\n?/;

const template = (name: string) => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  return readFileSync(new URL(`../templates/agents/${name}`, import.meta.url), "utf8").replaceAll("{{VERSION}}", version);
};
/** `current` with the managed block replaced, or appended after one blank line. */
const withBlock = (current: string, managed: string) =>
  BLOCK.test(current) ? current.replace(BLOCK, managed) : `${current}${current ? "\n\n".slice(current.match(/\n{0,2}$/)![0].length) : ""}${managed}`;

export function agentInit(root: string, replace = false): { written: string[]; kept: string[] } {
  const written: string[] = [], kept: string[] = [];
  const skill = template("SKILL.md"), block = template("block.md");
  for (const path of SKILL_PATHS) {
    const out = join(root, path);
    if (existsSync(out) && !replace) { kept.push(path); continue; }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, skill);
    written.push(path);
  }
  for (const path of INSTRUCTION_PATHS) {
    const out = join(root, path), current = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (BLOCK.test(current) && !replace) { kept.push(path); continue; }
    writeFileSync(out, withBlock(current, block));
    written.push(path);
  }
  return { written, kept };
}
