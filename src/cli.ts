#!/usr/bin/env bun
/**
 *   atdd-linear sync [--apply] [--scope <interlocking>] [--results <junit.xml>]
 *   atdd-linear release "<project name>" [--apply] [--no-views]
 *   atdd-linear ci init [--replace]
 *
 * Every command prints what it would change and changes nothing until --apply.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { topologyFor } from "@afokapu/atdd-bun";
import { readConfig } from "./config.ts";
import { evidenceFrom, readBindings } from "./evidence.ts";
import { client } from "./linear.ts";
import { readPlan, scopeTo } from "./plan.ts";
import { planDocuments } from "./docs.ts";
import { planRelease, readLock, writeLock } from "./release.ts";
import { apply, planSync, type Op } from "./sync.ts";

const args = process.argv.slice(2), root = process.cwd();
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes("--apply");

function report(ops: Op[]) {
  const counts = new Map<string, number>();
  for (const o of ops) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  console.log(`\n${ops.length} changes: ${[...counts].map(([k, n]) => `${n} ${k}`).join(", ") || "none, Linear matches the plan"}\n`);
  for (const o of ops) console.log(`  ${o.kind.padEnd(16)} ${o.what}`);
}

async function finish(ops: Op[]) {
  report(ops);
  if (!APPLY) { if (ops.length) console.log("\ndry run: nothing was changed. Re-run with --apply to make these changes."); return; }
  await apply(ops);
}

const HELP = `atdd-linear: project an ATDD plan into Linear

  atdd-linear sync [--apply] [--scope <interlocking>] [--results <junit.xml>]
  atdd-linear release "<project name>" [--apply] [--no-views]
  atdd-linear ci init [--replace]

Configured by atdd-linear.yaml; the API key comes from LINEAR_API_KEY or the macOS Keychain entry linear-api-key.`;

switch (args[0]) {
  case "sync": {
    const config = readConfig(root), scope = flag("--scope"), results = flag("--results");
    let plan = await readPlan(root);
    if (scope) plan = scopeTo(plan, scope);
    const topology = await topologyFor(root);
    const bindings = readBindings(root, [...new Set([topology.testRoot, topology.e2eRoot])]);
    const evidence = evidenceFrom(bindings, results ? readFileSync(results, "utf8") : undefined);
    const wmbts = plan.features.reduce((n, f) => n + f.wmbts.length, 0) + plan.loose.length;
    console.log(`plan: ${plan.wagons.length} wagons, ${plan.features.length} features, ${wmbts} WMBTs, ${plan.interlockings.length} interlockings, ${plan.journeys.length} journeys${scope ? ` (scope: ${scope})` : ""}`);
    console.log(`tests: ${bindings.size} files bind ${evidence.bound.size} acceptances; ${evidence.passed.size} passing${results ? "" : " (no --results given, so nothing counts as passing)"}`);
    for (const t of plan.unroutedTrains) console.log(`warning: ${t} is declared but no interlocking routes to it, so no label can reach it`);
    const gql = client(), lock = readLock(root);
    const ops = await planSync(gql, plan, evidence, config, Boolean(scope));
    if (config.documents.length && !scope) {
      const team = (await gql(`query($k:String!){ teams(filter:{key:{eq:$k}}){ nodes{ id } } }`, { k: config.team })).teams.nodes[0];
      ops.push(...await planDocuments(gql, root, config, team.id, lock, () => writeLock(root, lock)));
    }
    await finish(ops);
    break;
  }
  case "release": {
    const name = args[1];
    if (!name || name.startsWith("--")) { console.error('usage: atdd-linear release "<project name>" [--apply]'); process.exit(2); }
    await finish(await planRelease(client(), root, name, readConfig(root), !args.includes("--no-views")));
    break;
  }
  case "ci": {
    if (args[1] !== "init") { console.error("usage: atdd-linear ci init [--replace]"); process.exit(2); }
    const out = join(root, ".github/workflows/atdd-linear.yml");
    if (existsSync(out) && !args.includes("--replace")) { console.error(`${out} exists; use --replace`); process.exit(1); }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, readFileSync(new URL("../templates/atdd-linear.yml", import.meta.url), "utf8"));
    console.log(`wrote ${out}. Add the repository secret LINEAR_API_KEY.`);
    break;
  }
  default:
    console.log(HELP);
    if (args[0] && args[0] !== "help" && args[0] !== "--help") process.exit(2);
}
