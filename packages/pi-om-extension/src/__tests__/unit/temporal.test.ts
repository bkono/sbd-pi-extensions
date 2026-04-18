import { describe, expect, it } from "vitest";
import { deriveObservationEntries, normalizeObservationEntries } from "../../temporal.js";

describe("temporal normalization", () => {
  it("derives durable anchors for high-confidence relative phrases", () => {
    const entries = deriveObservationEntries(`
<observations>
Date: Apr 18, 2026
* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.
* 🟡 (09:42) Error pattern appears to have started last week.
* 🟡 (09:43) User plans to switch deploy windows next Friday.
* 🟡 (09:44) Rollout moves next week.
* 🟢 (09:45) They might revisit Friday.
</observations>
`);

    expect(entries).toHaveLength(5);

    expect(entries?.[0]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T21:13:00.000Z",
        originalPhrase: "tomorrow",
        referencedStart: "2026-04-19",
        precision: "day",
        relation: "future",
      },
    ]);

    expect(entries?.[1]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T09:42:00.000Z",
        originalPhrase: "last week",
        referencedStart: "2026-04-06",
        referencedEnd: "2026-04-12",
        precision: "week",
        relation: "past",
      },
    ]);

    expect(entries?.[2]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T09:43:00.000Z",
        originalPhrase: "next Friday",
        referencedStart: "2026-04-24",
        precision: "day",
        relation: "future",
      },
    ]);

    expect(entries?.[3]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T09:44:00.000Z",
        originalPhrase: "next week",
        referencedStart: "2026-04-20",
        referencedEnd: "2026-04-26",
        precision: "approximate",
        relation: "future",
      },
    ]);

    expect(entries?.[4]?.temporalAnchors).toBeUndefined();
  });

  it("parses explicit inline anchors without duplicating them", () => {
    const entries = deriveObservationEntries(`
Date: Apr 18, 2026
* 🔴 (21:13) User plans to revisit reflection robustness tomorrow (target: 2026-04-19).
* 🟡 (09:44) Rollout moves next week (approx: 2026-04-20..2026-04-26).
`);

    expect(entries?.[0]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T21:13:00.000Z",
        originalPhrase: "tomorrow",
        referencedStart: "2026-04-19",
        precision: "day",
        relation: "future",
      },
    ]);

    expect(entries?.[1]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T09:44:00.000Z",
        originalPhrase: "next week",
        referencedStart: "2026-04-20",
        referencedEnd: "2026-04-26",
        precision: "approximate",
        relation: "future",
      },
    ]);
  });

  it("fills in missing anchors on structured entries without clobbering existing metadata", () => {
    const entries = normalizeObservationEntries([
      {
        date: "2026-04-18",
        line: "* 🔴 (21:13) User plans to revisit reflection robustness tomorrow.",
      },
      {
        date: "2026-04-18",
        line: "* 🟡 (09:42) Error pattern appears to have started last week (week of 2026-04-06).",
        temporalAnchors: [
          {
            recordedAt: "2026-04-18T09:42:00.000Z",
            originalPhrase: "last week",
            referencedStart: "2026-04-06",
            referencedEnd: "2026-04-12",
            precision: "week",
            relation: "past",
          },
        ],
      },
    ]);

    expect(entries?.[0]?.temporalAnchors?.[0]?.originalPhrase).toBe("tomorrow");
    expect(entries?.[0]?.temporalAnchors?.[0]?.referencedStart).toBe("2026-04-19");
    expect(entries?.[1]?.temporalAnchors).toHaveLength(1);
  });

  it("keeps multi-day anchors chronologically correct across gaps and future state changes", () => {
    const entries = deriveObservationEntries(
      `
Date: Apr 18, 2026
* 🔴 (09:00) User plans to resume tomorrow.
Date: Apr 21, 2026
* 🟡 (10:15) User resumed work yesterday after a multi-day gap.
* 🟡 (10:16) Rollout now shifts next Friday.
* 🟡 (10:17) They may revisit Friday.
Date: Apr 25, 2026
* 🟢 (08:30) Rollout landed yesterday as planned.
`.trim(),
    );

    expect(entries).toHaveLength(5);

    expect(entries?.[0]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-18T09:00:00.000Z",
        originalPhrase: "tomorrow",
        referencedStart: "2026-04-19",
        precision: "day",
        relation: "future",
      },
    ]);

    expect(entries?.[1]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-21T10:15:00.000Z",
        originalPhrase: "yesterday",
        referencedStart: "2026-04-20",
        precision: "day",
        relation: "past",
      },
    ]);

    expect(entries?.[2]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-21T10:16:00.000Z",
        originalPhrase: "next Friday",
        referencedStart: "2026-04-24",
        precision: "day",
        relation: "future",
      },
    ]);

    expect(entries?.[3]?.temporalAnchors).toBeUndefined();

    expect(entries?.[4]?.temporalAnchors).toEqual([
      {
        recordedAt: "2026-04-25T08:30:00.000Z",
        originalPhrase: "yesterday",
        referencedStart: "2026-04-24",
        precision: "day",
        relation: "past",
      },
    ]);
  });
});
