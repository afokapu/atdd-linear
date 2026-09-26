# `@afokapu/atdd-linear`

Project an ATDD plan into Linear. The repository's `plan/` decides what exists and what it means;
Linear decides who works on it and when. The plan is read through
[`@afokapu/atdd-bun`](https://github.com/afokapu/atdd-bun), so every repository is read by the same
rules atdd-bun enforces.

| Plan | Linear |
|---|---|
| repository | one team |
| wagon | a label in the single-select `wagon` group |
| feature | an issue, labelled with its wagon and its trains |
| WMBT | a sub-issue of its feature (or an issue of its own where no feature lists it), its acceptances as checkboxes with Given / When / Then |
| interlocking | a `train:<name>` label, and a `Train · <name>` view |
| journey | a `Journey · <title>` view over its interlockings' labels |
| release | a project, created by people; `atdd-linear release` gives it a view per milestone |
| journey delivered in a release | a milestone of that project, set by people |

## What it owns, and what it never touches

Overwritten from the plan on every sync: titles, the part of a description above the ✍️ notes
marker, the parent, the `wagon` label, the `train:` labels, and whether a WMBT is Done. A WMBT is
Done when every acceptance it carries is bound to a passing test (`// Acceptance: acc:…` in the test
file, and a JUnit report from the run).

Never touched: project, milestone, cycle, assignee, priority, estimate, comments, other labels, and
anything written below the notes marker. Something removed from the plan has its issue cancelled with
a comment, never deleted.

## Use

```sh
bun add -d @afokapu/atdd-linear
```

`atdd-linear.yaml` at the repository root:

```yaml
team: FOS                                    # the Linear team key
repo: https://github.com/org/repo            # where Source links point
colors:                                      # optional: a train label's colour, by interlocking
  contest: "#1F6B52"
```

```sh
bunx atdd-linear sync                        # print what would change; change nothing
bunx atdd-linear sync --apply                # make the changes
bunx atdd-linear sync --results junit.xml    # take WMBT status from a test run
bunx atdd-linear release "Forge OS v0.1.0"   # the release's views: all features, one per milestone
bunx atdd-linear ci init                     # a workflow that syncs on every merge to main
```

The API key comes from `LINEAR_API_KEY`, or on macOS from the Keychain entry `linear-api-key`
(`security add-generic-password -U -a "$USER" -s linear-api-key -w`). It is never printed.

`atdd-linear release` records the views it makes in `atdd-linear.lock.json`: Linear's API lists no
project-scoped view, so the lock is what stops a second run making them again. Commit it.
