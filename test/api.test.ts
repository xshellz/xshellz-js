import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxInfo } from "../src/api.js";
import { AuthError, ApiError, QuotaError, SandboxNotRunningError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox.js";

const API_KEY = "test-pat-token";
const BASE = "https://api.staging.example/v1";

function shellInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    uuid: "0f8b2a34-1111-2222-3333-444455556666",
    name: "agent-shell",
    status: "running",
    ssh_command: "ssh -p 42001 root@shellus1.xshellz.com",
    ssh_host: "shellus1.xshellz.com",
    ssh_port: 42001,
    web_terminal_ready: true,
    trial_ends_at: null,
    always_on: true,
    trial_hours_remaining: 0,
    spawned_at: "2026-07-16T12:00:00+00:00",
    created_at: "2026-07-16T12:00:00+00:00",
    isolation: "runsc",
    gvisor: true,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  delete process.env.XSHELLZ_API_KEY;
  delete process.env.XSHELLZ_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sandbox.create", () => {
  it("POSTs the generated public key and name, and exposes the wire fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ name: "my-box" })));

    const sbx = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE, name: "my-box" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/shells/agent`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body);
    expect(body.name).toBe("my-box");
    expect(body.ssh_public_key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ /);

    expect(sbx.uuid).toBe("0f8b2a34-1111-2222-3333-444455556666");
    expect(sbx.name).toBe("my-box");
    expect(sbx.status).toBe("running");
    expect(sbx.sshHost).toBe("shellus1.xshellz.com");
    expect(sbx.sshPort).toBe(42001);
    expect(sbx.sshCommand).toBe("ssh -p 42001 root@shellus1.xshellz.com");
    expect(sbx.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(sbx.info.gvisor).toBe(true);
  });

  it("throws AuthError before any request when no API key is configured", async () => {
    await expect(Sandbox.create()).rejects.toThrowError(AuthError);
    await expect(Sandbox.create()).rejects.toThrowError(/XSHELLZ_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps 401 to AuthError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: "Unauthenticated." }));

    await expect(Sandbox.create({ apiKey: API_KEY, apiUrl: BASE })).rejects.toThrowError(AuthError);
  });

  it("maps the 403 quota guard to QuotaError with a connect() hint", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { message: "You've reached your plan's agent shell limit (1)." }),
    );

    const error = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(QuotaError);
    expect((error as QuotaError).status).toBe(403);
    expect((error as QuotaError).message).toContain("agent shell limit (1)");
    expect((error as QuotaError).message).toContain("Sandbox.connect()");
  });

  it("maps other 403 guards (entitlement, verification) to AuthError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, { message: "Your plan does not include agent shells. Upgrade to add one." }),
    );
    await expect(Sandbox.create({ apiKey: API_KEY, apiUrl: BASE })).rejects.toThrowError(AuthError);

    fetchMock.mockResolvedValueOnce(
      jsonResponse(403, {
        error: "verification_required",
        message: "Verify your account with a card (free — nothing is charged) to create a shell.",
      }),
    );
    await expect(Sandbox.create({ apiKey: API_KEY, apiUrl: BASE })).rejects.toThrowError(AuthError);
  });

  it("maps 503 (feature off / no capacity) to ApiError with status and body", async () => {
    const body = { message: "No agent shell host has free capacity right now. Please try again shortly." };
    fetchMock.mockResolvedValueOnce(jsonResponse(503, body));

    const error = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(AuthError);
    expect((error as ApiError).status).toBe(503);
    expect((error as ApiError).body).toEqual(body);
  });

  it("maps 422 validation failures to ApiError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { message: "The ssh public key field is required when ssh password is not present." }),
    );

    const error = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
  });
});

describe("config precedence", () => {
  it("uses env vars when options are omitted, options when both are set", async () => {
    process.env.XSHELLZ_API_KEY = "env-key";
    process.env.XSHELLZ_API_URL = "https://env.example/v1";
    fetchMock.mockImplementation(async () => jsonResponse(200, []));

    await Sandbox.list();
    expect(fetchMock.mock.calls[0]![0]).toBe("https://env.example/v1/shells/agent");
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer env-key");

    await Sandbox.list({ apiKey: "explicit-key", apiUrl: "https://explicit.example/v1/" });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://explicit.example/v1/shells/agent");
    expect(fetchMock.mock.calls[1]![1].headers.Authorization).toBe("Bearer explicit-key");
  });
});

describe("Sandbox.list", () => {
  it("GETs /shells/agent and returns the bare array verbatim", async () => {
    const shells = [shellInfo(), shellInfo({ uuid: "other-uuid", status: "stopped" })];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shells));

    const result = await Sandbox.list({ apiKey: API_KEY, apiUrl: BASE });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/shells/agent`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(result).toEqual(shells);
  });
});

describe("Sandbox.connect", () => {
  it("finds the box in the list and attaches with the supplied private key", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo()]));

    const sbx = await Sandbox.connect("0f8b2a34-1111-2222-3333-444455556666", {
      apiKey: API_KEY,
      apiUrl: BASE,
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n",
    });

    expect(sbx.uuid).toBe("0f8b2a34-1111-2222-3333-444455556666");
    expect(sbx.privateKey).toContain("fake");
  });

  it("throws SandboxNotRunningError when the uuid is not on the account", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));

    await expect(
      Sandbox.connect("missing-uuid", { apiKey: API_KEY, apiUrl: BASE, privateKey: "key" }),
    ).rejects.toThrowError(SandboxNotRunningError);
  });
});

describe("Sandbox.kill / start", () => {
  it("DELETEs the box, is idempotent, and close() aliases kill()", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));
    const sbx = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));
    await sbx.kill();

    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe(`${BASE}/shells/agent/${sbx.uuid}`);
    expect(init.method).toBe("DELETE");
    expect(sbx.status).toBe("deleted");

    await sbx.kill();
    await sbx.close();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("supports await using (Symbol.asyncDispose kills the box)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));

    {
      await using sbx = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE });
      expect(sbx.status).toBe("running");
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1].method).toBe("DELETE");
  });

  it("asyncDispose swallows a 404 for an already-destroyed box", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "Agent shell not found." }));

    await expect(
      (async () => {
        await using sbx = await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE });
        void sbx;
      })(),
    ).resolves.toBeUndefined();
  });

  it("POSTs /start to resume a stopped box and maps 404 to SandboxNotRunningError", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ status: "stopped" })]));
    const sbx = await Sandbox.connect("0f8b2a34-1111-2222-3333-444455556666", {
      apiKey: API_KEY,
      apiUrl: BASE,
      privateKey: "key",
    });

    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));
    await sbx.start();
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${sbx.uuid}/start`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
    expect(sbx.status).toBe("running");

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: "Stopped agent shell not found." }));
    await expect(sbx.start()).rejects.toThrowError(SandboxNotRunningError);
  });
});
