/**
 * The repository's documentation, where the people planning in Linear read it.
 *
 * Pages listed under `documents:` become Linear team documents, converted from AsciiDoc and rewritten
 * on every sync: the repository owns them, so an edit made in Linear is overwritten and belongs in the
 * repository instead. A cross-reference to another mirrored page points at its Linear document; any
 * other points at the file on GitHub.
 *
 * A release's description opens with the summary page's headline, then shows each milestone's journey
 * as the map `atdd-bun docs journeys` draws. Images are rasterised to PNG and uploaded to Linear, which
 * cannot read a private repository, and each is remembered by its content hash so an unchanged image is
 * never uploaded twice.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { asciidocToMarkdown, inline } from "./asciidoc.ts";
import type { Config } from "./config.ts";
import type { Gql } from "./linear.ts";
import type { Journey, Plan } from "./plan.ts";
import type { Lock } from "./release.ts";
import type { Op } from "./sync.ts";
import { sameMarkdown } from "./render.ts";

/** `../architecture/x.adoc` seen from `docs/purpose/boundary.adoc` -> `docs/architecture/x.adoc`. */
export const resolveFrom = (from: string, target: string) => normalize(join(dirname(from), target)).replace(/\\/g, "/");

/** Where a cross-reference leads: the mirrored Linear document if there is one, else the file on GitHub. */
export function linkFor(from: string, lock: Lock, repo: string) {
  return (target: string, anchor: string | undefined) => {
    const path = target ? resolveFrom(from, target) : from;
    const mirrored = lock.documents?.[path];
    if (mirrored) return mirrored.url;
    return `${repo}/blob/main/${path}${anchor ? `#${anchor}` : ""}`;
  };
}

export const footer = (path: string, repo: string) =>
  `\n---\n*Synced from [${path}](${repo}/blob/main/${path}). Edit the repository, not this document: the next sync rewrites it.*\n`;

/**
 * Resolve every `var(--name, fallback)` to its fallback: the renderer does not implement CSS custom
 * properties, and the fallback is what the drawing shows wherever its stylesheet is absent.
 */
export function withoutCssVariables(svg: string): string {
  let out = svg;
  for (let i = 0; i < 8 && /var\(--/.test(out); i++) out = out.replace(/var\(--[\w-]+\s*,\s*([^()]*(?:\([^()]*\))?[^()]*)\)/g, "$1");
  return out;
}

export function rasterize(svg: string, width = 1440): Uint8Array {
  return new Resvg(withoutCssVariables(svg), { background: "white", fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } }).render().asPng();
}

/** Upload an image once: a hash already in the lock is its asset URL. */
export async function upload(gql: Gql, bytes: Uint8Array, filename: string, lock: Lock): Promise<string> {
  const hash = createHash("sha256").update(bytes).digest("hex");
  lock.assets ??= {};
  if (lock.assets[hash]) return lock.assets[hash]!;
  const r = await gql(`mutation($c:String!,$f:String!,$s:Int!){ fileUpload(contentType:$c, filename:$f, size:$s){ uploadFile{ uploadUrl assetUrl headers{ key value } } } }`,
    { c: "image/png", f: filename, s: bytes.length });
  const file = r.fileUpload.uploadFile;
  const headers: Record<string, string> = { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000" };
  for (const h of file.headers ?? []) headers[h.key] = h.value;
  const put = await fetch(file.uploadUrl, { method: "PUT", headers, body: bytes });
  if (!put.ok) throw new Error(`uploading ${filename} failed: HTTP ${put.status}`);
  lock.assets[hash] = file.assetUrl;
  return file.assetUrl;
}

type Doc = { id: string; url: string; title: string; content: string | null; archivedAt: string | null; trashed: boolean | null };

/**
 * The team documents mirroring `config.documents`. A missing one is created first, empty, so every
 * mirrored page has a URL before any page's links are written; then each page's content is compared
 * and rewritten where it differs.
 */
export async function planDocuments(gql: Gql, root: string, config: Config, teamId: string, lock: Lock, save: () => void): Promise<Op[]> {
  const ops: Op[] = [];
  lock.documents ??= {};
  const current = new Map<string, Doc>();
  for (const [path, ref] of Object.entries(lock.documents)) {
    const doc = (await gql(`query($id:String!){ document(id:$id){ id url title content archivedAt trashed } }`, { id: ref.id }).catch(() => null))?.document as Doc | undefined;
    if (doc && !doc.archivedAt && !doc.trashed) current.set(path, doc);
    else delete lock.documents[path];
  }
  const pages = config.documents.map(path => {
    if (!existsSync(join(root, path))) throw new Error(`atdd-linear.yaml lists ${path}, which does not exist`);
    return { path, source: readFileSync(join(root, path), "utf8") };
  });

  for (const { path, source } of pages) {
    if (current.has(path)) continue;
    const title = asciidocToMarkdown(source, () => "").title || path;
    ops.push({ kind: "create document", what: `${title}  (${path})`, run: async () => {
      const r = await gql(`mutation($i:DocumentCreateInput!){ documentCreate(input:$i){ document{ id url } } }`, { i: { title, teamId, content: "" } });
      lock.documents![path] = { id: r.documentCreate.document.id, url: r.documentCreate.document.url };
      save();
    } });
  }
  for (const { path, source } of pages) {
    const existing = current.get(path);
    // Links are resolved when the op runs, so a page created in this same run is linked to, not to GitHub.
    const render = () => {
      const converted = asciidocToMarkdown(source, linkFor(path, lock, config.repo));
      return { title: converted.title || path, content: converted.markdown + footer(path, config.repo), warnings: converted.warnings };
    };
    const preview = render();
    for (const w of preview.warnings) console.log(`warning: ${path}: ${w}`);
    if (existing && existing.title === preview.title && sameMarkdown(existing.content, preview.content)) continue;
    ops.push({ kind: existing ? "update document" : "write document", what: `${preview.title}  (${path})`, run: async () => {
      const { title, content } = render();
      await gql(`mutation($id:String!,$i:DocumentUpdateInput!){ documentUpdate(id:$id, input:$i){ success } }`, { id: lock.documents![path]!.id, i: { title, content } });
    } });
  }
  return ops;
}

/** The first paragraph after `[.headline]`, or else the first paragraph: what the page is, in one breath. */
export function headline(source: string): string {
  const lines = source.split("\n");
  const at = lines.findIndex(l => l.trim() === "[.headline]");
  const from = at >= 0 ? at + 1 : lines.findIndex((l, i) => i > 0 && l.trim() && !/^[:=\[\/]/.test(l));
  const para: string[] = [];
  for (let i = from; i >= 0 && i < lines.length && lines[i]!.trim(); i++) para.push(lines[i]!.trim());
  return para.join(" ");
}

/** A milestone names its journey as `journey:<id>` in its description; that is how its map is found. */
export const journeyOf = (milestoneDescription: string | null | undefined) => milestoneDescription?.match(/\bjourney:([a-z0-9-]+)/)?.[1];

export type Milestone = { id: string; name: string; description: string | null; sortOrder: number };

/** How an image becomes a URL: a dry run only looks it up; applying uploads it. */
export type ImageUrl = (bytes: Uint8Array, filename: string) => Promise<string>;

/** A dry run's images: the asset URL when the lock already has it, else a marker counted as pending. */
export function lookupImages(lock: Lock) {
  const pending: string[] = [];
  const url: ImageUrl = async (bytes, filename) => {
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (lock.assets?.[hash]) return lock.assets[hash]!;
    pending.push(filename);
    return `pending-upload:${hash}`;
  };
  return { url, pending };
}

const KINDS = ["nominal", "error", "alternate", "exception"];
const mode = (title: string) => title.match(/\((PLAY|RUN)\)/)?.[1];
const human = (s: string) => s.replace(/-/g, " ").replace(/^./, c => c.toUpperCase());

/** A journey in words, from the plan: how it starts, what it passes through, and every way it ends. */
export function journeyText(j: Journey, plan: Plan): string {
  const title = (slug: string) => plan.interlockings.find(i => i.slug === slug)?.title || slug;
  const category = (from: string, routeId: string) => plan.interlockings.find(i => i.slug === from)?.routes.find(r => r.routeId === routeId)?.category || "other";
  const out: string[] = [];
  const facets = [`\`${j.id}\``, mode(j.title) ? `**${mode(j.title)}** mode` : "", j.exposed ? `started by ${j.actions.map(a => `\`${a}\``).join(" or ")}` : "internal: no one starts it directly", j.surfaces.length ? `on ${j.surfaces.join(" and ")}` : ""].filter(Boolean);
  out.push(facets.join(" · "), "");
  const chain = [title(j.entry), ...j.continuations.map(c => `${title(c.to)} *(on \`${c.artifact}\`)*`)];
  out.push(`**Passes through:** ${chain.join(" → ")}`, "");
  out.push("**Ends in:**", "");
  for (const kind of [...KINDS, "other"]) for (const t of j.terminals.filter(t => category(t.from, t.routeId) === kind)) {
    out.push(`- *${kind}* · ${human(t.routeId)}: ${t.outcome}`);
  }
  return out.join("\n").trim();
}

/** The two pictures of a journey `atdd-bun docs journeys` draws: its map, and its nominal path end to end. */
export async function journeyImages(root: string, config: Config, id: string, name: string, image: ImageUrl): Promise<string[]> {
  const out: string[] = [];
  for (const [file, label] of [[`journey-${id}.svg`, "journey map"], [`path-${id}-nominal.svg`, "nominal path, end to end"]] as const) {
    const svg = join(root, config.journeyView, "svg", file);
    if (existsSync(svg)) out.push(`![${name}: ${label}](${await image(rasterize(readFileSync(svg, "utf8")), file.replace(/\.svg$/, ".png"))})`, "");
  }
  return out;
}

/** The synced block of a milestone's description: its journey in words, then its two pictures. */
export async function milestoneBody(root: string, config: Config, plan: Plan, journeyId: string, image: ImageUrl): Promise<string> {
  const j = plan.journeys.find(x => x.id === `journey:${journeyId}`);
  if (!j) return `\`journey:${journeyId}\` names no journey in the plan.`;
  return [journeyText(j, plan), "", ...await journeyImages(root, config, journeyId, j.title, image)].join("\n").trim();
}

/** The one-line summary Linear shows under a release's name: the journeys it delivers, in order. */
export function releaseSummary(milestones: Milestone[], plan: Plan): string {
  const titles = [...milestones].sort((a, b) => a.sortOrder - b.sortOrder)
    .map(m => plan.journeys.find(j => j.id === `journey:${journeyOf(m.description)}`)?.title.replace(/\s*\((PLAY|RUN)\)$/, "") ?? m.name.replace(/^\d+\s*·\s*/, ""));
  const text = `Delivers ${titles.length} journey${titles.length === 1 ? "" : "s"}: ${titles.join(" → ")}.`;
  return text.length <= 255 ? text : `${text.slice(0, 252)}…`;
}

/** The synced block of a release's description: the product in one paragraph, then each journey's map. */
export async function releaseBody(root: string, config: Config, plan: Plan, lock: Lock, projectName: string, milestones: Milestone[], image: ImageUrl): Promise<string> {
  const out: string[] = [];
  if (config.summary && existsSync(join(root, config.summary))) {
    out.push(inline(headline(readFileSync(join(root, config.summary), "utf8")), linkFor(config.summary, lock, config.repo)), "");
  }
  const docs = Object.entries(lock.documents ?? {});
  if (docs.length) {
    const titles = new Map(config.documents.map(p => [p, asciidocToMarkdown(readFileSync(join(root, p), "utf8"), () => "").title || p]));
    out.push(`**Read first:** ${docs.map(([p, d]) => `[${titles.get(p) ?? p}](${d.url})`).join(" · ")}`, "");
  }
  out.push(`## The journeys in ${projectName}`, "", "Each milestone is a journey, delivered in this order. A feature sits in the earliest journey that needs it.", "");
  for (const m of [...milestones].sort((a, b) => a.sortOrder - b.sortOrder)) {
    out.push(`### ${m.name}`, "");
    const id = journeyOf(m.description), j = id ? plan.journeys.find(x => x.id === `journey:${id}`) : undefined;
    if (!id || !j) { out.push(`*This milestone names no journey: add \`journey:<id>\` to its description.*`, ""); continue; }
    const start = j.exposed ? `Starts with ${j.actions.map(a => `\`${a}\``).join(" or ")}` : "Internal";
    out.push(`${start}; ${j.terminals.length} outcome${j.terminals.length === 1 ? "" : "s"}. The milestone has the full journey.`, "");
    out.push(...await journeyImages(root, config, id, j.title, image));
  }
  return out.join("\n").trim();
}
