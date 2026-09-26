// The slice of @afokapu/atdd-bun this package uses, for the type checker only; Bun loads the real
// package at run time. atdd-bun ships TypeScript sources that do not pass `strict`, so checking
// through them would report its errors as this package's.
declare module "@afokapu/atdd-bun" {
  export type PlanKind = "wagon" | "feature" | "wmbt" | "acceptance" | "train" | "interlocking" | "journey" | "contract";
  export type PlanArtifact = { kind: PlanKind; id: string; file: string; data: Record<string, unknown> };
  export type PlanGraph = { artifacts: PlanArtifact[]; findings: { rule_id: string; file: string; evidence: string }[] };
  export function loadPlan(root: string): Promise<PlanGraph>;
  export type Topology = { planRoot: string; sourceRoot: string; testRoot: string; e2eRoot: string };
  export function topologyFor(root: string): Promise<Topology>;
}
