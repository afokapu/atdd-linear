import { expect, test } from "bun:test";
import { readConfig } from "../src/config.ts";
import type { Gql } from "../src/linear.ts";
import { notesBody, planNotes, type History } from "../src/notes.ts";
import { readPlan } from "../src/plan.ts";

const ROOT = new URL("fixtures/repo", import.meta.url).pathname;
const week = { id: "c2", number: 2, name: "Version 2.0: Bane", startsAt: "2026-10-05T03:00:00.000Z", endsAt: "2026-10-12T03:00:00.000Z", isActive: true, documents: { nodes: [] } };
const issue = (urn: string, completedAt: string | null) => ({
  identifier: `TST-${urn.slice(-4)}`, url: `https://linear.app/x/${urn}`, description: `\`atdd-urn: ${urn}\``,
  completedAt, state: { type: completedAt ? "completed" : "started" },
});
const changes = [
  { status: "added" as const, path: "plan/_journeys/checkout.yaml" },
  { status: "changed" as const, path: "plan/orders/E001.yaml" },
  { status: "changed" as const, path: "plan/_trains/orders/refund.yaml" },
  { status: "removed" as const, path: "plan/orders/Z999.yaml" },
];

test("a week's notes: what went green, by train, and what the plan gained, changed and lost", async () => {
  const body = notesBody(week, await readPlan(ROOT), readConfig(ROOT),
    [issue("wmbt:orders:E001", "2026-10-06T10:00:00.000Z"), issue("wmbt:billing:P001", null)], changes);
  expect(body).toContain("## Journeys completed\n\nNone this version.");
  expect(body).toContain("## Delivered (1 WMBT)");
  expect(body).toContain("(`train:checkout`)\n\nServes: Check out\n\n- [TST-E001](https://linear.app/x/wmbt:orders:E001) Place order · **E001** · order-confirmation");
  expect(body).not.toContain("P001");
  expect(body).toContain("### Added (1)\n\n- Journey · Check out · [plan/_journeys/checkout.yaml](https://github.com/example/shop/blob/main/plan/_journeys/checkout.yaml)");
  expect(body).toContain("### Changed (2)\n\n- WMBT · E001 · order-confirmation · [plan/orders/E001.yaml]");
  expect(body).toContain("- `plan/_trains/orders/refund.yaml`");
  expect(body).toContain("### Removed (1)\n\n- `plan/orders/Z999.yaml`");
});

test("a journey is completed the week the last WMBT on its trains is", async () => {
  const plan = await readPlan(ROOT), config = readConfig(ROOT);
  const done = [issue("wmbt:orders:E001", "2026-09-30T10:00:00.000Z"), issue("wmbt:billing:P001", "2026-10-07T10:00:00.000Z")];
  expect(notesBody(week, plan, config, done, [])).toContain("## Journeys completed\n\n- **Check out**");
  expect(notesBody({ ...week, startsAt: "2026-10-12T03:00:00.000Z", endsAt: "2026-10-19T03:00:00.000Z" }, plan, config, done, [])).toContain("None this version.");
});

test("without full history the notes say so rather than claim the plan did not change", async () => {
  expect(notesBody(week, await readPlan(ROOT), readConfig(ROOT), [], undefined)).toContain("Not available: the history this sync ran on is a shallow clone");
});

test("the running cycle gets notes; a past one is written once after its end and then frozen", async () => {
  const past = (updatedAt: string) => ({ ...week, id: "c1", number: 1, name: "Version 1.0: Apoc", startsAt: "2026-09-28T03:00:00.000Z", endsAt: "2026-10-05T03:00:00.000Z", isActive: false,
    documents: { nodes: [{ id: "d1", title: "Version 1.0: Apoc · Release notes", content: "", updatedAt }] } });
  const history: History = () => [];
  const run = async (previous: ReturnType<typeof past>) => {
    const fake: Gql = async (q: string) => {
      if (q.includes("cycles(")) return { cycles: { nodes: [week, previous] } } as any;
      if (q.includes("issues(")) return { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: "" } } } as any;
      throw new Error(`unexpected ${q.slice(0, 30)}`);
    };
    return (await planNotes(fake, ROOT, await readPlan(ROOT), readConfig(ROOT), history)).map(o => `${o.kind}: ${o.what}`);
  };
  expect(await run(past("2026-10-04T00:00:00.000Z"))).toEqual(["update notes: Version 1.0: Apoc · Release notes (final, then frozen)", "create notes: Version 2.0: Bane · Release notes"]);
  expect(await run(past("2026-10-05T09:00:00.000Z"))).toEqual(["create notes: Version 2.0: Bane · Release notes"]);
});
