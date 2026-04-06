import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Records everything our verification extension observes during an e2e run.
 *
 * The verification extension is registered AFTER the OM extension in the
 * extensionFactories array, so it sees the system prompt and messages as
 * modified by OM. pi's extension runner chains results between handlers.
 */
export interface VerificationRecord {
  hookOrder: string[];
  sessionStart: Array<{ sessionId: string }>;
  beforeAgentStart: Array<{
    prompt: string;
    incomingSystemPrompt: string;
  }>;
  contextEvents: Array<{
    messageCount: number;
    messageRoles: string[];
    hasObservationsInFirstUserMessage: boolean;
  }>;
  agentEnds: Array<{ messageCount: number }>;
  sessionBeforeCompacts: Array<{ reason: string }>;
}

export function createVerificationRecord(): VerificationRecord {
  return {
    hookOrder: [],
    sessionStart: [],
    beforeAgentStart: [],
    contextEvents: [],
    agentEnds: [],
    sessionBeforeCompacts: [],
  };
}

export function createVerificationExtension(record: VerificationRecord) {
  return function verificationExtension(pi: ExtensionAPI): void {
    pi.on("session_start", async (_event, ctx) => {
      record.hookOrder.push("session_start");
      record.sessionStart.push({ sessionId: ctx.sessionManager.getSessionId() });
    });

    pi.on("before_agent_start", async (event, _ctx) => {
      record.hookOrder.push("before_agent_start");
      // By the time this runs, the OM extension has already (potentially)
      // modified event.systemPrompt. The runner mutates the event between
      // handlers, so we see the post-OM value here.
      record.beforeAgentStart.push({
        prompt: event.prompt,
        incomingSystemPrompt: event.systemPrompt,
      });
    });

    pi.on("context", async (event, _ctx) => {
      record.hookOrder.push("context");
      const roles = event.messages.map((m) => (m as unknown as { role: string }).role);
      // Check if the first user message looks like it has an observations block
      const firstUser = event.messages.find(
        (m) => (m as unknown as { role: string }).role === "user",
      );
      const firstContent =
        (firstUser as unknown as { content?: string } | undefined)?.content ?? "";
      record.contextEvents.push({
        messageCount: event.messages.length,
        messageRoles: roles,
        hasObservationsInFirstUserMessage:
          typeof firstContent === "string" && firstContent.includes("<observations>"),
      });
    });

    pi.on("agent_end", async (event, _ctx) => {
      record.hookOrder.push("agent_end");
      record.agentEnds.push({ messageCount: event.messages.length });
    });

    pi.on("session_before_compact", async (_event, _ctx) => {
      record.hookOrder.push("session_before_compact");
      record.sessionBeforeCompacts.push({ reason: "triggered" });
    });
  };
}
