/**
 * Bring a repository's Linear team in line with its plan.
 *
 * What the repository owns, the sync overwrites: titles, the synced part of a description, the
 * parent, the `wagon` label, the `train:` labels, and whether a WMBT is Done. What Linear owns, it
 * never touches: project (the release), milestone (the journey inside it), cycle, assignee, priority,
 * estimate, comments, other labels, and anything written under the notes marker. A new issue lands in
 * the team with no project, unscheduled until someone plans it. Removing something from the plan
 * cancels its issue with a comment; nothing is ever deleted, so history survives a mistake.
 */
import { colorFor, type Config } from "./config.ts";
import { featureProgress, progressOf, type Progress, type TestEvidence } from "./evidence.ts";
import { all, type Gql } from "./linear.ts";
import type { Plan } from "./plan.ts";
import { featureBody, featureTitle, mergeDescription, sameMarkdown, urnIn, wmbtBody, wmbtTitle } from "./render.ts";

export const WAGON_GROUP = "wagon";
export type Op = { kind: string; what: string; run: () => Promise<void> };

type Label = { id: string; name: string; isGroup: boolean; parent: { id: string; name: string } | null };
type Issue = {
  id: string; identifier: string; title: string; description: string | null;
  parent: { id: string } | null; state: { id: string; type: string }; labels: { nodes: Label[] };
};
type State = { id: string; type: string; position: number };

async function readWorkspace(gql: Gql, teamKey: string) {
  const t = await gql(`query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes{ id key name states{ nodes{ id name type position } } } } }`, { k: teamKey });
  const team = t.teams.nodes[0];
  if (!team) throw new Error(`no Linear team with key ${teamKey}`);
  const labels = await all<Label>(gql,
    `query($t:ID!,$after:String){ issueLabels(first:250, after:$after, filter:{team:{id:{eq:$t}}}){
       nodes{ id name isGroup parent{ id name } } pageInfo{ hasNextPage endCursor } } }`, d => d.issueLabels, { t: team.id });
  const issues = await all<Issue>(gql,
    `query($t:ID!,$after:String){ issues(first:100, after:$after, includeArchived:false,
       filter:{ team:{id:{eq:$t}}, description:{contains:"atdd-urn:"} }){
       nodes{ id identifier title description parent{ id } state{ id type } labels{ nodes{ id name isGroup parent{ id name } } } }
       pageInfo{ hasNextPage endCursor } } }`, d => d.issues, { t: team.id });
  const views = await gql(`query{ customViews(first:250){ nodes{ id name description filterData team{ id } } } }`);
  return {
    team, states: team.states.nodes as State[],
    group: labels.find(l => l.isGroup && l.name === WAGON_GROUP),
    wagonLabels: new Map(labels.filter(l => l.parent?.name === WAGON_GROUP).map(l => [l.name, l.id])),
    trainLabels: new Map(labels.filter(l => !l.parent && l.name.startsWith("train:")).map(l => [l.name, l.id])),
    issues: new Map(issues.map(i => [urnIn(i.description)!, i])),
    views: new Map<string, { id: string; description: string; filterData: unknown }>(
      views.customViews.nodes.filter((v: any) => v.team?.id === team.id).map((v: any) => [v.name, v])),
  };
}

/** The labels the sync owns on an issue: its wagon, and its `train:` labels. Everything else is a person's. */
const owned = (l: Label) => l.parent?.name === WAGON_GROUP || (!l.parent && l.name.startsWith("train:"));

/** Tests decide Done in both directions; people decide everything short of it. */
export function stateFor(progress: Progress, current: { type: string } | undefined, states: State[]): string | undefined {
  const first = (type: string) => states.filter(s => s.type === type).sort((a, b) => a.position - b.position)[0]?.id;
  const type = current?.type ?? "backlog";
  if (progress === "done" && type !== "completed") return first("completed");
  if (progress !== "done" && type === "completed") return first("started");
  if (progress === "started" && (type === "backlog" || type === "unstarted")) return first("started");
  if (type === "canceled") return first("backlog");
  return current ? undefined : first("backlog");
}

/**
 * The changes that would bring the team in line with the plan, each ready to run. `scoped` says the
 * plan is a slice (`--scope`), in which case nothing is cancelled: a slice cannot tell "removed" from
 * "out of scope".
 */
export async function planSync(gql: Gql, p: Plan, evidence: TestEvidence, config: Config, scoped = false): Promise<Op[]> {
  const ws = await readWorkspace(gql, config.team);
  const ops: Op[] = [];
  const ids = { group: ws.group?.id };
  const createLabel = async (i: Record<string, unknown>) =>
    (await gql(`mutation($i:IssueLabelCreateInput!){ issueLabelCreate(input:$i){ issueLabel{ id } } }`, { i: { teamId: ws.team.id, ...i } })).issueLabelCreate.issueLabel.id as string;

  if (!ids.group) ops.push({ kind: "create group", what: `${WAGON_GROUP} (single-select)`, run: async () => {
    ids.group = await createLabel({ name: WAGON_GROUP, isGroup: true, color: "#5E6863", description: "The wagon (domain) an issue belongs to. Exactly one per issue." });
  } });
  for (const w of p.wagons) {
    if (ws.wagonLabels.has(w.slug)) continue;
    ops.push({ kind: "create label", what: `${WAGON_GROUP} / ${w.slug}`, run: async () => {
      ws.wagonLabels.set(w.slug, await createLabel({ name: w.slug, parentId: ids.group, description: `${w.description} · theme ${w.theme} · ${config.repo}/tree/main/${w.dir}` }));
    } });
  }

  const allWmbts = [...p.features.flatMap(f => f.wmbts), ...p.loose];
  const trains = [...new Set(allWmbts.flatMap(w => w.trains))].sort();
  const pathOf = new Map(p.interlockings.map(i => [i.slug, i.path]));
  for (const t of trains) {
    const name = `train:${t}`;
    if (ws.trainLabels.has(name)) continue;
    ops.push({ kind: "create label", what: name, run: async () => {
      ws.trainLabels.set(name, await createLabel({ name, color: colorFor(t, config.colors), description: `interlocking:${t} · ${pathOf.get(t) ?? ""}` }));
    } });
  }

  // Issues. A sub-issue is planned after its parent, so the parent's id exists when it runs.
  const issueIds = new Map<string, string>([...ws.issues].map(([urn, i]) => [urn, i.id]));
  const labelIds = (wagon: string, trainsOf: string[]) => [ws.wagonLabels.get(wagon), ...trainsOf.map(t => ws.trainLabels.get(`train:${t}`))];
  const upsert = (urn: string, title: string, body: string, wagon: string, trainsOf: string[], progress: Progress, parentUrn?: string) => {
    const existing = ws.issues.get(urn);
    const description = mergeDescription(body, existing?.description);
    const stateId = stateFor(progress, existing?.state, ws.states);
    if (!existing) {
      ops.push({ kind: parentUrn ? "create sub-issue" : "create issue", what: `${title}  (${urn})`, run: async () => {
        const r = await gql(`mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue{ id } } }`, { i: {
          teamId: ws.team.id, title, description, stateId,
          parentId: parentUrn ? issueIds.get(parentUrn) : undefined,
          labelIds: labelIds(wagon, trainsOf).filter(Boolean),
        } });
        issueIds.set(urn, r.issueCreate.issue.id);
      } });
      return;
    }
    const want = new Set([`${WAGON_GROUP}/${wagon}`, ...trainsOf.map(t => `train:${t}`)]);
    const have = new Set(existing.labels.nodes.filter(owned).map(l => (l.parent ? `${l.parent.name}/${l.name}` : l.name)));
    const kept = existing.labels.nodes.filter(l => !owned(l)).map(l => l.id);
    const changes: string[] = [];
    if (existing.title !== title) changes.push("title");
    if (!sameMarkdown(existing.description, description)) changes.push("description");
    if ((existing.parent?.id ?? undefined) !== (parentUrn ? issueIds.get(parentUrn) : undefined)) changes.push("parent");
    if (want.size !== have.size || [...want].some(n => !have.has(n))) changes.push("labels");
    if (stateId) changes.push("status");
    if (!changes.length) return;
    ops.push({ kind: "update", what: `${existing.identifier} ${title}: ${changes.join(", ")}`, run: async () => {
      await gql(`mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id, input:$i){ success } }`, { id: existing.id, i: {
        title, description, parentId: parentUrn ? issueIds.get(parentUrn) : null, ...(stateId ? { stateId } : {}),
        labelIds: [...kept, ...labelIds(wagon, trainsOf)].filter(Boolean),
      } });
    } });
  };

  const inPlan = new Set<string>();
  for (const f of p.features) {
    inPlan.add(f.urn);
    upsert(f.urn, featureTitle(f), featureBody(f, config.repo), f.wagon, f.trains, featureProgress(f, evidence));
    for (const w of f.wmbts) {
      inPlan.add(w.urn);
      upsert(w.urn, wmbtTitle(w), wmbtBody(w, config.repo, evidence), f.wagon, w.trains, progressOf(w, evidence), f.urn);
    }
  }
  // A WMBT no feature owns is an issue of its own, so a plan without features still reaches Linear.
  for (const w of p.loose) {
    inPlan.add(w.urn);
    upsert(w.urn, wmbtTitle(w), wmbtBody(w, config.repo, evidence), w.wagon, w.trains, progressOf(w, evidence));
  }

  if (!scoped) {
    const canceled = ws.states.find(s => s.type === "canceled")?.id;
    for (const [urn, i] of ws.issues) {
      if (inPlan.has(urn) || i.state.type === "canceled") continue;
      ops.push({ kind: "cancel", what: `${i.identifier} ${i.title}  (${urn} is no longer in the plan)`, run: async () => {
        await gql(`mutation($id:String!,$s:String!){ issueUpdate(id:$id, input:{stateId:$s}){ success } }`, { id: i.id, s: canceled });
        await gql(`mutation($i:CommentCreateInput!){ commentCreate(input:$i){ success } }`,
          { i: { issueId: i.id, body: `Canceled by the plan sync: \`${urn}\` no longer exists in ${config.repo}/tree/main/${p.planRoot}. Restore it in the plan to reopen this issue.` } });
      } });
    }
  }

  // Views: one per interlocking over the top-level issues, one per journey over its interlockings.
  const view = (name: string, description: string, labels: string[], color: string) => {
    const filterData = { and: [{ labels: { name: { in: labels } } }, { parent: { null: true } }] };
    const existing = ws.views.get(name), id = existing?.id;
    if (existing && existing.description === description && JSON.stringify(existing.filterData) === JSON.stringify(filterData)) return;
    ops.push({ kind: id ? "update view" : "create view", what: name, run: async () => {
      if (id) await gql(`mutation($id:String!,$i:CustomViewUpdateInput!){ customViewUpdate(id:$id, input:$i){ success } }`, { id, i: { description, filterData } });
      else await gql(`mutation($i:CustomViewCreateInput!){ customViewCreate(input:$i){ success } }`,
        { i: { name, description, teamId: ws.team.id, shared: true, icon: "Rocket", color, filterData } });
    } });
  };
  for (const i of p.interlockings) {
    if (!trains.includes(i.slug)) continue;
    view(`Train · ${i.slug}`, `${i.title}. Features serving interlocking:${i.slug} (${i.routes.length} routes). Source: ${i.path}`, [`train:${i.slug}`], colorFor(i.slug, config.colors));
  }
  for (const j of p.journeys) {
    view(`Journey · ${j.title}`, `${j.id}: features across ${j.interlockings.join(" → ")}. Source: ${j.path}`, j.interlockings.map(i => `train:${i}`), "#1F6B52");
  }
  return ops;
}

/** Run the planned changes in order; a failure stops the run, which is safe to repeat. */
export async function apply(ops: Op[], log: (line: string) => void = console.log): Promise<number> {
  let done = 0;
  for (const o of ops) {
    try { await o.run(); done++; }
    catch (e) { throw new Error(`stopped at "${o.kind} ${o.what}": ${(e as Error).message}. ${done}/${ops.length} applied; the sync is safe to re-run.`); }
  }
  log(`applied ${done}/${ops.length}`);
  return done;
}
