/**
 * A project is a scope (what we are building, named `<TEAM KEY>: <scope>`), and its milestones are the
 * journeys it delivers; the versions it ships in are cycles, not projects. People create the project and
 * its milestones, and name each milestone's journey as `journey:<id>` in its description; from the plan
 * this writes the project's one-line summary, each milestone's journey in words and pictures, and the
 * project's description. It makes no views: the project's own page groups its issues by milestone, so a
 * view of the same issues would only duplicate it.
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
  /** retired: `release` no longer makes views; kept so an older lock still reads */
  releases?: Record<string, Record<string, string>>;
  /** repository path -> the Linear document mirroring it */
  documents?: Record<string, { id: string; url: string }>;
  /** sha256 of an uploaded image -> its Linear asset URL, so an unchanged image is never uploaded twice */
  assets?: Record<string, string>;
};

export const readLock = (root: string): Lock =>
  existsSync(join(root, LOCK_FILE)) ? JSON.parse(readFileSync(join(root, LOCK_FILE), "utf8")) : {};
export const writeLock = (root: string, lock: Lock) => writeFileSync(join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + "\n");

export async function planRelease(gql: Gql, root: string, projectName: string, config: Config): Promise<Op[]> {
  const found = (await gql(`query($n:String!){ projects(filter:{name:{eq:$n}}){ nodes{ id name description content projectMilestones{ nodes{ id name description sortOrder } } } } }`, { n: projectName })).projects.nodes;
  if (found.length !== 1) throw new Error(`expected one project named "${projectName}", found ${found.length}`);
  const project = found[0];
  const lock = readLock(root);
  const plan = await readPlan(root);
  const ops: Op[] = [];
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
  return ops;
}
