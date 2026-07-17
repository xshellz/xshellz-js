import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissingKeyError } from "../src/errors.js";
import { Keystore } from "../src/keystore.js";
import { Sandbox } from "../src/sandbox.js";
import type { TransportTarget } from "../src/transport.js";
import { FakeTransport, jsonResponse, shellInfo, UUID } from "./helpers.js";

const API_KEY = "test-pat-token";
const BASE = "https://api.staging.example/v1";

const fetchMock = vi.fn();
let transports: FakeTransport[];
let keysDir: string;

function transportFactory(target: TransportTarget): FakeTransport {
  const transport = new FakeTransport(target);
  transports.push(transport);

  return transport;
}

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  transports = [];
  keysDir = await mkdtemp(join(tmpdir(), "xshellz-getorcreate-test-"));
  delete process.env.XSHELLZ_API_KEY;
  delete process.env.XSHELLZ_API_URL;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(keysDir, { recursive: true, force: true });
});

describe("Sandbox.getOrCreate", () => {
  it("creates the box when the name is not taken and persists the key (0600)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "other-box", uuid: "other-uuid" })]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box" })));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [listUrl, listInit] = fetchMock.mock.calls[0]!;
    expect(listUrl).toBe(`${BASE}/shells/agent`);
    expect(listInit.method).toBe("GET");

    const [createUrl, createInit] = fetchMock.mock.calls[1]!;
    expect(createUrl).toBe(`${BASE}/shells/agent`);
    expect(createInit.method).toBe("POST");
    const body = JSON.parse(createInit.body);
    expect(body.name).toBe("my-box");
    expect(body.ssh_public_key).toMatch(/^ssh-ed25519 /);

    const keyPath = join(keysDir, "my-box.key");
    expect((await readFile(keyPath)).toString()).toBe(sbx.privateKey);
    expect(((await stat(keyPath)).mode & 0o777).toString(8)).toBe("600");
  });

  it("attaches to an existing running box using the keystore key", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // list only — no create, no start
    expect(sbx.uuid).toBe(UUID);
    expect(sbx.privateKey).toBe("STORED-KEY");

    await sbx.run("true");
    expect(transports[0]!.target.privateKey).toBe("STORED-KEY");
  });

  it("requires an exact name match", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box-2" })]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box" })));

    await Sandbox.getOrCreate("my-box", { apiKey: API_KEY, apiUrl: BASE, keystore: keysDir, transportFactory });

    expect(fetchMock.mock.calls[1]![1].method).toBe("POST"); // created, not attached
  });

  it("starts a stopped box and refreshes its info", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box", status: "stopped" })]));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box", status: "running" })));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${UUID}/start`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
    expect(sbx.status).toBe("running");
  });

  it("prefers an explicit privateKey over the keystore", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      privateKey: "EXPLICIT-KEY",
      transportFactory,
    });

    expect(sbx.privateKey).toBe("EXPLICIT-KEY");
  });

  it("accepts a Keystore instance", async () => {
    const store = new Keystore(keysDir);
    await store.save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", { apiKey: API_KEY, apiUrl: BASE, keystore: store, transportFactory });

    expect(sbx.privateKey).toBe("STORED-KEY");
  });

  it("throws MissingKeyError naming the expected key file when the keystore has no key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const error = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingKeyError);
    expect((error as MissingKeyError).message).toContain(join(keysDir, "my-box.key"));
  });

  it("keystore: false is create-only — an existing box without a privateKey errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const error = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: false,
      transportFactory,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MissingKeyError);
    expect((error as MissingKeyError).message).toContain("keystore disabled");
  });

  it("keystore: false still creates a missing box, without writing any file", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box" })));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: false,
      transportFactory,
    });

    expect(sbx.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    await expect(readFile(join(keysDir, "my-box.key"))).rejects.toThrowError();
  });
});

describe("Sandbox.getOrCreate detached semantics", () => {
  it("marks a newly created box detached", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box" })));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    expect(sbx.detached).toBe(true);
  });

  it("marks an attached existing box detached", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    expect(sbx.detached).toBe(true);
  });

  it("close() keeps a detached box alive (no DELETE) but drops the SSH transport", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    await sbx.run("true"); // establishes the fake transport
    await sbx.close();

    expect(fetchMock).toHaveBeenCalledTimes(1); // list only — no DELETE
    expect(sbx.status).toBe("running");
    expect(transports[0]!.closed).toBe(true);
  });

  it("await using does NOT destroy a detached getOrCreate box", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    {
      await using sbx = await Sandbox.getOrCreate("my-box", {
        apiKey: API_KEY,
        apiUrl: BASE,
        keystore: keysDir,
        transportFactory,
      });
      expect(sbx.status).toBe("running");
    }

    expect(fetchMock).toHaveBeenCalledTimes(1); // list only — no DELETE on scope exit
  });

  it("kill() still destroys a detached box", async () => {
    await new Keystore(keysDir).save("my-box", "STORED-KEY");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ name: "my-box" })]));

    const sbx = await Sandbox.getOrCreate("my-box", {
      apiKey: API_KEY,
      apiUrl: BASE,
      keystore: keysDir,
      transportFactory,
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));
    await sbx.kill();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1].method).toBe("DELETE");
    expect(sbx.status).toBe("deleted");
  });

  it("detach() makes close() keep a create() box alive", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));
    const sbx = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE, transportFactory });

    expect(sbx.detached).toBe(false);
    sbx.detach();
    expect(sbx.detached).toBe(true);

    await sbx.close();

    expect(fetchMock).toHaveBeenCalledTimes(1); // create only — no DELETE
    expect(sbx.status).toBe("running");
  });
});
