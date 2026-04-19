import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildMissingApiKeyMessage,
  createWebSearchTool,
  type ExaSearchClient,
  type ExaSearchResponse,
} from "../../web-search.js";

interface StubCall {
  query: string;
  type?: "neural" | "keyword" | "auto";
  numResults?: number;
}

function createStubClient(response: ExaSearchResponse, calls: StubCall[] = []): ExaSearchClient {
  return {
    search: vi.fn(async (query, options) => {
      calls.push({ query, type: options?.type, numResults: options?.numResults });
      return response;
    }),
  };
}

const sampleResult = (
  overrides: Partial<ExaSearchResponse["results"][number]> = {},
): ExaSearchResponse["results"][number] => ({
  title: "Sample title",
  url: "https://example.com/sample",
  publishedDate: "2026-01-15",
  author: "A. Writer",
  score: 0.92,
  text: "Sample text content for the result. ".repeat(10),
  ...overrides,
});

function createCtx(cwd = "/tmp/project"): ExtensionContext {
  return { cwd } as ExtensionContext;
}

describe("createWebSearchTool", () => {
  beforeEach(() => {
    delete process.env.PI_EXA_API_KEY;
    delete process.env.EXA_API_KEY;
  });

  afterEach(() => {
    delete process.env.PI_EXA_API_KEY;
    delete process.env.EXA_API_KEY;
  });

  it("formats multi-result responses and uses config defaults", async () => {
    const calls: StubCall[] = [];
    const client = createStubClient(
      {
        results: [
          sampleResult({ title: "First hit", url: "https://a.example", text: "content A" }),
          sampleResult({ title: "Second hit", url: "https://b.example", text: "content B" }),
        ],
      },
      calls,
    );
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: "exa-test",
        defaultSearchType: "keyword",
        defaultNumResults: 6,
        maxTextPerResult: 800,
      }),
      createClient: () => client,
    });

    const result = await tool.execute(
      "test-id",
      { label: "search", query: "test query" },
      undefined,
      undefined,
      createCtx(),
    );

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('Found 2 results for "test query"');
    expect(text).toContain("## 1. First hit");
    expect(text).toContain("https://a.example");
    expect(text).toContain("## 2. Second hit");
    expect(text).toContain("https://b.example");
    expect(text).toContain("Published: 2026-01-15");
    expect(text).toContain("Author: A. Writer");
    expect(text).toContain("content A");
    expect(text).toContain("content B");
    expect(calls[0]).toEqual({ query: "test query", type: "keyword", numResults: 6 });
  });

  it("lets tool-call params override config defaults", async () => {
    const calls: StubCall[] = [];
    const client = createStubClient({ results: [] }, calls);
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: "exa-test",
        defaultSearchType: "auto",
        defaultNumResults: 5,
        maxTextPerResult: 800,
      }),
      createClient: () => client,
    });

    await tool.execute(
      "test-id",
      { label: "search", query: "override", num_results: 3, type: "neural" },
      undefined,
      undefined,
      createCtx(),
    );

    expect(calls[0]).toEqual({ query: "override", type: "neural", numResults: 3 });
  });

  it("formats no-results responses cleanly", async () => {
    const client = createStubClient({ results: [] });
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: "exa-test",
        defaultSearchType: "auto",
        defaultNumResults: 5,
        maxTextPerResult: 800,
      }),
      createClient: () => client,
    });

    const result = await tool.execute(
      "test-id",
      { label: "search", query: "nothing" },
      undefined,
      undefined,
      createCtx(),
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toBe('No results found for "nothing".');
  });

  it("trims long result text using the configured per-result cap", async () => {
    const client = createStubClient({
      results: [sampleResult({ title: "Long", text: "x".repeat(2_000) })],
    });
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: "exa-test",
        defaultSearchType: "auto",
        defaultNumResults: 5,
        maxTextPerResult: 120,
      }),
      createClient: () => client,
    });

    const result = await tool.execute(
      "test-id",
      { label: "search", query: "long" },
      undefined,
      undefined,
      createCtx(),
    );
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(500);
  });

  it("throws a setup message when no API key is configured", async () => {
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: undefined,
        defaultSearchType: "auto",
        defaultNumResults: 5,
        maxTextPerResult: 800,
      }),
    });

    await expect(
      tool.execute(
        "test-id",
        { label: "search", query: "anything" },
        undefined,
        undefined,
        createCtx(),
      ),
    ).rejects.toThrow(buildMissingApiKeyMessage());
  });

  it("rejects pre-aborted signals before calling the client", async () => {
    const calls: StubCall[] = [];
    const client = createStubClient({ results: [] }, calls);
    const tool = createWebSearchTool({
      loadConfig: () => ({
        apiKey: "exa-test",
        defaultSearchType: "auto",
        defaultNumResults: 5,
        maxTextPerResult: 800,
      }),
      createClient: () => client,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      tool.execute(
        "test-id",
        { label: "search", query: "x" },
        controller.signal,
        undefined,
        createCtx(),
      ),
    ).rejects.toThrow(/aborted/i);

    expect(calls).toHaveLength(0);
  });
});
