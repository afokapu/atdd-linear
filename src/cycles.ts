/**
 * A team whose versions are its cycles names each cycle after its version. Linear creates cycles a few
 * weeks ahead and leaves them unnamed, so every sync names the ones it finds: cycle N takes the Nth name
 * in `cycles:`. A cycle that already has a name keeps it, whoever gave it, and a cycle past the end of
 * the list stays unnamed rather than being given an invented one.
 */
import { all, type Gql } from "./linear.ts";
import type { Op } from "./sync.ts";

type Cycle = { id: string; number: number; name: string | null; startsAt: string };

export async function planCycles(gql: Gql, teamKey: string, names: string[]): Promise<Op[]> {
  if (!names.length) return [];
  const cycles = await all<Cycle>(gql,
    `query($k:String!,$after:String){ cycles(first:100, after:$after, filter:{team:{key:{eq:$k}}}){
       nodes{ id number name startsAt } pageInfo{ hasNextPage endCursor } } }`, d => d.cycles, { k: teamKey });
  return cycles
    .filter(c => !c.name?.trim() && names[c.number - 1])
    .sort((a, b) => a.number - b.number)
    .map(c => {
      const name = names[c.number - 1]!;
      return { kind: "name cycle", what: `cycle ${c.number} (from ${c.startsAt.slice(0, 10)}): ${name}`, run: async () => {
        await gql(`mutation($id:String!,$n:String!){ cycleUpdate(id:$id, input:{name:$n}){ success } }`, { id: c.id, n: name });
      } };
    });
}
