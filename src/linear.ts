/**
 * The Linear GraphQL API, and nothing more. The key comes from LINEAR_API_KEY (CI) or, on macOS, the
 * Keychain entry `linear-api-key`; it is never printed.
 */
export type Gql = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export function apiKey(): string {
  const fromEnv = process.env.LINEAR_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", "linear-api-key", "-w"], { stderr: "ignore" });
    const key = r.stdout.toString().trim();
    if (key) return key;
  }
  throw new Error("no Linear API key: set LINEAR_API_KEY, or add the macOS Keychain entry linear-api-key");
}

export function client(key = apiKey(), endpoint = "https://api.linear.app/graphql"): Gql {
  return async <T>(query: string, variables: Record<string, unknown> = {}) => {
    const res = await fetch(endpoint, {
      method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json() as { data?: T; errors?: { message: string; extensions?: { userPresentableMessage?: string } }[] };
    if (body.errors?.length) throw new Error(body.errors.map(e => e.extensions?.userPresentableMessage ?? e.message).join("; "));
    return body.data as T;
  };
}

/** Every page of a connection. */
export async function all<T>(gql: Gql, query: string, pick: (d: any) => { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }, vars: Record<string, unknown> = {}): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const page = pick(await gql(query, { ...vars, after }));
    out.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
  } while (after);
  return out;
}
