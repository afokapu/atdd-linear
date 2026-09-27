/**
 * A release is a Linear project, and its milestones are the journeys it delivers. People create both;
 * this gives a release its views: every feature in it, and one view per milestone.
 *
 * Linear's API lists no project-scoped view (neither `customViews` nor `project.facets` returns one),
 * so a view created here is recorded by id in `atdd-linear.lock.json`, committed beside the config.
 * The lock, not a listing, says what exists, and a view deleted in Linear is dropped from it and made
 * again on the next run.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { journeyOf, lookupImages, milestoneBody, releaseBody, releaseSummary, upload, type Milestone } from "./docs.ts";
import { readPlan } from "./plan.ts";
import type { Gql } from "./linear.ts";
import { mergeDescription, sameMarkdown } from "./render.ts";
import type { Op } from "./sync.ts";

export const LOCK_FILE = "atdd-linear.lock.json";
export type Lock = {
  releases: Record<string, Record<string, string>>;
  /** repository path -> the Linear document mirroring it */
  documents?: Record<string, { id: string; url: string }>;
  /** sha256 of an uploaded image -> its Linear asset URL, so an unchanged image is never uploaded twice */
  assets?: Record<string, string>;
};

export const readLock = (root: string): Lock =>
  existsSync(join(root, LOCK_FILE)) ? { releases: {}, ...JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) } : { releases: {} };
export const writeLock = (root: string, lock: Lock) => writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");

/** A view's description: the milestone's first sentence, within Linear's limit for view descriptions. */
export const viewDescription = (text: string) => `${text.split(". ")[0]!.replace(/\.$/, "")}.`.slice(0, 250);

/**
 * `views: false` plans the description alone, for a release whose views were made before this lock
 * existed: they cannot be listed, so making them again would duplicate them.
 */
export async function planRelease(gql: Gql, root: string, projectName: string, config: Config, views = true): Promise<Op[]> {
  const found = (await gql(`query($n:String!){ projects(filter:{name:{eq:$n}}){ nodes{ id name description content projectMilestones{ nodes{ id name description sortOrder } } } } }`, { n: projectName })).projects.nodes;
  if (found.length !== 1) throw new Error(`expected one project named "${projectName}", found ${found.length}`);
  const project = found[0];
  const lock = readLock(root);
  const recorded = lock.releases[project.id] ?? {};
  for (const [name, id] of Object.entries(recorded)) {
    const view = (await gql(`query($id:String!){ customView(id:$id){ id archivedAt } }`, { id }).catch(() => null))?.customView;
    if (!view || view.archivedAt) delete recorded[name];
  }

  const inProject = { project: { id: { eq: project.id } } }, features = { parent: { null: true } };
  const wanted = [
    { name: `${project.name} · All features`, description: `Every feature planned for ${project.name}, across its journeys.`, filterData: { and: [inProject, features] } },
    ...[...project.projectMilestones.nodes].sort((a: any, b: any) => a.sortOrder - b.sortOrder).map((m: any) => ({
      name: `${project.name} · ${m.name}`, description: viewDescription(String(m.description ?? m.name)),
      filterData: { and: [inProject, { projectMilestone: { id: { eq: m.id } } }, features] },
    })),
  ];
  const ops: Op[] = [];
  const plan = await readPlan(root);
  const milestones = project.projectMilestones.nodes as Milestone[];
  const dry = lookupImages(lock);
  const uploads = async (bytes: Uint8Array, name: string) => { const url = await upload(gql, bytes, name, lock); writeLock(root, lock); return url; };
  const pending = () => { const p = [...new Set(dry.pending)]; dry.pending.length = 0; return p.length ? ` (uploads ${p.join(", ")})` : ""; };

  // The one-line summary under the release's name: the journeys it delivers, in order.
  const summary = releaseSummary(milestones, plan);
  if (project.description !== summary) ops.push({ kind: "update summary", what: `${project.name}: ${summary}`, run: async () => {
    await gql(`mutation($id:String!,$i:ProjectUpdateInput!){ projectUpdate(id:$id, input:$i){ success } }`, { id: project.id, i: { description: summary } });
  } });

  // Each milestone: its journey in words and pictures above the notes marker, a person's text below it.
  // The journey is read from the `journey:<id>` a person wrote, which the synced block then carries itself.
  for (const m of milestones) {
    const id = journeyOf(m.description);
    if (!id) continue;
    const preview = mergeDescription(await milestoneBody(root, config, plan, id, dry.url), m.description);
    const note = pending();
    if (note || !sameMarkdown(m.description, preview)) ops.push({ kind: "update milestone", what: `${m.name}${note}`, run: async () => {
      const description = mergeDescription(await milestoneBody(root, config, plan, id, uploads), m.description);
      await gql(`mutation($id:String!,$i:ProjectMilestoneUpdateInput!){ projectMilestoneUpdate(id:$id, input:$i){ success } }`, { id: m.id, i: { description } });
    } });
  }

  // The release's description: the product in one paragraph, then each journey's pictures.
  const preview = mergeDescription(await releaseBody(root, config, plan, lock, project.name, milestones, dry.url), project.content);
  const note = pending();
  if (note || !sameMarkdown(project.content, preview)) {
    ops.push({ kind: "update description", what: `${project.name}${note}`, run: async () => {
      const body = await releaseBody(root, config, plan, lock, project.name, milestones, uploads);
      await gql(`mutation($id:String!,$i:ProjectUpdateInput!){ projectUpdate(id:$id, input:$i){ success } }`, { id: project.id, i: { content: mergeDescription(body, project.content) } });
    } });
  }
  if (!views) return ops;
  return [...ops, ...wanted.filter(v => !recorded[v.name]).map(v => ({
    kind: "create view", what: v.name, run: async () => {
      const r = await gql(`mutation($i:CustomViewCreateInput!){ customViewCreate(input:$i){ customView{ id } } }`,
        { i: { ...v, projectId: project.id, shared: true, icon: "Rocket", color: "#1F6B52" } });
      recorded[v.name] = r.customViewCreate.customView.id;
      lock.releases[project.id] = recorded;
      writeLock(root, lock);   // after every view, so a failure part way never forgets one it made
    },
  }))];
}
