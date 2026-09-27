import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentInit } from "../src/agent.ts";

test("writes the skill and a block, keeps the rest of an instruction file, and refreshes only on --replace", () => {
  const root = mkdtempSync(join(tmpdir(), "atdd-linear-agent-"));
  writeFileSync(join(root, "CLAUDE.md"), "<!-- atdd-bun:start -->\nkeep me\n<!-- atdd-bun:end -->\n");
  expect(agentInit(root).written).toEqual([".agents/skills/linear/SKILL.md", ".claude/skills/linear/SKILL.md", "AGENTS.md", "CLAUDE.md"]);
  const claude = readFileSync(join(root, "CLAUDE.md"), "utf8");
  expect(claude).toStartWith("<!-- atdd-bun:start -->\nkeep me\n<!-- atdd-bun:end -->\n\n<!-- atdd-linear:start");
  expect(readFileSync(join(root, ".claude/skills/linear/SKILL.md"), "utf8")).toStartWith("---\nname: linear\n");
  expect(readFileSync(join(root, ".claude/skills/linear/SKILL.md"), "utf8")).not.toContain("{{VERSION}}");

  expect(agentInit(root)).toEqual({ written: [], kept: [".agents/skills/linear/SKILL.md", ".claude/skills/linear/SKILL.md", "AGENTS.md", "CLAUDE.md"] });
  agentInit(root, true);
  expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(claude);
});
