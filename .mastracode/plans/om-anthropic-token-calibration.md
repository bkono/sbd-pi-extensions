# OM threshold parity for Anthropic models

## Measurement-only outcome, November 17, 2026

The measurement phase closes without a runtime change. The retained requests support a content-dependent provider-to-o200k difference plus unequal request overhead. All 50 matched historical activation triggers were `threshold`, not `block`. Tokenx fails the approved sol spread gate, so o200k remains unchanged. The proposed Opus 5.5 factor 1.55 fails live acceptance and is rejected.

The final deliverable is this committed investigation record. No calibrated threshold, tokenizer replacement, runtime dependency, or persisted-count migration ships. Independent review and the required commit-bound verifier must assess this measurement-only outcome, not approve the rejected runtime candidate. The original activation problem remains open in `sbdpi-sps`. A future activation-contract design is outside this measurement outcome.

Sections below retain the experiment history and original approved plan. The rejection decision governs them. References to pending implementation, calibration factors, or shipping steps in the historical sections are not current instructions. Numeric artifacts and rerunnable scripts remain under `/tmp/om-token-calibration/`. They contain local session-derived data and are not committed. Their availability is limited to this machine until retained separately.

## Fixed-factor calibration rejected, November 17, 2026

This decision supersedes all implementation and shipping steps below. The candidate factor 1.55 failed live acceptance and will not ship. The nine candidate files are archived with hashes, a recovery patch, and restoration proof in `/tmp/om-token-calibration/rejected-candidate/`. The six tracked files match source HEAD `56a59044c47f8a9d54f834852e927e99cf90cda9`, and the three candidate-only files are removed. Package lint, typecheck, and all 67 tests pass on the restored baseline. Issue `sbdpi-sps` remains open with the investigation recorded. No source commit or shipping PR was created.

Restoring the baseline knowingly retains the reported problem. All 34 retained historical Opus 5.5 first activations were above the acceptance band, at 41,879 to 49,669 adjusted provider tokens. This choice rejects an unproven replacement, not the evidence of late activation. Any further implementation needs a revised design. No further paid calls are authorized by this decision. Opus 4.6 remains prohibited in every role.

Evidence is `/tmp/om-token-calibration/factor-viability/report.md`, with rerunnable `extract.mjs`, `simulate.py`, and `report.py` in that directory. Explain the Number changes the decision from adjusting the constant to rejecting the fixed-factor solution. The exact live observations remain 18,508 adjusted provider tokens for Opus at factor 1.55 and 29,976 for sol at factor 1.0. The independent offline analysis reconstructed all 912 traced pre-activation pending counts. Its best observer-readiness model reproduced 34 of 36 activation checks, so counterfactual activation results remain inferred.

The fixture's cumulative provider-to-o200k ratio was 1.2411. Under immediate activation with infinitesimal steps, factor 1.55 implies about 24,020 provider message tokens, below the 25,500 lower acceptance bound. Observer-readiness delays can raise the last-sent request above that threshold, so this calculation is not a proof for arbitrary activation timing. Factor 1.55 nevertheless fails the fixture under every tested readiness model. The historical pooled ratio was 1.5522 across 617 strict pairs from 108 sessions. Under the immediate-activation model, a factor that fits the pooled historical ratio and the fixture requires a worst-case step no larger than about 1,681 o200k tokens. About 22% of observed turns between 12k and 26k pending exceeded that size. The 22% figure describes all turns in that pending range, not only modeled threshold crossings. It must not be interpreted as a crossing-failure rate. Session-level ratio spread further narrows the feasible interval. These are analytic estimates, not live passes.

No tested constant satisfied every evaluable historical session and the fixture. The historical replay has modeled observer readiness, correlated tasks, and a factor-dependent evaluable denominator. It does not prove that no constant could work on a narrower declared traffic mix. It does establish that the current constant lacks the evidence required to ship under this plan.

A last-sent provider-usage trigger is an unapproved alternative, not the next implementation step. Offline replay suggests it may track the intended quantity better, but cannot prevent a single request from jumping over the acceptance band. Its design must account for fixed and injected context overhead, stale or missing usage, model switches, observer readiness, and postactivation accounting. A hard per-request band and best-effort activation around 30k are different contracts. Resolve that contract before changing activation semantics. Keep o200k because tokenx failed the approved sol comparison gate. Do not choose replay content by its measured ratio merely to pass acceptance.

## Live acceptance failure, November 17, 2026

The candidate is not accepted for shipping. The bounded real-host Opus 5.5 run failed the actual-request band. Independent live-evidence assessment and offline factor-viability analysis are complete. No Opus 4.6 route executed.

Evidence is `/tmp/om-token-calibration/live/report.md` and `results.json`. Opus had 14,912 o200k pending at the last raw provider request and 19,832 at threshold activation. The final 4,920 o200k tokens were added by the tool and activated OM before a raw request could send them. Last provider input was 19,686, with an approximate same-run overhead of 1,178, giving 18,508 adjusted tokens. Postactivation input was 9,443. These distinct boundaries cannot be divided to infer a tokenizer ratio.

Sol had 29,780 o200k at its last raw request, 34,700 at activation, and the same 4,920 unsent tail. Last provider input was 30,521 minus approximate overhead 545, giving 29,976 adjusted tokens. Postactivation input was 7,323. Both triggers were `threshold`, one activation per model. The first four fixture result hashes match across models. All 23 production runtime source hashes match the reviewed snapshot and the main checkout. The hosts stopped and no further paid calls ran.

The final isolated snapshot quality gates passed. Root lint checked 719 files. Root tests passed 428 suites and 2,326 tests. Root typecheck passed. The first isolated root test attempt failed because the ignored root `package-lock.json` was absent. Copying that existing lockfile into the snapshot and rerunning resolved the failure without source changes. Logs are `/tmp/om-token-calibration/implementation/review-fixes/lead-root-{lint,test,typecheck}.log`.

Do not commit or open a shipping PR for the calibration until the live gate passes. Retained retrospective predictions are not a substitute. Apply Explain the Number by keeping actual sent requests distinct from newly added, unsent activation context.

## Measurement decision and implementation revision, November 17, 2026

This section supersedes the single-Claude-constant design and the median-only calibration rule below. It applies the approved risk rule requiring a table when model generations differ by more than 10%. The candidate implementation is complete and independently reviewed. Live acceptance remains pending.

User authorization subsequently permitted isolated Opus 5.5 and sol provider runs and explicitly prohibited Opus 4.6 runs. Only Opus 5.5 remains a calibration candidate. All Opus 4.6 routes return the original config unchanged, pinned by identity tests. Live verification must enforce the prohibition for main, observer, reflector, and fallback routes. The candidate uses an explicit sol observer override and a fail-closed route guard in the isolated harness. No factor for Opus 4.6 may ship without a separately authorized live check.

The final candidate passed 2,326 repository tests and root typecheck. Scoped lint passed. Root lint previously failed on unrelated nested Biome configs under `.claude/worktrees`; an earlier isolated review passed root lint. Independent re-review at `/tmp/om-calibration-rereview.SjA20B` approved the final restricted candidate subject to live acceptance, reran 114 package tests and typecheck, and verified the documented numeric artifact hashes. All new package files must be explicitly staged in the final commits.

### Evidence

Artifacts are in `/tmp/om-token-calibration/`. Run `python3 /tmp/om-token-calibration/verify.py` to check source hashes, extraction assertions, exclusions, and matched activation boundaries. The lead reran it successfully. Its output was `PASS: 8064 numeric pairs; 21740 built-counter extraction checks; 50 matched threshold boundaries; exclusions sum to 9737; strict replay exclusions and every source input hash verified.` Inputs cover 660 files, with zero parse errors and 2,462 strict stable pairs. Scripts and numeric rows are retained there; session text must not enter the repository.

The matched final cohorts use clean extension SHA `511b6fdc96f417ab746db3a71fc1e01a3d9c2d87`. Provider input means `input + cacheRead + cacheWrite`. Sol is `openai-codex/gpt-6.1-sol`, not Claude. Brackets below are Q1 and Q3, not confidence intervals.

| Model and arm | Counter | Median | Q1 | Q3 | IQR width | n |
|---|---|---:|---:|---:|---:|---:|
| Opus 5.5 hashline | o200k | 1.6972 | 1.5241 | 1.7800 | 0.2559 | 124 |
| Opus 5.5 hashline | tokenx | 1.6176 | 1.5002 | 1.7082 | 0.2081 | 124 |
| Opus 5.5 stock | o200k | 1.6799 | 1.5470 | 1.7978 | 0.2508 | 80 |
| Opus 5.5 stock | tokenx | 1.4819 | 1.4347 | 1.6497 | 0.2150 | 80 |
| Sol hashline | o200k | 1.0309 | 1.0183 | 1.0550 | 0.0367 | 186 |
| Sol hashline | tokenx | 0.9945 | 0.9592 | 1.0296 | 0.0704 | 186 |
| Sol stock | o200k | 1.0305 | 1.0183 | 1.0605 | 0.0422 | 142 |
| Sol stock | tokenx | 0.9513 | 0.9043 | 0.9879 | 0.0836 | 142 |

Keep o200k. Tokenx improves Claude spread but fails the approved tighter-IQR gate on sol. There is no counter migration or new runtime dependency.

All 50 traced activations across six cohorts were `threshold`, with zero `block`. This excludes blocking as the explanation in this corpus, not in every historical session. In session `01a1e6f7-b5c1-73cf-95bb-adfcaddb30ed`, pending rounded to 30.0k; preceding provider usage was `2 + 57957 + 799 = 58758`, and the next request was `2 + 6108 + 11241 = 17351`. The activation removed 27,296 o200k tokens. The reconstructed preceding messages counted 29,968. The overhead-adjusted boundary ratio was 1.6574.

First-turn overhead-proxy medians in the final cohorts were 9,099 for Opus hashline, 7,916 for Opus stock, 4,171 for sol hashline, and 3,854 for sol stock. The source is `/tmp/om-token-calibration/report.md`, under "Overhead and boundary cross-check". These include first-prompt counter error and are not exact fixed overhead measurements. Each live check must measure its own overhead. Injected observations and replayed thinking must be accounted for separately.

The independent reviewer found pair-size dependence. Per-pair medians overstate cumulative threshold-relevant ratios. The lead independently recomputed `sum(delta) / sum(o200k)` from strict stable `pairs.jsonl` rows. Opus 5.5 ratios were 1.543140 for base, n=224; 1.533285 for final, n=204; and 1.580263 for omb, n=183. Opus 4.6 had 1.270199 across n=497, with per-pair median 1.348921. Content and model generation are confounded, so these are empirical calibration estimates, not tokenizer specifications.

The reviewer predicts that factor 1.55 gives a median 30.1k provider message tokens across 32 first-activation boundaries, with range 27.2k to 32.1k. This is retrospective extrapolation, not a changed-threshold live result. The reviewer rejected universal 1.63 because it predicts only 23.4k to 24.8k for Opus 4.6.

The content classifier assigns all strict samples to code, JSON, or tool-heavy content. Prose-only n=0. Mixed samples can contain prose, but this classification cannot establish a separate prose ratio. Observations within sessions are correlated.

### Revised bounded implementation

Use a small internal exact-model calibration table. Candidate factors are 1.55 for `claude-opus-5-5` and 1.30 for `claude-opus-4-6`. Opus 4.6 is provisional because it has no retained activation-boundary traces. Ship a table entry only after a live check for that ID passes. Do not extend either factor to unmeasured Sonnet, Haiku, other Opus generations, or unidentified models. Unmeasured models return the original config object unchanged. This preserves behavior rather than inventing a universal calibration.

Recognize provider-qualified versions of these exact IDs using observed routing conventions. Verify actual installed Bedrock and Vertex IDs before defining aliases. An `anthropic-messages` API alone does not identify a calibrated generation. Do not use a broad Claude regex to apply a factor. Do not add an unused `isClaudeModel` helper.

Keep all stored and cached counts in o200k. `thresholdsFor(config, model)` scales only `messageTokens`, `bufferTokens`, `retentionFloor`, and `observationBlockAfter`, rounded to integers. Leave observer and reflector budgets unchanged. Wire effective configs through all status, buffering, blocking, activation-selection, and status-display paths discovered by source inspection. Include effective threshold in activation trace details.

Start with failing behavioral tests covering both candidate IDs, supported routed aliases, unknown Claude IDs, missing models, and non-Claude identity preservation. Pin a threshold activation on a calibrated host and no activation at that same message count on a non-Claude host. Pin model-switch behavior and trace threshold reporting. Correct the misleading tokenx comment without changing its fallback behavior.

Before live calls, inspect the existing eval driver and its credential, cost, and isolation requirements. Do not read credentials or start paid requests without explicit authorization covering them. An offline replay is useful for regression but cannot replace live provider evidence. Live acceptance for each shipped factor is a `threshold` activation with overhead-adjusted provider message tokens in 25,500 to 34,500. Compare the preceding provider request to the activation and following drop, rather than mistaking the already reduced request for the activation boundary. Verify unchanged sol behavior.

Done still requires the three repository quality gates, independent review, and a passing commit-bound verifier. If a candidate fails live acceptance, remove it or remeasure and replan. Do not weaken the acceptance band. Preserve scripts and aggregate measurement evidence in the final deliverable without committing private session contents.

## Goal and done-predicate

Goal: on Claude models, OM activates at the same point in real context as on other models. Today it is reported to activate when the request is ~59k tokens on Opus, against ~30k on sol runs. Behavior for every non-Anthropic model stays byte-for-byte the same.

Done-predicate (falsifiable):
1. A measurement on real pi session data gives the cause of the 59k vs 30k gap: a tokenizer ratio `r` (Claude tokens per counter token, from provider usage), activation gating, or the comparison surface. It also gives the o200k-versus-tokenx counter comparison and the resulting counter decision. Both are recorded in this plan with their numbers.
2. If the tokenizer is a material cause (`r ≥ 1.1`), on a Claude main model the effective `messageTokens`, `bufferTokens`, `retentionFloor` and `observationBlockAfter` equal the Mastra values divided by `r`. Unit tests pin this. On a non-Claude model they equal the current values exactly. A test pins that too.
3. A live Opus run with `PI_OM_TRACE` set shows a `threshold` activation with provider-reported message tokens within ±15% of 30k plus the fixed system and tool overhead measured in step 2.
4. `npm run lint`, `npm run test` and `npm run typecheck` pass. A fresh-eyes review is done and `sbd-verdict check <SHA>` passes.

If step 2 shows that the tokenizer is not the cause, the predicate becomes "fix the measured cause". The plan is revised before any code changes.

## What the code establishes (read this session)

- `tokens.ts:4` counts all message tokens with `js-tiktoken` `o200k_base`. `MessageTokenCache` is keyed only by message object.
- Mastra Code `0.50.0` / `@mastra/memory 1.41.1` uses `tokenx` heuristics and not o200k. It does not count tokens per model either. So "parity with Mastra" does not mean the threshold is 30k Claude tokens.
- `config.ts:62-68` gives: threshold 30k, buffer 6k, retention 2k, blockAfter 60k. All are in counter units.
- Activation is gated. `runtime.ts:371` and `runtime.ts:613` activate only when `status.canActivate` is true, meaning a live, fully read, buffered chunk exists. Without one, pending grows until `mustBlock` at **60k**, then blocking observation runs (`runtime.ts:377`).
- The OM threshold excludes the system prompt, tool definitions and injected observations. A provider "request" figure includes all of them.

These give three hypotheses that can explain 59k vs 30k:
- **H1, tokenizer.** Claude tokenizes the same text into `r`× as many tokens as o200k does. 30k o200k is then ≈ 30k·r Claude tokens plus overhead.
- **H2, gating.** No buffered chunk is ready on Opus runs, for example because long tool loops keep chunks stale or unread. Activation waits until the 60k block. 59k is suspiciously close to `blockAfter`.
- **H3, surface.** The two figures measure different things. Anthropic `usage.input` excludes `cacheRead` and `cacheWrite`. The other agent may have summed them differently per provider, or system and tool overhead may differ between the two hosts.

The trace settles H2 directly: the activation `trigger` is either `threshold` or `block`, and the trace records `pending`. Provider usage deltas settle H1 and H3.

## Decisions

- **Measure before changing code.** Rejected: implementing the Anthropic counter straight away. The 1.6× figure came from another agent's log review, and the code shows a gating path (H2) that produces the same symptom. A tokenizer fix would not touch H2.
- **Calibrate the thresholds, not the counts.** For a Claude main model, divide the four message-budget thresholds by `r`. Counts stay in o200k. Rejected alternatives:
  - A Claude tokenizer in the hot path. None is accurate: `@anthropic-ai/tokenizer` is legacy, inaccurate for Claude 3 and later, and not installed.
  - Calling `count_tokens` per message. It is a network call with credentials on the hot path.
  - Scaling per-message counts. Persisted `chunk.messageTokens` (`engine.ts:203`) would mix units across model switches, and `MessageTokenCache` would need a tokenizer key. Scaling thresholds keeps one unit everywhere, so a model switch needs no migration and the cache keeps working.
- **Leave observation and reflection budgets alone.** `reflectionTokens`, `observerToolResultMaxTokens` and `previousObserverTokens` are measured on observer and reflector text and do not drive the reported symptom. Rejected: scaling everything, which adds scope that no measured problem justifies.
- **Detect Claude by the main model, not by the provider alone.** The check is `model.api === "anthropic-messages"` or a model id matching `/claude/i`. This covers Bedrock, Vertex and gateways that route to Claude. Rejected: `provider === "anthropic"`, which misses Claude on `amazon-bedrock` and `google-vertex`.
- **Measure tokenx next to o200k; don't switch by default.** tokenx is Mastra's counter, but it is just as model-agnostic, so a switch alone does not close the Claude gap. Switching only earns its place if tokenx tracks provider usage better on real sessions (step 2d). Rejected for now: switching for Mastra parity, which would mix persisted units (`engine.ts:203`, `observer.ts:137`, `reflector.ts:122`) for an unmeasured gain. Rejected: dropping tokenx from scope, because measuring it costs one more column.
- **`r` is a measured constant in code.** It is a named, documented constant with its measurement in the comment, for example `CLAUDE_TOKENS_PER_O200K = 1.xx`. Rejected: runtime self-calibration from usage deltas, which is noisy, depends on replay, and adds state. This is reversible: if drift shows up, the constant can become a calibration later.

## Design

- `config.ts`: keep `resolveConfig()` as it is. Add `thresholdsFor(config, model): ResolvedOMConfig`, a pure function that returns `config` unchanged for non-Claude models. For Claude it returns a copy with `messageTokens`, `bufferTokens`, `retentionFloor` and `observationBlockAfter` divided by `CLAUDE_TOKENS_PER_O200K` and rounded. It ignores `undefined` model (returns the base config).
- `tokens.ts` or a small `models.ts`: `isClaudeModel(model: { api?: string; id?: string } | undefined): boolean`.
- `runtime.ts`: where `computeStatus`, `shouldBuffer` and `selectActivationCount` take `this.config`, pass `thresholdsFor(this.config, host.model)`. There are three call sites: `onTurnEnd`, run start (`~604-624`) and `blockingObserve`. `/om status` (`ui.ts:81`) then shows the effective threshold automatically.
- Trace and status: include the effective `threshold` in the `record()` detail, so a run shows which calibration was applied.
- Principles: *boundary-discipline* (model detection is the one place that reads host identity, and the engine stays pure). *Laziness protocol* (one constant and one pure function, with no new tokenizer and no cache rekey). *Explain the number* (no constant before the 59k is attributed).

## Steps

1. Load the `sbd` skill. Set the done-predicate above with `sbd_set_predicate`.
2. **Measurement prototype (gates everything after it).** In build mode, with a read-only script under `/tmp`:
   a. Find recent Opus and sol pi sessions (session JSONL under pi's session dir) and any `PI_OM_TRACE` files. For each activation, record the trigger (`threshold` / `block` / `provider` / `ttl`), OM `pending` (o200k), and the next assistant's `usage.input + cacheRead + cacheWrite`. This settles H2 and H3.
   b. For consecutive Opus assistant turns, compute Δ(provider input total). Count the messages added between the turns in two ways, side by side. The first is o200k, using `countMessageTokens` from the built package. The second is tokenx 1.6.0 `estimateTokenCount`, run on the same extracted text, with the same 1,000-token flat image estimate, plus Mastra's 3.8-token per-message overhead. Do the same for sol. For each counter, the median ratio to provider usage gives `r_claude` and `r_sol`, and the interquartile range of the per-turn ratios gives its spread. Report the ratios per content mix (prose-heavy, code/JSON tool-result-heavy) as well. Take the system and tool overhead from the first turn's provider input minus the message count.
   c. Write the numbers into this plan's Decisions. That means a table with one row per counter and one column each for the median, IQR and n, for Claude and for sol. Evidence: the script, its output, and the session ids. tokenx is installed as a dev-only scratch dependency under `/tmp`, not in the repo.
   d. **Counter decision (gated on 2c).** Keep o200k unless tokenx has both a tighter IQR against provider usage than o200k, for Claude and for sol, and a sol median within ±10% of 1.0. If tokenx wins, replan before step 3 to add a counter-switch step. That step must cover recounting persisted `chunk.messageTokens` and `observationTokens` on load, and new literal-count test fixtures. Either way, `CLAUDE_TOKENS_PER_O200K` is renamed to match the chosen counter.
   e. **Stop conditions.** If H2 dominates, stop and replan the gating fix. If `r_claude < 1.1` for the chosen counter, report and stop: there is no tokenizer fix.
3. **sbd-worker: Claude detection and threshold calibration.** Start with failing tests in `packages/pi-om-extension/src/__tests__/`:
   - `isClaudeModel` returns true for `anthropic-messages` and for a Bedrock/Vertex `claude-*` id, and false for OpenAI, Gemini and an undefined model.
   - `thresholdsFor` returns the identical object for a non-Claude model and the scaled values for Claude.
   - A runtime test with a faux Claude host and ~30k/r o200k of messages activates at `threshold`. The same messages on a non-Claude host do not.
   Then implement. Evidence: red then green test output, then lint, typecheck and test.
4. **sbd-worker: trace detail.** Add the effective threshold to `record()` details, with a test asserting that the trace line contains it.
5. **Live check.** Run an Opus session with `PI_OM_TRACE=/tmp/om-trace.jsonl` until activation. Confirm a `threshold` trigger and that the provider input at activation ≈ 30k + the overhead from step 2b (±15%). Repeat briefly on sol and confirm its activation point did not move.
6. **Fresh-eyes review** by a `reviewer` agent on the diff against the predicate.
7. **Verifier verdict** with `sbd-verdict check <final SHA>`.

## Verification

- Unit: the threshold mapping and the Claude-versus-other activation point (steps 3 and 4).
- Real surface: the provider usage reported by Anthropic at the activation turn in a live Opus run, compared with the overhead-adjusted 30k (step 5). The non-Anthropic regression is shown by an unchanged sol activation point.

## Risks and open questions

- **`r` varies by content.** Code, JSON tool results and prose tokenize differently. One constant is a median and not exact. ±15% is the acceptance band. A wider spread in step 2b argues for per-content-type estimation, which would need a replan.
- **Claude model generations may differ.** If step 2b finds Opus and Sonnet/Haiku ratios differ by more than 10%, the constant becomes a small per-family table.
- **H2 is not excluded.** If Opus runs hit the 60k block because chunks are never ready, this plan does not fix that. Step 2 exists to catch it.
- **The tokenx reproduction is approximate.** Mastra applies tokenx through `TokenCounter`, with its own message serialization and overheads. Our harness reuses our text extraction, so its tokenx column approximates Mastra's counts rather than matching them exactly. That is enough to compare counters. It does not prove exact Mastra parity.
- **`tokens.ts:16` comment is wrong.** It says `ceil(len/4)` matches tokenx, which it doesn't. Step 3's worker corrects the comment and leaves the behavior alone.
- **Session data location.** It is outside this repo's allowed paths. Step 2 needs read access to pi's session directory and may need a `request_access` approval.
- **What "sol" is.** It is assumed to be a non-Anthropic model whose current behavior must not change. If sol is Claude-routed, the comparison in step 2 needs a different baseline.
