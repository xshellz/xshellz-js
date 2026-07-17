import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_KEYSTORE_DIR, Keystore, sanitizeSandboxName } from "../src/keystore.js";

let dir: string;
let store: Keystore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "xshellz-keystore-test-"));
  store = new Keystore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sanitizeSandboxName", () => {
  it("keeps safe characters and replaces everything else with underscores", () => {
    expect(sanitizeSandboxName("my-box_1.2")).toBe("my-box_1.2");
    expect(sanitizeSandboxName("my box/../etc")).toBe("my_box_.._etc");
    expect(sanitizeSandboxName("")).toBe("_");
  });
});

describe("Keystore", () => {
  it("defaults to ~/.xshellz/keys", () => {
    expect(DEFAULT_KEYSTORE_DIR).toBe(join(homedir(), ".xshellz", "keys"));
    expect(new Keystore().dir).toBe(DEFAULT_KEYSTORE_DIR);
  });

  it("saves a key with 0600 permissions and loads it back", async () => {
    const path = await store.save("my box", "PRIVATE-KEY-DATA\n");

    expect(path).toBe(join(dir, "my_box.key"));
    expect((await readFile(path)).toString()).toBe("PRIVATE-KEY-DATA\n");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(await store.load("my box")).toBe("PRIVATE-KEY-DATA\n");
  });

  it("overwrites an existing key on save", async () => {
    await store.save("box", "old");
    await store.save("box", "new");

    expect(await store.load("box")).toBe("new");
  });

  it("returns null when no key is stored", async () => {
    expect(await store.load("unknown")).toBeNull();
  });

  it("delete() removes the key and reports whether one existed", async () => {
    await store.save("box", "key");

    expect(await store.delete("box")).toBe(true);
    expect(await store.load("box")).toBeNull();
    expect(await store.delete("box")).toBe(false);
  });

  it("keyPath() sanitizes hostile names so keys stay inside the store", () => {
    expect(store.keyPath("../../etc/passwd")).toBe(join(dir, ".._.._etc_passwd.key"));
  });
});
