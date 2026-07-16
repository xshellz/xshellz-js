import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxInfo } from "../src/api.js";
import { SandboxNotRunningError, XshellzError } from "../src/errors.js";
import { Sandbox, buildShellCommand } from "../src/sandbox.js";
import type { ExecOptions, ExecResult, SandboxTransport, TransportTarget } from "../src/transport.js";

const API_KEY = "test-pat-token";
const BASE = "https://api.staging.example/v1";
const UUID = "0f8b2a34-1111-2222-3333-444455556666";

function shellInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
  return {
    uuid: UUID,
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

class FakeTransport implements SandboxTransport {
  target: TransportTarget;
  execCalls: Array<{ command: string; options: ExecOptions }> = [];
  files = new Map<string, Buffer>();
  closed = false;
  nextResult: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  streamChunks: Array<{ stream: "stdout" | "stderr"; data: string }> = [];

  constructor(target: TransportTarget) {
    this.target = target;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.execCalls.push({ command, options });
    for (const chunk of this.streamChunks) {
      if (chunk.stream === "stdout") {
        options.onStdout?.(chunk.data);
      } else {
        options.onStderr?.(chunk.data);
      }
    }

    return this.nextResult;
  }

  async readFile(path: string): Promise<Buffer> {
    const data = this.files.get(path);
    if (data === undefined) {
      throw new XshellzError(`no such file: ${path}`);
    }

    return data;
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    this.files.set(path, data);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const fetchMock = vi.fn();
let transports: FakeTransport[];

function transportFactory(target: TransportTarget): FakeTransport {
  const transport = new FakeTransport(target);
  transports.push(transport);

  return transport;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function createSandbox(info: SandboxInfo = shellInfo()): Promise<Sandbox> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, info));

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

describe("buildShellCommand", () => {
  it("passes a bare command through untouched", () => {
    expect(buildShellCommand("echo hi")).toBe("echo hi");
  });

  it("prefixes cwd and env exports with safe single-quoting", () => {
    expect(buildShellCommand("echo hi", { cwd: "/tmp/work dir", env: { FOO: "bar", MSG: "it's fine" } })).toBe(
      `export FOO='bar'; export MSG='it'\\''s fine'; cd '/tmp/work dir' && echo hi`,
    );
  });

  it("rejects invalid environment variable names", () => {
    expect(() => buildShellCommand("true", { env: { "BAD NAME": "x" } })).toThrowError(XshellzError);
    expect(() => buildShellCommand("true", { env: { "FOO=BAR": "x" } })).toThrowError(XshellzError);
  });
});

describe("Sandbox.run", () => {
  it("connects the transport to root@ssh_host:ssh_port with the generated key", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");

    expect(transports).toHaveLength(1);
    const target = transports[0]!.target;
    expect(target.host).toBe("shellus1.xshellz.com");
    expect(target.port).toBe(42001);
    expect(target.username).toBe("root");
    expect(target.privateKey).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("returns stdout/stderr/exitCode and does NOT throw on non-zero exit", async () => {
    const sbx = await createSandbox();
    await sbx.run("true"); // materialize the lazy transport
    transports[0]!.nextResult = { stdout: "out", stderr: "err", exitCode: 3 };

    const result = await sbx.run("exit 3");

    expect(result).toEqual({ stdout: "out", stderr: "err", exitCode: 3 });
  });

  it("wraps cwd/env into the executed command and forwards timeout + stream callbacks", async () => {
    const sbx = await createSandbox();
    await sbx.run("true"); // materialize transport
    const transport = transports[0]!;
    transport.streamChunks = [
      { stream: "stdout", data: "line1\n" },
      { stream: "stderr", data: "warn\n" },
    ];

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    await sbx.run("node script.js", {
      cwd: "/srv/app",
      env: { NODE_ENV: "test" },
      timeoutMs: 5000,
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    const call = transport.execCalls[1]!;
    expect(call.command).toBe(`export NODE_ENV='test'; cd '/srv/app' && node script.js`);
    expect(call.options.timeoutMs).toBe(5000);
    expect(stdoutChunks).toEqual(["line1\n"]);
    expect(stderrChunks).toEqual(["warn\n"]);
  });

  it("throws SandboxNotRunningError for a stopped box and after kill()", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, [shellInfo({ status: "stopped" })]));
    const stopped = await Sandbox.connect(UUID, { apiKey: API_KEY, apiUrl: BASE, privateKey: "k", transportFactory });
    await expect(stopped.run("true")).rejects.toThrowError(SandboxNotRunningError);
    expect(transports).toHaveLength(0); // never dialled — rejected before connecting

    const sbx = await createSandbox();
    await sbx.run("true");
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { deleted: true }));
    await sbx.kill();

    expect(transports[0]!.closed).toBe(true);
    await expect(sbx.run("true")).rejects.toThrowError(SandboxNotRunningError);
    await expect(sbx.readFile("/tmp/x")).rejects.toThrowError(SandboxNotRunningError);
  });
});

describe("Sandbox files", () => {
  it("writeFile/readFile round-trip Buffers and strings through the transport", async () => {
    const sbx = await createSandbox();

    await sbx.writeFile("/tmp/a.bin", Buffer.from([1, 2, 3]));
    expect(await sbx.readFile("/tmp/a.bin")).toEqual(Buffer.from([1, 2, 3]));

    await sbx.writeFile("/tmp/hello.txt", "hello");
    expect((await sbx.readFile("/tmp/hello.txt")).toString()).toBe("hello");
  });

  it("upload/download bridge local files and the sandbox", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xshellz-sdk-test-"));
    try {
      const localIn = join(dir, "in.txt");
      const localOut = join(dir, "out.txt");
      await writeFile(localIn, "local content");

      const sbx = await createSandbox();
      await sbx.upload(localIn, "/tmp/remote.txt");
      expect((await sbx.readFile("/tmp/remote.txt")).toString()).toBe("local content");

      await sbx.download("/tmp/remote.txt", localOut);
      expect((await readFile(localOut)).toString()).toBe("local content");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Sandbox.start", () => {
  it("resets the transport so the next run reconnects with fresh endpoint info", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    const first = transports[0]!;

    fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo({ spawned_at: "2026-07-16T13:00:00+00:00" })));
    await sbx.start();

    expect(first.closed).toBe(true);
    await sbx.run("true");
    expect(transports).toHaveLength(2);
  });
});
