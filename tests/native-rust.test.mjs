import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { hasCargo, resolveCargoExecutable } from "../tools/native-rust.mjs";

describe("native-rust tool", () => {
  const tempDirs = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it("falls back to the standard rustup cargo home when PATH is incomplete", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "bosun-native-rust-"));
    const cargoPath = resolve(tempHome, ".cargo", "bin", "cargo.exe");
    tempDirs.push(tempHome);
    mkdirSync(resolve(tempHome, ".cargo", "bin"), { recursive: true });
    writeFileSync(cargoPath, "", "utf8");

    const resolved = resolveCargoExecutable({
      env: {
        USERPROFILE: tempHome,
        HOME: "",
        CARGO_HOME: "",
        BOSUN_CARGO_BIN: "",
      },
      platform: "win32",
      exists: (candidate) => candidate === cargoPath,
      probe: (command) => ({ status: command === cargoPath ? 0 : 1 }),
    });

    expect(resolved).toBe(cargoPath);
    expect(hasCargo({
      env: {
        USERPROFILE: tempHome,
        HOME: "",
        CARGO_HOME: "",
        BOSUN_CARGO_BIN: "",
      },
      platform: "win32",
      exists: (candidate) => candidate === cargoPath,
      probe: (command) => ({ status: command === cargoPath ? 0 : 1 }),
    })).toBe(true);
  });

  it("honors an explicit cargo override before probing rustup homes", () => {
    const explicitCargo = "C:\\custom\\cargo.exe";
    const resolved = resolveCargoExecutable({
      env: {
        BOSUN_CARGO_BIN: explicitCargo,
        USERPROFILE: "C:\\Users\\example",
      },
      platform: "win32",
      exists: (candidate) => candidate === explicitCargo,
      probe: (command) => ({ status: command === explicitCargo ? 0 : 1 }),
    });

    expect(resolved).toBe(explicitCargo);
  });
});
