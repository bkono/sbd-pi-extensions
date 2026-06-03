import { describe, expect, it } from "vitest";
import {
  compressBuildToolsOutput,
  compressTransferOutput,
  isBuildToolsCommand,
  isTransferCommand,
} from "../src/rtk/index.js";

describe("rtk index exports", () => {
  it("exports build-tools APIs", () => {
    expect(typeof isBuildToolsCommand).toBe("function");
    expect(typeof compressBuildToolsOutput).toBe("function");
  });

  it("exports transfer APIs", () => {
    expect(typeof isTransferCommand).toBe("function");
    expect(typeof compressTransferOutput).toBe("function");
  });
});
