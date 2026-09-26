import { expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import type { Gql } from "../src/linear.ts";
import { readPlan } from "../src/plan.ts";
import { planSync, stateFor } from "../src/sync.ts";

const ROOT = new URL("fixtures/repo", import.meta.url).pathname;
const empty = { bound: new Set<string>(), passed: new Set<string>() };
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: "" } });
const states = [{ id: "b", type: "backlog", position: 0 }, { id: "s", type: "started", position: 1 }, { id: "c", type: "completed", position: 2 }, { id: "x", type: "canceled", position: 3 }];

/** A Linear that answers the reads the sync makes, holding an empty team, except for one issue the plan no longer has. */
const fake: Gql = async (query: string) => {
  if (query.includes("teams(")) return { teams: { nodes: [{ id: "T", key: "TST", name: "Test", states: { nodes: states } }] } } as any;
  if (query.includes("issueLabels(")) return { issueLabels: page([]) } as any;
  if (query.includes("issues(")) return { issues: page([{ id: "old", identifier: "TST-9", title: "Gone", description: "`atdd-urn: wmbt:orders:Z999`", parent: null, state: { id: "b", type: "backlog" }, labels: { nodes: [] } }]) } as any;
  if (query.includes("customViews(")) return { customViews: { nodes: [] } } as any;
  throw new Error(`unexpected query: ${query.slice(0, 40)}`);
};

test("an empty team gets its labels, issues, sub-issues, a loose WMBT and its views, and a removed item is cancelled", async () => {
  const ops = await planSync(fake, await readPlan(ROOT), empty, readConfig(ROOT));
  expect(ops.map(o => `${o.kind}: ${o.what}`)).toEqual([
    "create group: wagon (single-select)",
    "create label: wagon / billing",
    "create label: wagon / orders",
    "create label: train:checkout",
    "create issue: Place order  (feature:orders:place-order)",
    "create sub-issue: E001 · order-confirmation  (wmbt:orders:E001)",
    "create issue: P001 · charge-attribution  (wmbt:billing:P001)",
    "cancel: TST-9 Gone  (wmbt:orders:Z999 is no longer in the plan)",
    "create view: Train · checkout",
    "create view: Journey · Check out",
  ]);
});

test("a scoped run never cancels", async () => {
  const ops = await planSync(fake, await readPlan(ROOT), empty, readConfig(ROOT), true);
  expect(ops.some(o => o.kind === "cancel")).toBeFalse();
});

test("tests decide Done in both directions, people everything short of it", () => {
  expect(stateFor("done", { type: "started" }, states)).toBe("c");
  expect(stateFor("started", { type: "completed" }, states)).toBe("s");
  expect(stateFor("started", { type: "backlog" }, states)).toBe("s");
  expect(stateFor("unstarted", { type: "started" }, states)).toBeUndefined();
  expect(stateFor("unstarted", undefined, states)).toBe("b");
});
