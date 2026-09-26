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
import type { Gql } from "./linear.ts";
import type { Op } from "./sync.ts";

export const LOCK_FILE = "atdd-linear.lock.json";
type Lock = { releases: Record<string, Record<string, string>> };

export const readLock = (root: string): Lock =>
  existsSync(join(root, LOCK_FILE)) ? JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) : { releases: {} };
export const writeLock = (root: string, lock: Lock) => writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");

/** A view's description: the milestone's first sentence, within Linear's limit for view descriptions. */
export const viewDescription = (text: string) => `${text.split(". ")[0]!.replace(/\.$/, "")}.`.slice(0, 250);

export async function planRelease(gql: Gql, root: string, projectName: string): Promise<Op[]> {
  const found = (await gql(`query($n:String!){ projects(filter:{name:{eq:$n}}){ nodes{ id name projectMilestones{ nodes{ id name description sortOrder } } } } }`, { n: projectName })).projects.nodes;
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
  return wanted.filter(v => !recorded[v.name]).map(v => ({
    kind: "create view", what: v.name, run: async () => {
      const r = await gql(`mutation($i:CustomViewCreateInput!){ customViewCreate(input:$i){ customView{ id } } }`,
        { i: { ...v, projectId: project.id, shared: true, icon: "Rocket", color: "#1F6B52" } });
      recorded[v.name] = r.customViewCreate.customView.id;
      lock.releases[project.id] = recorded;
      writeLock(root, lock);   // after every view, so a failure part way never forgets one it made
    },
  }));
}
