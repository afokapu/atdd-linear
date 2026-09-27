/**
 * The plan, read as the Linear workspace it should produce.
 *
 * Linear is a projection of `plan/`, the way the docs are: the repository decides what exists and
 * what it means, Linear decides who works on it and when. This file is the pure half of that
 * projection. It reads the plan through atdd-bun's own loader, so every repository is read by the
 * same rules atdd-bun enforces, and it never talks to Linear.
 *
 *   repository     -> one Linear team
 *   wagon          -> a label in the single-select `wagon` group (a domain that never finishes)
 *   feature        -> an issue, labelled with its wagon
 *   WMBT           -> a sub-issue of its feature, or an issue of its own where no feature owns it.
 *                     Its status comes from its acceptances' tests.
 *   interlocking   -> a flat `train:` label (an issue serves several trains; a group admits one)
 *   journey        -> a saved view over the labels of the interlockings it reaches
 *
 * Projects (releases) and milestones (the journeys delivered in them) are planning decisions the plan
 * does not state, so people own them and nothing here reads or writes them.
 */
import { loadPlan, topologyFor, type PlanArtifact } from "@afokapu/atdd-bun";
import { dirname } from "node:path";

export type Wagon = { slug: string; description: string; theme: string; dir: string };
/** What a reader needs of an acceptance; the typed assertions, signal and metadata stay in the YAML. */
export type Acceptance = {
  urn: string; id: string; purpose: string; phase: string; harness: string;
  given: string[]; when: string; target: string; then: string[];
};
export type Wmbt = {
  urn: string; code: string; wagon: string; sentence: string; statement: string;
  objectOfControl: string; path: string; acceptances: string[]; details: Acceptance[]; trains: string[];
};
export type Feature = { urn: string; slug: string; wagon: string; description: string; path: string; wmbts: Wmbt[]; trains: string[] };
export type Route = { routeId: string; trainId: string; category: string };
export type Interlocking = { slug: string; title: string; path: string; routes: Route[] };
export type Continuation = { from: string; routeId: string; artifact: string; to: string };
export type Terminal = { from: string; routeId: string; outcome: string };
export type Journey = {
  id: string; title: string; path: string; interlockings: string[];
  entry: string; exposed: boolean; actions: string[]; surfaces: string[];
  continuations: Continuation[]; terminals: Terminal[];
};
export type Plan = {
  planRoot: string;
  wagons: Wagon[]; features: Feature[];
  /** WMBTs no feature lists: in a plan without features every WMBT is one, and each becomes its own issue. */
  loose: Wmbt[];
  interlockings: Interlocking[]; journeys: Journey[];
  unroutedTrains: string[];
};

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim();
const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const words = (v: unknown): string[] => (Array.isArray(v) ? v : v == null ? [] : [v]).map(str).filter(Boolean);
const slugOf = (urn: string, at: number) => urn.split(":")[at] ?? "";

function acceptance(a: any): Acceptance {
  return {
    urn: str(a?.identity?.urn), id: str(a?.identity?.id).replace(/^AC-/, ""),
    purpose: str(a?.identity?.purpose), phase: str(a?.identity?.phase),
    harness: [a?.harness?.type, a?.harness?.category].filter(Boolean).join(" · "),
    given: words(a?.given?.abstract), when: words(a?.when?.abstract).join(", and "),
    target: str(a?.when?.target), then: words(a?.then?.abstract),
  };
}

export async function readPlan(root: string): Promise<Plan> {
  const { artifacts } = await loadPlan(root);
  const planRoot = (await topologyFor(root)).planRoot;
  const of = (kind: PlanArtifact["kind"]) => artifacts.filter(a => a.kind === kind).sort((x, y) => x.id.localeCompare(y.id));

  const wagons: Wagon[] = of("wagon").map(a => ({
    slug: slugOf(a.id, 1), description: str(a.data.description), theme: str(a.data.theme), dir: `${dirname(a.file)}/`,
  }));
  const sentences = new Map<string, string>();
  for (const a of of("wagon")) {
    const wmbt = (a.data.wmbt ?? {}) as Record<string, unknown>;
    for (const [code, text] of Object.entries(wmbt)) if (code !== "total") sentences.set(`wmbt:${slugOf(a.id, 1)}:${code}`, str(text));
  }

  // An interlocking claims a WMBT when one of its messages references it. That is the only place the
  // plan ties a WMBT to a train, so it is the only place a train label may come from.
  const trainsOf = new Map<string, Set<string>>();
  const interlockings: Interlocking[] = of("interlocking").map(a => {
    const slug = slugOf(a.id, 1);
    for (const m of list(a.data.messages)) for (const ref of list(m?.wmbt_refs)) {
      if (!trainsOf.has(ref)) trainsOf.set(ref, new Set());
      trainsOf.get(ref)!.add(slug);
    }
    return { slug, title: str(a.data.title), path: a.file, routes: list(a.data.routes).map(r => ({ routeId: str(r.route_id), trainId: str(r.train_id), category: str(r.category) })) };
  });

  const wmbts = new Map<string, Wmbt>();
  for (const a of of("wmbt")) {
    wmbts.set(a.id, {
      urn: a.id, code: slugOf(a.id, 2), wagon: slugOf(a.id, 1),
      sentence: sentences.get(a.id) || str(a.data.statement), statement: str(a.data.statement),
      objectOfControl: str(a.data.object_of_control), path: a.file,
      acceptances: list(a.data.acceptances).map(x => str(x?.identity?.urn)).filter(Boolean),
      details: list(a.data.acceptances).map(acceptance),
      trains: [...(trainsOf.get(a.id) ?? [])].sort(),
    });
  }

  const owned = new Set<string>();
  const features: Feature[] = of("feature").map(a => {
    const own = list(a.data.wmbts).map(u => {
      const found = wmbts.get(str(u));
      if (!found) throw new Error(`${a.id} names ${u}, which has no WMBT file`);
      owned.add(found.urn);
      return found;
    });
    return {
      urn: a.id, slug: slugOf(a.id, 2), wagon: slugOf(a.id, 1), description: str(a.data.description), path: a.file,
      wmbts: own, trains: [...new Set(own.flatMap(w => w.trains))].sort(),
    };
  });

  const journeys: Journey[] = of("journey").map(a => {
    const entry = a.data.entrypoint as any, reached = new Set<string>([str(entry?.interlocking_id)]);
    for (const c of list(a.data.continuations)) reached.add(str(c?.to?.interlocking_id));
    return {
      id: a.id, title: str(a.data.title), path: a.file, interlockings: [...reached].filter(Boolean).map(i => slugOf(i, 1)).sort(),
      entry: slugOf(str(entry?.interlocking_id), 1), exposed: entry?.exposed === true,
      actions: list(entry?.actions).map(str), surfaces: list(entry?.surfaces).map(str),
      continuations: list(a.data.continuations).map(c => ({ from: slugOf(str(c?.from?.interlocking_id), 1), routeId: str(c?.from?.route_id), artifact: str(c?.artifact), to: slugOf(str(c?.to?.interlocking_id), 1) })),
      terminals: list(a.data.terminals).map(t => ({ from: slugOf(str(t?.from?.interlocking_id), 1), routeId: str(t?.from?.route_id), outcome: str(t?.outcome) })),
    };
  });

  const routed = new Set(interlockings.flatMap(i => i.routes.map(r => r.trainId)));
  return {
    planRoot, wagons, features,
    loose: [...wmbts.values()].filter(w => !owned.has(w.urn)),
    interlockings, journeys,
    unroutedTrains: of("train").map(a => a.id).filter(t => !routed.has(t)),
  };
}

/** Keep only what one interlocking reaches, so a dry run can be a slice rather than the whole plan. */
export function scopeTo(plan: Plan, interlocking: string): Plan {
  const features = plan.features.filter(f => f.trains.includes(interlocking));
  const loose = plan.loose.filter(w => w.trains.includes(interlocking));
  const wagons = new Set([...features.map(f => f.wagon), ...loose.map(w => w.wagon)]);
  return {
    ...plan, features, loose,
    wagons: plan.wagons.filter(w => wagons.has(w.slug)),
    interlockings: plan.interlockings.filter(i => i.slug === interlocking),
    journeys: plan.journeys.filter(j => j.interlockings.includes(interlocking)),
  };
}
