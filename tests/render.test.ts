import { describe, expect, test } from "bun:test";
import { colorFor, readConfig } from "../src/config.ts";
import { acceptanceLines, mergeDescription, NOTES_MARKER, sameMarkdown, urnIn } from "../src/render.ts";

describe("descriptions", () => {
  test("notes under the marker survive a re-sync", () => {
    const second = mergeDescription("synced v2", `${mergeDescription("synced v1")}\nmy note`);
    expect(second).toContain("synced v2");
    expect(second).not.toContain("synced v1");
    expect(second.split(NOTES_MARKER)[1]).toContain("my note");
  });
  test("Linear's canonical Markdown counts as unchanged", () => {
    expect(sameMarkdown("[a](https://x/a)\n- [ ] one\n  - b\nplan/_x.yaml", "[a](<https://x/a>)\n\n- [ ] one\n  * b\n\nplan/\\_x.yaml")).toBeTrue();
    expect(sameMarkdown("| A | B |\n| --- | --- |\n| a | b |", "| A | B |\n| -- | -- |\n| a | b |")).toBeTrue();
    expect(sameMarkdown("[*The boundary*](https://l/b) and chess.com", "[The boundary](https://l/b) and [chess.com](http://chess.com)")).toBeTrue();
    expect(sameMarkdown("*`code` rest*", "`code` *rest*")).toBeTrue();
    expect(sameMarkdown("one", "two")).toBeFalse();
  });
  test("the URN is recovered from the synced block", () => expect(urnIn("x\n`atdd-urn: wmbt:w:P001`")).toBe("wmbt:w:P001"));
  test("an acceptance reads as a checkbox with its steps beneath it", () => {
    const a = { urn: "u", id: "SMOKE-001", purpose: "It resolves", phase: "SMOKE", harness: "smoke · integration", given: ["up", "done"], when: "resolved", target: "GET /v", then: ["it resolves"] };
    expect(acceptanceLines(a, true)).toEqual([
      "- [x] **SMOKE-001** · It resolves *(smoke · integration)*",
      "  * **Given** up, and done", "  * **When** resolved: `GET /v`", "  * **Then** it resolves"]);
  });
});

describe("configuration", () => {
  test("the team, repository and colours come from atdd-linear.yaml", () => {
    expect(readConfig(new URL("fixtures/repo", import.meta.url).pathname)).toEqual(
      { team: "TST", repo: "https://github.com/example/shop", documents: [], summary: undefined, journeyView: "docs/purpose/journeys", colors: { checkout: "#123456" }, cycles: [] });
  });
  test("a missing file says what it must hold", () => expect(() => readConfig("/nonexistent")).toThrow("names the Linear team"));
  test("an unconfigured train keeps the same colour from run to run", () => {
    expect(colorFor("checkout", { checkout: "#123456" })).toBe("#123456");
    expect(colorFor("ladder", {})).toBe(colorFor("ladder", {}));
  });
});
