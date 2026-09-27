/**
 * What a repository says about its Linear team, in `atdd-linear.yaml` at its root. Everything else is
 * read from the plan, so this stays a handful of lines:
 *
 *   team: FOS                                   # the Linear team key
 *   repo: https://github.com/org/repo           # where Source links point
 *   documents:                                  # repository docs mirrored as Linear team documents
 *     - docs/purpose/missions.adoc
 *   summary: docs/purpose/index.adoc            # whose headline opens each release's description
 *   journey_view: docs/purpose/journeys         # where `atdd-bun docs journeys` writes its SVGs
 *   colors:                                     # optional: a train label's colour, by interlocking
 *     contest: "#1F6B52"
 *   cycles:                                     # optional: cycle N is named after the Nth entry
 *     - "Version 1.0: Apoc"
 *
 * It is a file of its own, not a key in atdd-bun.yaml, whose integrity check owns that file's schema.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Config = {
  team: string;
  repo: string;
  documents: string[];
  summary?: string;
  journeyView: string;
  colors: Record<string, string>;
  /** cycle N's name is `cycles[N - 1]` */
  cycles: string[];
};

export const CONFIG_FILE = "atdd-linear.yaml";

export function readConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${CONFIG_FILE} not found in ${root}; it names the Linear team and the repository URL`);
  const d = (Bun.YAML.parse(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  const team = typeof d.team === "string" ? d.team.trim() : "";
  const repo = typeof d.repo === "string" ? d.repo.trim().replace(/\/+$/, "") : "";
  if (!team) throw new Error(`${CONFIG_FILE}: team (the Linear team key) is required`);
  if (!/^https?:\/\//.test(repo)) throw new Error(`${CONFIG_FILE}: repo must be the repository's https URL`);
  const documents = Array.isArray(d.documents) ? d.documents.map(String) : [];
  const colors = d.colors && typeof d.colors === "object" ? Object.fromEntries(Object.entries(d.colors).map(([k, v]) => [k, String(v)])) : {};
  const summary = typeof d.summary === "string" ? d.summary.trim() : undefined;
  const cycles = Array.isArray(d.cycles) ? d.cycles.map(c => String(c).trim()) : [];
  const journeyView = typeof d.journey_view === "string" ? d.journey_view.trim().replace(/\/+$/, "") : "docs/purpose/journeys";
  return { team, repo, documents, summary, journeyView, colors, cycles };
}

/** A stable colour for a train nobody configured, so a label keeps its colour from run to run. */
export function colorFor(name: string, colors: Record<string, string>): string {
  if (colors[name]) return colors[name]!;
  const palette = ["#1F6B52", "#7A4FB5", "#2A62A8", "#8A6A12", "#C77C0E", "#3A8FA0", "#5E6863", "#C0428A", "#B4561E", "#4E7FD1", "#9A5B3C", "#6B6BD6"];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}
