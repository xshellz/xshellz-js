import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxProcs, SandboxStats } from "../src/api.js";
import { SandboxNotRunningError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox.js";
import type { TransportTarget } from "../src/transport.js";
import { FakeTransport, jsonResponse, shellInfo, UUID } from "./helpers.js";

const API_KEY = "test-pat-token";
const BASE = "https://api.staging.example/v1";

const fetchMock = vi.fn();
let transports: FakeTransport[];

function transportFactory(target: TransportTarget): FakeTransport {
  const transport = new FakeTransport(target);
  transports.push(transport);

  return transport;
}

async function createSandbox(): Promise<Sandbox> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));

  return await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE, transportFactory });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  transports = [];
  delete process.env.XSHELLZ_API_KEY;
  delete process.env.XSHELLZ_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const STATS: SandboxStats = {
  mem_used_mb: 213,
  mem_limit_mb: 2048,
  mem_allowed_mb: 2048,
  cpu_percent: 12.5,
  cpu_allowed_vcpus: 1,
  cpu_throttled_periods: 0,
  pids_current: 17,
  pids_allowed: 256,
  disk_used_mb: 900,
  disk_allowed_mb: 5120,
  net_rx_mb: 10.2,
  net_tx_mb: 1.4,
  blk_read_mb: 55,
  blk_write_mb: 20,
};

const PROCS: SandboxProcs = {
  procs: [{ pid: 1, comm: "bash", cpu: 0.1, mem: 0.5 }],
  sessions: 2,
  agents: ["claude"],
  disk_used_mb: 900,
  disk_allowed_mb: 5120,
};

describe("Sandbox.stats / procs", () => {
  it("GETs /stats and returns the wire shape verbatim", async () => {
    const sbx = await createSandbox();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, STATS));

    expect(await sbx.stats()).toEqual(STATS);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${UUID}/stats`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("GET");
  });

  it("GETs /procs and returns the wire shape verbatim", async () => {
    const sbx = await createSandbox();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, PROCS));

    expect(await sbx.procs()).toEqual(PROCS);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${UUID}/procs`);
  });

  it("throws SandboxNotRunningError on a killed handle", async () => {
    const sbx = await createSandbox();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));
    await sbx.kill();

    await expect(sbx.stats()).rejects.toThrowError(SandboxNotRunningError);
    await expect(sbx.procs()).rejects.toThrowError(SandboxNotRunningError);
    await expect(sbx.restart()).rejects.toThrowError(SandboxNotRunningError);
    await expect(sbx.terminalUrl()).rejects.toThrowError(SandboxNotRunningError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // create + delete only
  });
});

describe("Sandbox.restart", () => {
  it("POSTs /restart, refreshes info, and drops the SSH connection", async () => {
    const sbx = await createSandbox();
    await sbx.run("true"); // materialize the transport
    const first = transports[0]!;

    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ spawned_at: "2026-07-17T09:00:00+00:00" })));
    await sbx.restart();

    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${UUID}/restart`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("POST");
    expect(first.closed).toBe(true);
    expect(sbx.info.spawned_at).toBe("2026-07-17T09:00:00+00:00");

    await sbx.run("true");
    expect(transports).toHaveLength(2); // reconnected
  });
});

describe("Sandbox.terminalUrl", () => {
  it("GETs /terminal and returns the url field", async () => {
    const sbx = await createSandbox();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { url: "https://shellus1.xshellz.com/term/abc?token=1234.sig" }),
    );

    expect(await sbx.terminalUrl()).toBe("https://shellus1.xshellz.com/term/abc?token=1234.sig");
    expect(fetchMock.mock.calls[1]![0]).toBe(`${BASE}/shells/agent/${UUID}/terminal`);
    expect(fetchMock.mock.calls[1]![1].method).toBe("GET");
  });
});

describe("Sandbox.getBoxfile / setBoxfile", () => {
  it("GETs the account boxfile manifest", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { manifest: "apt: ripgrep\npip: requests" }));

    expect(await Sandbox.getBoxfile({ apiKey: API_KEY, apiUrl: BASE })).toBe("apt: ripgrep\npip: requests");
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE}/shells/agent/boxfile`);
    expect(fetchMock.mock.calls[0]![1].method).toBe("GET");
  });

  it("returns null when no manifest is saved", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { manifest: null }));

    expect(await Sandbox.getBoxfile({ apiKey: API_KEY, apiUrl: BASE })).toBeNull();
  });

  it("PUTs the manifest and returns the normalized copy", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { manifest: "apt: jq" }));

    expect(await Sandbox.setBoxfile("apt: jq\n", { apiKey: API_KEY, apiUrl: BASE })).toBe("apt: jq");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/shells/agent/boxfile`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ manifest: "apt: jq\n" });
  });

  it("clears the manifest with null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { manifest: null }));

    expect(await Sandbox.setBoxfile(null, { apiKey: API_KEY, apiUrl: BASE })).toBeNull();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ manifest: null });
  });
});
