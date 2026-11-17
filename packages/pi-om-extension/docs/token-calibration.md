# Opus 5.5 threshold calibration

Opus 5.5 uses a conservative threshold factor of 1.40. This is an activation calibration, not an exact tokenizer conversion. Native Pi calibration runs support the factor. The independent held-out run recorded six activations before its predeclared request cap stopped the workload. Bryan accepted those observations as sufficient activation evidence. The workload remains incomplete, not a task pass.

## Counting and thresholds

`thresholdsFor` matches 16 exact installed Opus 5.5 provider/model routes. It divides four message thresholds by 1.40 and rounds.

| Threshold | Base o200k tokens | Opus 5.5 o200k tokens |
|---|---:|---:|
| `messageTokens` | 30,000 | 21,429 |
| `bufferTokens` | 6,000 | 4,286 |
| `retentionFloor` | 2,000 | 1,429 |
| `observationBlockAfter` | 60,000 | 42,857 |

Stored message and observation counts remain in o200k units. Observer and reflector budgets do not change. Sol, Opus 4.6, other Claude generations, unknown routes, and missing models retain the original configuration by identity. The native provider was tested directly. The other installed Opus 5.5 route aliases share its factor by inference, not separate live measurement.

## Why 1.40 rather than 1.55

Historical strict weighted provider-growth ratios were 1.543140 over 224 pairs, 1.533285 over 204 pairs, and 1.580263 over 183 pairs. Tokenx failed the narrower-spread requirement on Sol, so o200k remains the counter.

A lower threshold factor delays activation. Factor 1.55 caused a native UI activation after only 20,903 overhead-adjusted sent provider-input tokens. A large tool result crossed the local threshold before the provider saw that result. Factor 1.40 gives more room before activation and avoids that premature swap in the calibration runs.

The acceptance floor is 25,000 adjusted sent tokens, preferably at least 27,000. Late activation is acceptable when observation readiness or the lack of a safe swap point delays the swap. The calibration does not change those gates or guarantee an exact provider-token boundary for arbitrary tool results.

## Native calibration evidence

The tasks are real Opus 5.5 pricing-maintenance and activation-UI workflows. Native Pi ran unchanged prompts and real tools with Opus 5.5 as the main model and Sol as observer. Session usage and `PI_OM_TRACE` provide the measurements. No transport override or HTTP interception was used.

| Task and factor | Adjusted sent provider-input tokens before each threshold activation |
|---|---|
| Pricing, baseline | 47,018 |
| UI, baseline | 55,077; 54,720 |
| Pricing, 1.55 | 30,126; 31,265; 32,283 |
| UI, 1.55 | 20,903; 37,342; 39,495; 31,456 |
| Pricing, 1.40 | 32,597; 36,406 |
| UI, 1.40 | 37,350; 37,522; 40,061 |

Adjusted input subtracts each run's first actual input as an overhead proxy. That input includes the initial prompt, so this is not exact system/tool-only subtraction. Provider input sums normalized `input`, `cacheRead`, and `cacheWrite`. The preceding sent request, not the postactivation response or the unsent activation context, defines each boundary.

The five factor-1.40 boundaries have separate unsent o200k counts of 1,060 and 383 for pricing, and 2,407, 2,186, and 3,739 for UI. An audit of Pi's awaited context transformation resolves a same-millisecond pricing boundary. Session persistence order alone is not request order.

Both factor-1.40 tasks exited zero. Pricing's natural tests passed 50/50. UI's behavioral grader passed 3/3. Pricing's separate reference grader failed because it requires the unrequested `discountCapBpsFor` export. That failure is retained and is not reported as a passing grade.

Factor 1.40 was frozen before the independent returns-policy held-out task. All six threshold activations exceeded the preferred floor.

| Held-out boundary | Adjusted sent provider input | Unsent o200k tokens | Following gross provider input |
|---|---:|---:|---:|
| 1 | 30,680 | 2,360 | 12,818 |
| 2 | 35,216 | 4,266 | 16,183 |
| 3 | 39,297 | 1,529 | 16,364 |
| 4 | 40,528 | 1,476 | 19,541 |
| 5 | 44,278 | 368 | 23,470 |
| 6 | 44,133 | 4,321 | 29,911 |

Each adjusted input subtracts the same 4,725-token initial-request proxy. The frozen source hashes and expected Opus 5.5 main and Sol observer routes were verified. Readiness timestamps do not prove that no earlier subset could activate. Late timing alone does not establish a gating defect.

The predeclared 140-model-request cap stopped the run with exit 70 after 11 of 17 prompts, during the twelfth. This is a censored workload, not a completed task pass. Its partial natural suite passed 133/135 tests and its frozen reference grader passed 143/157. The failures include an in-progress rename, missing exports, and unfinished later requirements. No continuation, retuning, or test repairs followed. Bryan accepted the six activation observations as sufficient evidence for this change.

Native Sol controls completed with baseline and candidate adjusted activation inputs of 29,384 and 30,670. Both retained the 30,000-o200k threshold. Their natural tests passed 58/58 and 44/44. Both separate reference graders failed on the unrequested `discountCapBpsFor` export. These are independent task executions, not identical token trajectories.

Behavioral tests establish routing, buffering, blocking, retention, model switching, and unchanged noncalibrated behavior. They do not replace live provider measurements.

The tracked investigation history is `.mastracode/plans/om-anthropic-token-calibration.md`. Local raw sessions, traces, the boundary audit, and the pre-held-out freeze record are retained separately. The repetitive synthetic fixture and the abandoned transport driver are not acceptance evidence and are not shipped.
