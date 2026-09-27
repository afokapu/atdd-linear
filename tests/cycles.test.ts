import { expect, test } from "bun:test";
import { planCycles } from "../src/cycles.ts";
import type { Gql } from "../src/linear.ts";

const cycles = [
  { id: "c3", number: 3, name: null, startsAt: "2026-10-12T03:00:00.000Z" },
  { id: "c1", number: 1, name: "Kick-off", startsAt: "2026-09-28T03:00:00.000Z" },
  { id: "c2", number: 2, name: "", startsAt: "2026-10-05T03:00:00.000Z" },
  { id: "c4", number: 4, name: null, startsAt: "2026-10-19T03:00:00.000Z" },
];
const fake = (calls: unknown[] = []): Gql => async (query: string, vars?: unknown) => {
  if (query.includes("teams(")) return { teams: { nodes: [{ cycles: { nodes: cycles } }] } } as any;
  calls.push(vars);
  return { cycleUpdate: { success: true } } as any;
};

test("an unnamed cycle takes its number's name; a named one, or one past the list, is left alone", async () => {
  const calls: unknown[] = [];
  const ops = await planCycles(fake(calls), "TST", ["Apoc", "Bane", "Cypher"]);
  expect(ops.map(o => o.what)).toEqual(["cycle 2 (from 2026-10-05): Bane", "cycle 3 (from 2026-10-12): Cypher"]);
  for (const o of ops) await o.run();
  expect(calls).toEqual([{ id: "c2", n: "Bane" }, { id: "c3", n: "Cypher" }]);
});

test("no list, no reads", async () => {
  expect(await planCycles(async () => { throw new Error("read"); }, "TST", [])).toEqual([]);
});
