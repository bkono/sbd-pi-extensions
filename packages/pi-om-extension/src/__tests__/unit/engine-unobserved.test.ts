import { describe, expect, it } from "vitest";
import { getUnobservedMessages } from "../../engine.js";
import { conversation, messageId, resetMessageCounter } from "../helpers/fixtures.js";

describe("getUnobservedMessages", () => {
  it("returns all messages with mode=none when no cursor set", () => {
    resetMessageCounter();
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const result = getUnobservedMessages(msgs);
    expect(result.messages).toHaveLength(5);
    expect(result.mode).toBe("none");
  });

  it("returns empty array with mode=none when no messages and no cursor", () => {
    const result = getUnobservedMessages([]);
    expect(result.messages).toEqual([]);
    expect(result.mode).toBe("none");
  });

  it("slices after matched ID when cursor hits", () => {
    resetMessageCounter();
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorId = messageId(msgs[1]!)!;
    const result = getUnobservedMessages(msgs, cursorId);
    expect(result.mode).toBe("id");
    expect(result.messages).toHaveLength(3); // indices 2, 3, 4
    expect(messageId(result.messages[0]!)).toBe(messageId(msgs[2]!));
  });

  it("falls through to fallback-latest when ID cursor misses and no timestamp", () => {
    resetMessageCounter();
    const msgs = conversation(3, { baseTs: 1_700_000_000_000 });
    const result = getUnobservedMessages(msgs, "nonexistent-id");
    expect(result.mode).toBe("fallback-latest");
    expect(result.messages).toHaveLength(1);
    expect(messageId(result.messages[0]!)).toBe(messageId(msgs[2]!));
  });

  it("uses timestamp cursor when no ID provided", () => {
    resetMessageCounter();
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    // Cursor at timestamp of message 1 — should return msgs[2..4]
    const cursorTs = 1_700_000_000_000 + 1 * 1000;
    const result = getUnobservedMessages(msgs, undefined, cursorTs);
    expect(result.mode).toBe("timestamp");
    expect(result.messages).toHaveLength(3);
  });

  it("returns empty when timestamp cursor is after all messages", () => {
    resetMessageCounter();
    const msgs = conversation(3, { baseTs: 1_700_000_000_000 });
    const cursorTs = 1_700_000_999_999; // well after all messages
    const result = getUnobservedMessages(msgs, undefined, cursorTs);
    expect(result.mode).toBe("timestamp");
    expect(result.messages).toHaveLength(0);
  });

  it("prefers ID cursor over timestamp when both given and ID found", () => {
    resetMessageCounter();
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorId = messageId(msgs[0]!)!;
    const cursorTs = 1_700_000_000_000 + 3 * 1000; // would point to msgs[4..]
    const result = getUnobservedMessages(msgs, cursorId, cursorTs);
    // ID wins — returns msgs[1..4]
    expect(result.mode).toBe("id");
    expect(result.messages).toHaveLength(4);
  });

  it("falls through to timestamp when ID cursor misses", () => {
    resetMessageCounter();
    const msgs = conversation(5, { baseTs: 1_700_000_000_000 });
    const cursorTs = 1_700_000_000_000 + 1 * 1000;
    const result = getUnobservedMessages(msgs, "nonexistent-id", cursorTs);
    expect(result.mode).toBe("timestamp");
    expect(result.messages).toHaveLength(3);
  });
});
