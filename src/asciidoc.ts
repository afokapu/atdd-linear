/**
 * AsciiDoc to the Markdown Linear renders, for the constructs repository documentation uses: headings,
 * paragraphs, roles, anchors, tables, lists, emphasis, monospace, passthroughs, cross-references and
 * links. A construct it does not know is kept as plain text and reported, never dropped in silence.
 */
export type LinkResolver = (target: string, anchor: string | undefined) => string;
export type Converted = { title: string; markdown: string; warnings: string[] };

const ENTITIES: Record<string, string> = { "&middot;": "·", "&mdash;": "—", "&ndash;": "–", "&rarr;": "→", "&larr;": "←", "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&hellip;": "…", "&times;": "×" };

/** Inline markup: cross-references and links first (their labels are then formatted like any text). */
export function inline(text: string, link: LinkResolver): string {
  const stash: string[] = [];
  const keep = (s: string) => `\u0000${stash.push(s) - 1}\u0000`;
  let s = text
    // `+literal+` and +literal+ are passthroughs: the characters inside are not markup.
    .replace(/`\+([^`]*?)\+`/g, (_, x) => keep("`" + x + "`"))
    .replace(/`([^`]+)`/g, (_, x) => keep("`" + x + "`"))
    .replace(/(^|[^\w])\+([^+\n]+?)\+(?=[^\w]|$)/g, (_, pre, x) => pre + keep(x))
    .replace(/xref:([^\[\s]+?)(?:#([\w.-]+))?\[([^\]]*)\]/g, (_, path, anchor, label) => keep(`[${label || path}](${link(path, anchor)})`))
    .replace(/<<([\w.-]+)(?:,([^>]*))?>>/g, (_, anchor, label) => keep(`[${label || anchor}](${link("", anchor)})`))
    .replace(/(?:link:)?(https?:\/\/[^\s\[]+)\[([^\]]*)\]/g, (_, url, label) => keep(`[${label || url}](${url})`));
  s = s
    .replace(/&[a-z]+;/g, e => ENTITIES[e] ?? e)
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1**$2**")
    .replace(/(^|[^\w_])_([^_\s][^_]*?)_(?=[^\w_]|$)/g, "$1*$2*");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]!);
}

/** Split a table's body into cells; a line not starting with `|` continues the last cell. */
function tableCells(lines: string[]): { cells: string[]; firstRow: number } {
  const cells: string[] = [];
  let firstRow = 0, first = true;
  for (const line of lines) {
    if (line.startsWith("|")) {
      const parts = line.slice(1).split(/(?<!\\)\|/).map(c => c.trim());
      if (first) { firstRow = parts.length; first = false; }
      cells.push(...parts);
    } else if (line.trim() && cells.length) cells[cells.length - 1] += " " + line.trim();
  }
  return { cells, firstRow };
}

export function asciidocToMarkdown(source: string, link: LinkResolver): Converted {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [], warnings: string[] = [];
  let title = "", i = 0;
  const para: string[] = [];
  // A paragraph's lines join with spaces, except after a line ending in " +": that is a hard break,
  // which Markdown spells as two trailing spaces before the newline.
  const flush = () => {
    if (!para.length) return;
    out.push(para.map((l, k) => {
      const hard = / \+$/.test(l), text = inline(l.replace(/ \+$/, ""), link);
      return k === para.length - 1 ? text : text + (hard ? "  \n" : " ");
    }).join(""), "");
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    // Comments, attribute entries and block attributes ([.role], [#anchor], [cols=…]) carry no reader text.
    if (/^\/\/(?!\/)/.test(line) || /^:[\w-]+:/.test(line) || /^\[[.#]?[\w-]*(?:[=,].*)?\]$/.test(line)) { flush(); i++; continue; }
    if (line.trim() === "") { flush(); i++; continue; }
    const heading = line.match(/^(=+)\s+(.*)$/);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      if (level === 1 && !title) title = heading[2]!.trim();
      else out.push(`${"#".repeat(Math.min(level, 6))} ${inline(heading[2]!.trim(), link)}`, "");
      i++; continue;
    }
    if (line.startsWith("|===")) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("|==="); i++) body.push(lines[i]!);
      i++;
      const { cells, firstRow } = tableCells(body);
      if (!firstRow) continue;
      const rows: string[][] = [];
      for (let c = 0; c < cells.length; c += firstRow) rows.push(cells.slice(c, c + firstRow));
      const cell = (x: string | undefined) => inline(x ?? "", link).replace(/\|/g, "\\|");
      out.push(`| ${rows[0]!.map(cell).join(" | ")} |`, `|${rows[0]!.map(() => " --- ").join("|")}|`);
      for (const r of rows.slice(1)) out.push(`| ${r.map(cell).join(" | ")} |`);
      out.push("");
      continue;
    }
    const bullet = line.match(/^(\*+|-)\s+(.*)$/);
    const numbered = line.match(/^(\.+)\s+(.*)$/);
    if (bullet || numbered) {
      flush();
      const m = (bullet ?? numbered)!, depth = m[1] === "-" ? 0 : m[1]!.length - 1;
      out.push(`${"  ".repeat(depth)}${bullet ? "-" : "1."} ${inline(m[2]!, link)}`);
      i++;
      if (i >= lines.length || !/^(\*+|-|\.+)\s/.test(lines[i]!)) out.push("");
      continue;
    }
    if (/^(----|\.\.\.\.|====|\+\+\+\+|____|\*\*\*\*)$/.test(line)) {
      flush();
      const fence = line, body: string[] = [];
      for (i++; i < lines.length && lines[i] !== fence; i++) body.push(lines[i]!);
      i++;
      if (fence === "----" || fence === "....") out.push("```", ...body, "```", "");
      else { warnings.push(`a ${fence} block was kept as plain text`); out.push(...body, ""); }
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return { title, markdown: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n", warnings };
}
