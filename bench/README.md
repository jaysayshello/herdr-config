# Herdr performance suite

A set of timing tests for this Herdr setup that you can run again and again. Each run writes one JSON file with every sample, the median and the 95th percentile (p95) of each measure, so two runs can be compared.

```sh
./bench/run.sh                              # all cases, 5 runs each, result in bench/results/
./bench/run.sh --only prs-panel --runs 3    # one case
./bench/run.sh --label after --out /tmp/after.json
bun bench/compare.ts before.json after.json # table with a verdict per measure
./bench/run.sh --repo /tmp/clone-on-a-branch # measure another checkout's code with this suite
```

A full run with `--runs 2` takes about 5 minutes and spends about 13 GitHub points. A test Herdr window shows on screen while some cases run: Herdr only draws a window that is on screen, so it must. The `omp-start` case makes about 4 tiny model calls (each stopped at once).

## Safety

The suite never touches the real Herdr window, the real herdr-core, the real omp sessions or real pull requests.

- `run.sh` points `HOME` at `/tmp/hb-<pid>/h`, `HC_SESSION` at `herdrbench` (a second herdr-core with its own terminals) and `HERDR_APP_HOME` at a test app home, before Bun starts. Bun reads `HOME` once, at start.
- `lib/guard.ts` stops the suite if `HOME`, the herdr-core session, the app home or a state folder (`herdr-pr-ready`, `herdr-pr-autofix`, `omp-herdr-resume`) is the real one.
- `gh` on the test `PATH` is a fake (`lib/fakegh.ts`): pull request actions succeed without GitHub. Real GitHub reads go through `lib/github.ts`, which counts their GraphQL points. The result file has the total in `github.pointsSpent`.
- A test omp starts with the real omp config. The login (`agent.db`), settings, extensions and skills are linked; the model and other caches are copied. Its sessions, history and resume breadcrumbs stay in the sandbox.
- The code under test is this checkout (`herdr-app/`, `orchestrator/`), or the one `--repo` names, not the live files. A change on a branch is measured before it is synced.

## Noise

Each measure runs `--runs` times. `compare.ts` calls a change better or worse only when the gap between the medians is larger than twice the median absolute deviation of either run, and larger than 5 % of the old median. Network measures (GitHub) are kept apart from local ones, because only the local part can be made faster here.

## Layout

| Path | What it does |
|---|---|
| `run.sh`, `run.ts` | Set up the sandbox, run each case, write the result file |
| `compare.ts` | Compare two result files |
| `lib/` | Sandbox, guard, test window and core, fake `gh`, fake omp worker, GitHub timing, stats |
| `cases/` | One file per area; each measure id is `<case>.<name>` |

## Cases

| Case | What it measures |
|---|---|
| `herdr-start` | App start until the window answers, the first frame, the mods' first render, the PR rows, and the sidebar with every space (t3-spaces waits for git). Fake `gh`, warm core |
| `omp-start` | `herdr_new_agent` (`herdrClient.newAgent`) until omp takes its first prompt, split into phases; omp's own boot in the test core, with parts of its config switched off to find the cost |
| `orchestrator` | `herdr_spaces`, `herdr_send`, `herdr_watch`, worker stop until `<herdr-report>`, and `/reload` of one test session, with 18 fake omp workers |
| `prs-panel` | t3-prs: one real GraphQL poll (network apart from gh's start), parse and draw with 20, 50 and 100 PRs (in Bun and in Herdr's own QuickJS engine through `herdr-app check`), gh calls per poll, Move to Ready with the fake `gh` |
| `pr-ready` | The orchestrator's PR poll (`herdr-pr-ready.ts` and `herdr-pr-autofix.ts`): network and local parts, and the GraphQL points per hour of every poll together |
| `resources` | CPU (from CPU time, not `ps` averages) and memory of the real Herdr, its core and each omp, at rest and during a poll (read only, `ps`), and of the test window |
