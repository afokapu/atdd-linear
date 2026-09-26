import { describe, expect, test } from "bun:test";
import { evidenceFrom, featureProgress, progressOf, readBindings } from "../src/evidence.ts";
import { readPlan, scopeTo, type Wmbt } from "../src/plan.ts";

const ROOT = new URL("fixtures/repo", import.meta.url).pathname;

describe("the plan, read through atdd-bun", () => {
  test("features own their WMBTs, and a WMBT no feature lists stands on its own", async () => {
    const p = await readPlan(ROOT);
    expect(p.features.map(f => f.urn)).toEqual(["feature:orders:place-order"]);
    expect(p.features[0]!.wmbts.map(w => w.urn)).toEqual(["wmbt:orders:E001"]);
    expect(p.loose.map(w => w.urn)).toEqual(["wmbt:billing:P001"]);
  });
  test("a train label comes from the interlocking messages that reference the WMBT", async () => {
    const p = await readPlan(ROOT);
    expect(p.features[0]!.trains).toEqual(["checkout"]);
    expect(p.loose[0]!.trains).toEqual(["checkout"]);
  });
  test("each acceptance carries its purpose and Given / When / Then", async () => {
    const a = (await readPlan(ROOT)).features[0]!.wmbts[0]!.details[0]!;
    expect(a).toMatchObject({ id: "SMOKE-001", purpose: "A valid basket becomes a confirmed order", harness: "smoke · integration",
      given: ["the checkout endpoint is up", "a valid basket"], when: "the basket is submitted", target: "POST /orders", then: ["an order is confirmed"] });
  });
  test("journeys reach their interlockings, and an unrouted train is reported", async () => {
    const p = await readPlan(ROOT);
    expect(p.journeys).toEqual([{ id: "journey:checkout", title: "Check out", path: "plan/_journeys/checkout.yaml", interlockings: ["checkout"] }]);
    expect(p.unroutedTrains).toEqual(["train:orders:refund"]);
  });
  test("scoping keeps only what an interlocking reaches", async () => {
    const p = scopeTo(await readPlan(ROOT), "nowhere");
    expect([p.features.length, p.loose.length, p.wagons.length]).toEqual([0, 0, 0]);
  });
});

describe("status comes from tests", () => {
  const wmbt = (acceptances: string[]) => ({ acceptances } as Wmbt);
  const a = "acc:w:P001-UNIT-001-a", b = "acc:w:P001-UNIT-002-b";
  test("nothing bound is unstarted, some bound is started, all passing is done", () => {
    expect(progressOf(wmbt([a, b]), { bound: new Set(), passed: new Set() })).toBe("unstarted");
    expect(progressOf(wmbt([a, b]), { bound: new Set([a, b]), passed: new Set([a]) })).toBe("started");
    expect(progressOf(wmbt([a, b]), { bound: new Set([a, b]), passed: new Set([a, b]) })).toBe("done");
  });
  test("a feature is done only when every WMBT is", () => {
    const f = { wmbts: [wmbt([a]), wmbt([b])] } as any;
    expect(featureProgress(f, { bound: new Set([a, b]), passed: new Set([a]) })).toBe("started");
    expect(featureProgress(f, { bound: new Set([a, b]), passed: new Set([a, b]) })).toBe("done");
  });
  test("bindings are read from the test roots, and a failing file fails every acceptance it binds", () => {
    const bindings = readBindings(ROOT, ["tests"]);
    expect([...bindings.values()].flat()).toEqual(["acc:orders:E001-SMOKE-001-a-valid-basket-is-confirmed"]);
    const twice = new Map([["tests/one.test.ts", [a]], ["tests/two.test.ts", [a]]]);
    const xml = `<testsuites><testsuite name="tests/one.test.ts"></testsuite><testsuite name="tests/two.test.ts"><testcase><failure/></testcase></testsuite></testsuites>`;
    expect(evidenceFrom(twice, xml).passed.has(a)).toBeFalse();
  });
});
