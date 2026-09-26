/**
 * How the plan reads in Linear. Descriptions have two owners: the synced block above the notes marker
 * is the repository's and is rewritten on every sync; everything below it is a person's and is kept.
 */
import type { Acceptance, Feature, Wmbt } from "./plan.ts";
import type { TestEvidence } from "./evidence.ts";

export const NOTES_MARKER = "✍️ Notes below this line are yours: the sync never touches them.";

export function mergeDescription(synced: string, existing?: string | null): string {
  const notes = existing?.includes(NOTES_MARKER) ? existing.split(NOTES_MARKER).slice(1).join(NOTES_MARKER) : "";
  return `${synced.trimEnd()}\n\n---\n${NOTES_MARKER}${notes.length ? notes : "\n"}`;
}

/**
 * Linear stores Markdown in its own canonical form: link targets wrapped in `<…>`, blank lines added
 * around lists and rules, nested bullets written `*`, punctuation escaped, table rules shortened to `--`,
 * emphasis moved out of link text and off code spans, and bare domains linked. Two descriptions that
 * differ only in that way say the same thing, and treating them as different would rewrite every issue
 * on every run. The cost: a change of emphasis alone is not synced until the words change too.
 */
export function sameMarkdown(a?: string | null, b?: string | null): boolean {
  const canon = (s?: string | null) => (s ?? "")
    .replace(/\]\(<([^>]+)>\)/g, "]($1)")
    .replace(/^(\s*)\* /gm, "$1- ")
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, "$1")
    .replace(/^\|(?:\s*:?-+:?\s*\|)+\s*$/gm, row => row.replace(/-+/g, "---").replace(/\s+/g, ""))
    // Linear's editor also moves emphasis (out of link text, off code spans) and links bare domains, so
    // emphasis markers are ignored and a link whose label is its own URL reads as the plain text.
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?([^)\s]+)\)/g, (m, label, url) => (label === url ? label : m))
    .replace(/[*_]/g, "")
    .split("\n").map(l => l.trimEnd()).filter(l => l !== "").join("\n");
  return canon(a) === canon(b);
}

/** The identity a synced issue carries, which is how a later sync finds it again. */
export function urnIn(description?: string | null): string | undefined {
  return description?.match(/`atdd-urn: ([^`]+)`/)?.[1];
}

const human = (slug: string) => slug.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());
const source = (path: string, repo: string) => `**Source:** [${path}](${repo}/blob/main/${path})`;

export const featureTitle = (f: Feature) => human(f.slug);
export const wmbtTitle = (w: Wmbt) => `${w.code} · ${w.objectOfControl}`;

export function featureBody(f: Feature, repo: string): string {
  return [
    f.description, "",
    source(f.path, repo), "",
    `**Trains:** ${f.trains.join(", ") || "none: no interlocking references this feature"}`, "",
    `**WMBTs:** ${f.wmbts.map(w => w.code).join(", ")}`, "",
    `\`atdd-urn: ${f.urn}\``,
  ].join("\n");
}

/** One acceptance as a reader sees it: the checkbox, then Given / When / Then in plain words. */
export function acceptanceLines(a: Acceptance, passed: boolean): string[] {
  const lines = [`- [${passed ? "x" : " "}] **${a.id}** · ${a.purpose}${a.harness ? ` *(${a.harness})*` : ""}`];
  if (a.given.length) lines.push(`  * **Given** ${a.given.join(", and ")}`);
  if (a.when) lines.push(`  * **When** ${a.when}${a.target ? `: \`${a.target}\`` : ""}`);
  if (a.then.length) lines.push(`  * **Then** ${a.then.join(", and ")}`);
  return lines;
}

export function wmbtBody(w: Wmbt, repo: string, evidence: TestEvidence): string {
  return [
    w.sentence, "",
    `**Statement:** ${w.statement}`, "",
    source(w.path, repo), "",
    `**Trains:** ${w.trains.join(", ") || "none"}`, "",
    `**Acceptances (${w.acceptances.length})**, ticked when a bound test passes:`, "",
    ...w.details.flatMap(a => acceptanceLines(a, evidence.passed.has(a.urn))), "",
    `\`atdd-urn: ${w.urn}\``,
  ].join("\n");
}
