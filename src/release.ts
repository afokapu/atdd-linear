/**
 * A release is a Linear project, and its milestones are the journeys it delivers. People create both,
 * and name each milestone's journey as `journey:<id>` in its description; from the plan this writes the
 * release's one-line summary, each milestone's journey in words and pictures, the release's description,
 * and a team view per milestone plus one for the whole release.
 *
 * `atdd-linear.lock.json` records what Linear cannot be asked for again: the mirrored documents and the
 * uploaded images by content hash.
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
  /** retired: release views are team views now, found by name */
  releases?: Record<string, Record<string, string>>;
  /** repository path -> the Linear document mirroring it */
  documents?: Record<string, { id: string; url: string }>;
  /** sha256 of an uploaded image -> its Linear asset URL, so an unchanged image is never uploaded twice */
  assets?: Record<string, string>;
};

export const readLock = (root: string): Lock =>
  existsSync(join(root, LOCK_FILE)) ? JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) : {};
export const writeLock = (root: string, lock: Lock) => writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");

/** A view's description: the milestone's first sentence, within Linear's limit for view descriptions. */
export const viewDescription = (text: string) => `${text.split(". ")[0]!.replace(/\.$/, "")}.`.slice(0, 250);

/** `views: false` plans the summary, milestones and description, and leaves the release's views alone. */
export async function planRelease(gql: Gql, root: string, projectName: string, config: Config, views = true): Promise<Op[]> {
  const found = (await gql(`query($n:String!){ projects(filter:{name:{eq:$n}}){ nodes{ id name description content projectMilestones{ nodes{ id name description sortOrder } } } } }`, { n: projectName })).projects.nodes;
  if (found.length !== 1) throw new Error(`expected one project named "${projectName}", found ${found.length}`);
  const project = found[0];
  const lock = readLock(root);
  // Release views are team views: the public API accepts a projectId on a view but attaches it to
  // nothing (no facet, no team, absent from every listing), so a view scoped that way is unreachable.
  // A team view filtered to the release is listed, so it is found by name like the train views.
  const t = await gql(`query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes{ id } } }`, { k: config.team });
  const teamId = t.teams.nodes[0]?.id;
  if (!teamId) throw new Error(`no Linear team with key ${config.team}`);
  const existingViews = new Map<string, { id: string; description: string; filterData: unknown }>(
    (await gql(`query{ customViews(first:250){ nodes{ id name description filterData team{ id } } } }`)).customViews.nodes
      .filter((v: any) => v.team?.id === teamId).map((v: any) => [v.name, v]));

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
  for (const v of wanted) {
    const existing = existingViews.get(v.name);
    if (existing && existing.description === v.description && JSON.stringify(existing.filterData) === JSON.stringify(v.filterData)) continue;
    ops.push({ kind: existing ? "update view" : "create view", what: v.name, run: async () => {
      if (existing) await gql(`mutation($id:String!,$i:CustomViewUpdateInput!){ customViewUpdate(id:$id, input:$i){ success } }`, { id: existing.id, i: { description: v.description, filterData: v.filterData } });
      else await gql(`mutation($i:CustomViewCreateInput!){ customViewCreate(input:$i){ success } }`, { i: { ...v, teamId, shared: true, icon: "Rocket", color: "#1F6B52" } });
    } });
  }
  return ops;
}
