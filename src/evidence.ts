/**
 * Status comes from tests: a WMBT is done when every acceptance it carries is bound to a passing test.
 * Tests declare what they discharge with `// Acceptance: acc:…` (tester.bun.acceptance-binding-declared),
 * and a JUnit report (`bun test --reporter=junit --reporter-outfile=…`) says which of them passed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Feature, Wmbt } from "./plan.ts";

export type TestEvidence = { bound: Set<string>; passed: Set<string> };
export type Progress = "unstarted" | "started" | "done";

/**
 * `bound` is every acceptance some test names; `passed` is the subset whose tests all passed in the
 * last run. A WMBT with nothing bound has not been started, whatever anyone typed into Linear; one
 * with everything bound and green is done.
 */
export function progressOf(wmbt: Wmbt, evidence: TestEvidence): Progress {
  if (wmbt.acceptances.length === 0) return "unstarted";
  if (!wmbt.acceptances.some(a => evidence.bound.has(a))) return "unstarted";
  return wmbt.acceptances.every(a => evidence.passed.has(a)) ? "done" : "started";
}

/** A feature is accepted when its WMBTs are, which is the only thing that makes it accepted. */
export function featureProgress(feature: Feature, evidence: TestEvidence): Progress {
  const each = feature.wmbts.map(w => progressOf(w, evidence));
  if (each.length && each.every(p => p === "done")) return "done";
  return each.some(p => p !== "unstarted") ? "started" : "unstarted";
}

/** Which acceptances the suite claims to discharge, read straight from the binding comments. */
export function readBindings(root: string, testRoots: string[]): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const testRoot of testRoots) {
    const dir = join(root, testRoot);
    if (!existsSync(dir)) continue;
    for (const file of new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,mjs}").scanSync(dir)) {
      const accs = [...readFileSync(join(dir, file), "utf8").matchAll(/\/\/\s*Acceptance:\s*(acc:\S+)/g)].map(m => m[1]!);
      if (accs.length) byFile.set(join(testRoot, file), accs);
    }
  }
  return byFile;
}

/** Join the bindings with a JUnit report. A file passes only if it ran and no case failed or errored. */
export function evidenceFrom(bindings: Map<string, string[]>, junitXml?: string): TestEvidence {
  const bound = new Set([...bindings.values()].flat());
  const passed = new Set<string>();
  if (!junitXml) return { bound, passed };
  const failed = new Set<string>(), ran = new Set<string>();
  for (const suite of junitXml.matchAll(/<testsuite\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/testsuite>/g)) {
    ran.add(suite[1]!);
    if (/<(failure|error)\b/.test(suite[2]!)) failed.add(suite[1]!);
  }
  const outcome = (file: string) => { const hit = [...ran].find(r => r.endsWith(file)); return hit && !failed.has(hit); };
  for (const [file, accs] of bindings) if (outcome(file)) for (const a of accs) passed.add(a);
  // An acceptance bound in two files passes only if neither failed.
  for (const [file, accs] of bindings) if (!outcome(file)) for (const a of accs) passed.delete(a);
  return { bound, passed };
}
