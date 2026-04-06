/**
 * Drop-in replacement for `../../agents.js` used by Layer 3 extension tests.
 *
 * Layer 3 tests use `vi.mock("../../agents.js", ...)` to substitute the real
 * `ObservationAgents` class with a mock. Because the extension constructs
 * `ObservationAgents` inside its `ensureInitialized` closure, we can't pass
 * a mock directly — we have to intercept the import.
 *
 * Pattern:
 *   import { __installMockAgents } from "../helpers/mock-agents-module.js";
 *   import { MockObservationAgents } from "../helpers/mock-agents.js";
 *
 *   vi.mock("../../agents.js", async () => {
 *     const actual = await vi.importActual<typeof import("../../agents.js")>("../../agents.js");
 *     const mod = await import("../helpers/mock-agents-module.js");
 *     return { ...actual, ObservationAgents: mod.ObservationAgents };
 *   });
 *
 *   beforeEach(() => {
 *     __installMockAgents(new MockObservationAgents({ observeResponses: [...] }));
 *   });
 */

import type { MockObservationAgents } from "./mock-agents.js";

let currentMock: MockObservationAgents | null = null;

export function __installMockAgents(mock: MockObservationAgents): void {
  currentMock = mock;
}

export function __clearMockAgents(): void {
  currentMock = null;
}

export function __getMockAgents(): MockObservationAgents | null {
  return currentMock;
}

/**
 * Stub class that returns the currently installed mock from its constructor.
 * Structural typing makes the return value compatible with `ObservationAgents`
 * for consumers that only call `observe()` and `reflect()`.
 */
export class ObservationAgents {
  constructor(_config: unknown) {
    if (!currentMock) {
      throw new Error(
        "[mock-agents-module] No mock installed. Call __installMockAgents() in beforeEach.",
      );
    }
    // biome-ignore lint: intentional — return mock as the constructed instance
    return currentMock as unknown as ObservationAgents;
  }
}
