import { describe, expect, test } from "bun:test";
import { asciidocToMarkdown } from "../src/asciidoc.ts";
import { headline, journeyOf, linkFor, lookupImages, rasterize, resolveFrom, withoutCssVariables } from "../src/docs.ts";

const plain = (t: string, a?: string) => `L(${t}${a ? "#" + a : ""})`;

describe("AsciiDoc to Markdown", () => {
  const src = [
    "= The boundary", ":doc-id: purpose.boundary", "", "// a comment", "[.headline]",
    "Decision OS owns the *form*; Forge OS owns `+the value+` &middot; see xref:../x.adoc#rule[the rule].", "",
    "[#table]", "== The rule", "", "[cols=\"1,1\"]", "|===", "| QUESTION | OWNER", "", "| What is a rating ABOUT?", "| Decision OS", "", "| Which comparator | Forge OS", "|===", "",
    "*Decided by* xref:adr.adoc[ADR-1] +", "*Depended on by* xref:m.adoc[Missions]", "",
    "* one", "** nested", "", "----", "const x = 1;", "----",
  ].join("\n");
  const r = asciidocToMarkdown(src, plain);
  test("the title is the level-1 heading, and attributes, roles, anchors and comments carry no text", () => {
    expect(r.title).toBe("The boundary");
    expect(r.markdown).not.toContain("doc-id");
    expect(r.markdown).not.toContain("[.headline]");
    expect(r.markdown).not.toContain("a comment");
  });
  test("emphasis, passthroughs, entities and cross-references become Markdown", () => {
    expect(r.markdown).toContain("Decision OS owns the **form**; Forge OS owns `the value` · see [the rule](L(../x.adoc#rule)).");
  });
  test("a table keeps its header row and its rows, however its cells are laid out", () => {
    expect(r.markdown).toContain("## The rule\n\n| QUESTION | OWNER |\n| --- | --- |\n| What is a rating ABOUT? | Decision OS |\n| Which comparator | Forge OS |");
  });
  test("a trailing + is a hard break", () => expect(r.markdown).toContain("**Decided by** [ADR-1](L(adr.adoc))  \n**Depended on by** [Missions](L(m.adoc))"));
  test("lists nest, and a listing block is fenced", () => {
    expect(r.markdown).toContain("- one\n  - nested");
    expect(r.markdown).toContain("```\nconst x = 1;\n```");
  });
});

describe("documents and images", () => {
  test("a cross-reference resolves from the page it is written in", () => {
    expect(resolveFrom("docs/purpose/boundary.adoc", "../architecture/x.adoc")).toBe("docs/architecture/x.adoc");
    const link = linkFor("docs/purpose/boundary.adoc", { releases: {}, documents: { "docs/purpose/missions.adoc": { id: "d", url: "https://linear.app/doc/m" } } }, "https://github.com/o/r");
    expect(link("missions.adoc", "x")).toBe("https://linear.app/doc/m");
    expect(link("../architecture/x.adoc", "rule")).toBe("https://github.com/o/r/blob/main/docs/architecture/x.adoc#rule");
  });
  test("the headline is the paragraph after [.headline], or else the first paragraph", () => {
    expect(headline("= T\n:a: b\n\n[.headline]\nOne line\nand more.\n\nNext.")).toBe("One line and more.");
    expect(headline("= T\n:a: b\n\nFirst para.\n\nSecond.")).toBe("First para.");
  });
  test("a milestone names its journey", () => expect(journeyOf("journey:play-a-match (plan/x). A player plays.")).toBe("play-a-match"));
  test("CSS variables resolve to their fallbacks, nested ones too", () => {
    expect(withoutCssVariables(`<path style="fill: var(--a, #64748b); stroke: var(--b, var(--c, rgb(1, 2, 3)))"/>`))
      .toBe(`<path style="fill: #64748b; stroke: rgb(1, 2, 3)"/>`);
  });
  test("an SVG rasterises to PNG", () => {
    const png = rasterize(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" style="fill: var(--x, #123456)"/></svg>`, 20);
    expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
  test("a dry run never uploads: an image not in the lock is only counted as pending", async () => {
    const images = lookupImages({ releases: {}, assets: {} });
    expect(await images.url(new Uint8Array([1, 2, 3]), "a.png")).toStartWith("pending-upload:");
    expect(images.pending).toEqual(["a.png"]);
  });
});

describe("journeys in words", async () => {
  const { readPlan } = await import("../src/plan.ts");
  const { journeyText, releaseSummary } = await import("../src/docs.ts");
  const plan = await readPlan(new URL("fixtures/repo", import.meta.url).pathname);
  const j = plan.journeys[0]!;
  test("a journey says how it starts, what it passes through, and every way it ends", () => {
    const text = journeyText(j, plan);
    expect(text).toContain("`journey:checkout` · started by `check_out` · on backend");
    expect(text).toContain("**Passes through:** Checking out");
    expect(text).toContain("- *other* · Nominal: the order is confirmed");
  });
  test("a release's summary lists its journeys in milestone order, and a milestone with no journey by name", () => {
    const summary = releaseSummary([
      { id: "b", name: "2 · Later", description: "no journey here", sortOrder: 2 },
      { id: "a", name: "1 · Check out", description: "journey:checkout (x). y.", sortOrder: 1 }], plan);
    expect(summary).toBe("Delivers 2 journeys: Check out → Later.");
  });
});
