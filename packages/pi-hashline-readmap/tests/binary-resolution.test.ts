import { describe, expect, it } from "vitest";
import { executableCommand, resolveBundledBin } from "../src/binary-resolution.js";

describe("resolveBundledBin", () => {
  it("uses the direct package bin on non-Windows even when an npm .bin shim exists", () => {
    const resolved = resolveBundledBin("@ast-grep/cli", "sg", "ast-grep", {
      resolvePackageJson: () => "/repo/node_modules/@ast-grep/cli/package.json",
      readPackageJson: () => JSON.stringify({ bin: { sg: "bin/sg" } }),
      existsSync: (candidate) =>
        candidate === "/repo/node_modules/.bin/sg" ||
        candidate === "/repo/node_modules/@ast-grep/cli/bin/sg",
      platform: "darwin",
    });

    expect(resolved).toBe("/repo/node_modules/@ast-grep/cli/bin/sg");
  });

  it("resolves Windows JavaScript package bins and prepares them for node execution", () => {
    const resolved = resolveBundledBin("example-js-cli", "example", "example", {
      resolvePackageJson: () => "/repo/node_modules/example-js-cli/package.json",
      readPackageJson: () => JSON.stringify({ bin: "lib/index.js" }),
      existsSync: (candidate) => candidate === "/repo/node_modules/example-js-cli/lib/index.js",
      platform: "win32",
    });

    expect(resolved).toBe("/repo/node_modules/example-js-cli/lib/index.js");
    const command = executableCommand(resolved, "win32");
    expect(command.command).toBe(process.execPath);
    expect(command.argsPrefix).toEqual(["/repo/node_modules/example-js-cli/lib/index.js"]);
  });

  it("resolves Windows package executables when no npm .bin shim exists", () => {
    const resolved = resolveBundledBin("@ast-grep/cli", "sg", "ast-grep", {
      resolvePackageJson: () => "/repo/node_modules/@ast-grep/cli/package.json",
      readPackageJson: () => JSON.stringify({ bin: { sg: "sg" } }),
      existsSync: (candidate) => candidate === "/repo/node_modules/@ast-grep/cli/sg.exe",
      platform: "win32",
    });

    expect(resolved).toBe("/repo/node_modules/@ast-grep/cli/sg.exe");
  });

  it("leaves native executables and non-Windows scripts as direct commands", () => {
    expect(executableCommand("/repo/node_modules/@ast-grep/cli/sg.exe", "win32")).toEqual({
      command: "/repo/node_modules/@ast-grep/cli/sg.exe",
      argsPrefix: [],
    });
    expect(executableCommand("/repo/node_modules/example-js-cli/lib/index.js", "darwin")).toEqual({
      command: "/repo/node_modules/example-js-cli/lib/index.js",
      argsPrefix: [],
    });
  });

  it("returns an existing bin path from an npm package.json bin map before falling back to PATH", () => {
    const resolved = resolveBundledBin("@ast-grep/cli", "sg", "ast-grep", {
      resolvePackageJson: (specifier) => {
        expect(specifier).toBe("@ast-grep/cli/package.json");
        return "/repo/node_modules/@ast-grep/cli/package.json";
      },
      readPackageJson: () => JSON.stringify({ bin: { sg: "bin/sg" } }),
      existsSync: (candidate) => candidate === "/repo/node_modules/@ast-grep/cli/bin/sg",
    });

    expect(resolved).toBe("/repo/node_modules/@ast-grep/cli/bin/sg");
  });

  it("returns an existing bin path from a string package.json bin entry", () => {
    const resolved = resolveBundledBin("example-js-cli", "example", "example", {
      resolvePackageJson: () => "/repo/node_modules/example-js-cli/package.json",
      readPackageJson: () => JSON.stringify({ bin: "example" }),
      existsSync: (candidate) => candidate === "/repo/node_modules/example-js-cli/example",
    });

    expect(resolved).toBe("/repo/node_modules/example-js-cli/example");
  });

  it("returns the PATH fallback command when the npm package cannot be resolved", () => {
    const resolved = resolveBundledBin("@ast-grep/cli", "sg", "ast-grep", {
      resolvePackageJson: () => {
        throw Object.assign(new Error("Cannot find module '@ast-grep/cli/package.json'"), {
          code: "MODULE_NOT_FOUND",
        });
      },
      readPackageJson: () => {
        throw new Error("should not read package.json after resolution failed");
      },
      existsSync: () => false,
    });

    expect(resolved).toBe("ast-grep");
  });

  it("returns the PATH fallback command when the package bin entry is missing", () => {
    const resolved = resolveBundledBin("@ast-grep/cli", "sg", "ast-grep", {
      resolvePackageJson: () => "/repo/node_modules/@ast-grep/cli/package.json",
      readPackageJson: () => JSON.stringify({ bin: { "ast-grep": "bin/ast-grep" } }),
      existsSync: () => false,
    });

    expect(resolved).toBe("ast-grep");
  });
});
