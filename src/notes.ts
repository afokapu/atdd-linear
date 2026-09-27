/**
 * A version's release notes: a document on its cycle, rewritten on every sync while the cycle runs and
 * written once more after it ends, then left alone. It says two things about the week:
 *
 *   delivered     the WMBTs Linear records as completed inside the cycle. Tests decide Done, so this is
 *                 what went green that week, grouped by the train it runs on; a journey is complete when
 *                 every WMBT on its trains is, and the last of them was completed that week.
 *   plan changes  what plan/ gained, changed and lost between the cycle's start and its end, from git.
 *
 * The notes marker splits the document like an issue's description: a person's text below it is kept.
 */
import type { Config } from "./config.ts";
import { all, type Gql } from "./linear.ts";
import type { Plan, Wmbt } from "./plan.ts";
import { featureTitle, mergeDescription, sameMarkdown, urnIn } from "./render.ts";
import type { Op } from "./sync.ts";

export const NOTES_SUFFIX = " · Release notes";
export type Change = { status: "added" | "changed" | "removed"; path: string };
/** The plan files changed between two instants, or undefined where history cannot say (a shallow clone). */
export type History = (root: string, planRoot: string, since: string, until?: string) => Change[] | undefined;

type Cycle = {
  id: string; number: number; name: string | null; startsAt: string; endsAt: string; isActive: boolean;
  documents: { nodes: { id: string; title: string; content: string | null; updatedAt: string }[] };
};
type Done = { identifier: string; url: string; description: string | null; completedAt: string | null; state: { type: string } };

const git = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
};
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Plan changes from git: the last commit before the cycle started against the last one before it ended. */
export const gitHistory: History = (root, planRoot, since, until) => {
  if (git(root, "rev-parse", "--is-shallow-repository") !== "false") return undefined;
  const base = git(root, "rev-list", "-1", `--before=${since}`, "HEAD") || EMPTY_TREE;
  const end = until ? git(root, "rev-list", "-1", `--before=${until}`, "HEAD") : "HEAD";
  if (!end) return [];
  const out = git(root, "diff", "--name-status", "-M", base, end, "--", planRoot);
  if (out === undefined) return undefined;
  return out.split("\n").filter(Boolean).map(line => {
    const [code, ...paths] = line.split("\t");
    const status = code!.startsWith("A") ? "added" : code!.startsWith("D") ? "removed" : "changed";
    return { status, path: paths[paths.length - 1]! } as Change;
  });
};

const day = (iso: string) => iso.slice(0, 10);
const within = (at: string | null, c: Cycle) => !!at && at >= c.startsAt && at < c.endsAt;

export function notesBody(cycle: Cycle, plan: Plan, config: Config, issues: Done[], changes: Change[] | undefined): string {
  const wmbts = new Map([...plan.features.flatMap(f => f.wmbts), ...plan.loose].map(w => [w.urn, w]));
  const featureOf = new Map(plan.features.flatMap(f => f.wmbts.map(w => [w.urn, f])));
  const completed = new Map(issues.filter(i => i.state.type === "completed").map(i => [urnIn(i.description)!, i]));
  const delivered = [...completed].filter(([, i]) => within(i.completedAt, cycle)).map(([urn]) => urn).filter(u => wmbts.has(u));
  const titleOf = new Map(plan.interlockings.map(i => [i.slug, i.title || i.slug]));
  const link = (path: string) => `[${path}](${config.repo}/blob/main/${path})`;
  const lines = [`**${cycle.name ?? `Cycle ${cycle.number}`}**, ${day(cycle.startsAt)} to ${day(cycle.endsAt)}${cycle.isActive ? " · in progress, updated on every sync" : ""}`, ""];

  const complete = plan.journeys.filter(j => {
    const own = [...wmbts.values()].filter(w => w.trains.some(t => j.interlockings.includes(t)));
    if (!own.length || !own.every(w => completed.has(w.urn))) return false;
    return own.some(w => within(completed.get(w.urn)!.completedAt, cycle)) && own.every(w => completed.get(w.urn)!.completedAt! < cycle.endsAt);
  });
  lines.push("## Journeys completed", "");
  lines.push(...(complete.length ? complete.map(j => `- **${j.title}**: every WMBT on ${j.interlockings.map(i => titleOf.get(i)).join(", ")} is done`) : ["None this version."]), "");

  lines.push(`## Delivered (${delivered.length} WMBT${delivered.length === 1 ? "" : "s"})`, "");
  if (!delivered.length) lines.push("Nothing went green this version.", "");
  const byTrain = new Map<string, Wmbt[]>();
  for (const urn of delivered) for (const t of wmbts.get(urn)!.trains.length ? wmbts.get(urn)!.trains : [""]) {
    if (!byTrain.has(t)) byTrain.set(t, []);
    byTrain.get(t)!.push(wmbts.get(urn)!);
  }
  for (const [train, list] of [...byTrain].sort(([a], [b]) => (a || "~").localeCompare(b || "~"))) {
    const journeys = plan.journeys.filter(j => j.interlockings.includes(train)).map(j => j.title);
    lines.push(train ? `### ${titleOf.get(train)} (\`train:${train}\`)` : "### On no train", "");
    if (journeys.length) lines.push(`Serves: ${journeys.join(", ")}`, "");
    for (const w of list.sort((a, b) => a.urn.localeCompare(b.urn))) {
      const i = completed.get(w.urn)!, f = featureOf.get(w.urn);
      lines.push(`- [${i.identifier}](${i.url}) ${f ? `${featureTitle(f)} · ` : ""}**${w.code}** · ${w.objectOfControl}: ${w.sentence}`);
    }
    lines.push("");
  }

  lines.push("## Plan changes", "");
  if (!changes) lines.push("Not available: the history this sync ran on is a shallow clone (check out with `fetch-depth: 0`).", "");
  else if (!changes.length) lines.push("The plan did not change this version.", "");
  else {
    const named = new Map<string, string>([
      ...plan.journeys.map(j => [j.path, `Journey · ${j.title}`] as const),
      ...plan.interlockings.map(i => [i.path, `Interlocking · ${i.title || i.slug}`] as const),
      ...plan.features.map(f => [f.path, `Feature · ${featureTitle(f)}`] as const),
      ...[...wmbts.values()].map(w => [w.path, `WMBT · ${w.code} · ${w.objectOfControl}`] as const),
      ...plan.wagons.map(w => [`${w.dir}_${w.slug}.yaml`, `Wagon · ${w.slug}`] as const),
    ]);
    for (const status of ["added", "changed", "removed"] as const) {
      const these = changes.filter(c => c.status === status);
      if (!these.length) continue;
      lines.push(`### ${status[0]!.toUpperCase()}${status.slice(1)} (${these.length})`, "");
      const rank = (c: Change) => (named.get(c.path) ? 0 : 1);
      for (const c of these.sort((a, b) => rank(a) - rank(b) || (named.get(a.path) ?? a.path).localeCompare(named.get(b.path) ?? b.path))) {
        const name = status === "removed" ? undefined : named.get(c.path);
        lines.push(name ? `- ${name} · ${link(c.path)}` : `- \`${c.path}\``);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

/**
 * The notes to write: the running cycle's, and the one before it once more if its notes predate its end.
 * After that final pass a version's notes are never rewritten, so they record the week as it closed.
 */
export async function planNotes(gql: Gql, root: string, plan: Plan, config: Config, history: History = gitHistory): Promise<Op[]> {
  const cycles = (await gql(`query($k:String!){ cycles(first:10, filter:{ team:{key:{eq:$k}}, or:[{isActive:{eq:true}},{isPrevious:{eq:true}}] }){
      nodes{ id number name startsAt endsAt isActive documents(first:50){ nodes{ id title content updatedAt } } } } }`, { k: config.team })).cycles.nodes as Cycle[];
  if (!cycles.length) return [];
  const issues = await all<Done>(gql,
    `query($k:String!,$after:String){ issues(first:100, after:$after, filter:{ team:{key:{eq:$k}}, description:{contains:"atdd-urn: wmbt:"} }){
       nodes{ identifier url description completedAt state{ type } } pageInfo{ hasNextPage endCursor } } }`, d => d.issues, { k: config.team });
  const ops: Op[] = [];
  for (const c of cycles.sort((a, b) => a.number - b.number)) {
    const doc = c.documents.nodes.find(d => d.title.endsWith(NOTES_SUFFIX));
    if (!c.isActive && doc && doc.updatedAt >= c.endsAt) continue;
    const title = `${c.name ?? `Cycle ${c.number}`}${NOTES_SUFFIX}`;
    const content = mergeDescription(notesBody(c, plan, config, issues, history(root, plan.planRoot, c.startsAt, c.isActive ? undefined : c.endsAt)), doc?.content);
    if (!doc) ops.push({ kind: "create notes", what: title, run: async () => {
      await gql(`mutation($i:DocumentCreateInput!){ documentCreate(input:$i){ success } }`, { i: { title, content, cycleId: c.id, icon: "Rocket" } });
    } });
    else if (doc.title !== title || !sameMarkdown(doc.content, content) || !c.isActive) ops.push({ kind: "update notes", what: `${title}${c.isActive ? "" : " (final, then frozen)"}`, run: async () => {
      await gql(`mutation($id:String!,$i:DocumentUpdateInput!){ documentUpdate(id:$id, input:$i){ success } }`, { id: doc.id, i: { title, content } });
    } });
  }
  return ops;
}
