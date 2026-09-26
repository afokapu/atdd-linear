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

/** The synced block of a release's description: the product in one paragraph, then each journey's map. */
export async function releaseBody(root: string, config: Config, lock: Lock, projectName: string, milestones: Milestone[], image: ImageUrl): Promise<string> {
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
    const first = String(m.description ?? "").split(". ").slice(1).join(". ").trim();
    if (first) out.push(first, "");
    const id = journeyOf(m.description), svg = id && join(root, config.journeyView, "svg", `journey-${id}.svg`);
    if (svg && existsSync(svg)) {
      const url = await image(rasterize(readFileSync(svg, "utf8")), `journey-${id}.png`);
      out.push(`![${m.name}: journey map](${url})`, "");
    }
  }
  return out.join("\n").trim();
}
