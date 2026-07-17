import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XshellzError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox.js";
import type { TransportTarget } from "../src/transport.js";
import { FakeTransport, jsonResponse, shellInfo } from "./helpers.js";

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

describe("Sandbox.spawn", () => {
  it("detaches the command with nohup, logs to ~/.xshellz/jobs, and captures the pid", async () => {
    const sbx = await createSandbox();
    await sbx.run("true"); // materialize the lazy transport
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "12345\n", stderr: "", exitCode: 0 });

    const job = await sbx.spawn("sleep 60 && echo done", "worker");

    const call = transport.execCalls.at(-1)!;
    expect(call.command).toContain("mkdir -p ~/.xshellz/jobs && nohup bash -c 'sleep 60 && echo done'");
    expect(call.command).toContain(`> ~/.xshellz/jobs/${job.id}.log 2>&1 < /dev/null &`);
    expect(call.command).toContain(`echo $pid > ~/.xshellz/jobs/${job.id}.pid; echo $pid`);

    expect(job.pid).toBe(12345);
    expect(job.id).toMatch(/^worker-[0-9a-f]{8}$/);
    expect(job.logPath).toBe(`~/.xshellz/jobs/${job.id}.log`);
  });

  it("uses a bare random id when no name is given and shell-quotes the command", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "7\n", stderr: "", exitCode: 0 });

    const job = await sbx.spawn(`echo 'it'"'"'s fine'`);

    expect(job.id).toMatch(/^[0-9a-f]{8}$/);
    expect(transport.execCalls.at(-1)!.command).toContain("nohup bash -c ");
  });

  it("throws XshellzError when no pid comes back", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    transports[0]!.nextResults.push({ stdout: "", stderr: "mkdir: permission denied", exitCode: 1 });

    await expect(sbx.spawn("true")).rejects.toThrowError(XshellzError);
  });
});

describe("JobHandle", () => {
  async function spawnJob() {
    const sbx = await createSandbox();
    await sbx.run("true");
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "4242\n", stderr: "", exitCode: 0 });
    const job = await sbx.spawn("long-task", "task");

    return { sbx, transport, job };
  }

  it("isRunning() probes with kill -0", async () => {
    const { transport, job } = await spawnJob();

    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });
    expect(await job.isRunning()).toBe(true);
    expect(transport.execCalls.at(-1)!.command).toBe("kill -0 4242 2>/dev/null");

    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 1 });
    expect(await job.isRunning()).toBe(false);
  });

  it("logs() tails the job's log file", async () => {
    const { transport, job } = await spawnJob();
    transport.nextResults.push({ stdout: "line1\nline2\n", stderr: "", exitCode: 0 });

    expect(await job.logs()).toBe("line1\nline2\n");
    expect(transport.execCalls.at(-1)!.command).toBe(`tail -n 100 ${job.logPath} 2>/dev/null`);

    transport.nextResults.push({ stdout: "line2\n", stderr: "", exitCode: 0 });
    await job.logs(1);
    expect(transport.execCalls.at(-1)!.command).toBe(`tail -n 1 ${job.logPath} 2>/dev/null`);

    await expect(job.logs(0)).rejects.toThrowError(XshellzError);
  });

  it("stop() sends SIGTERM with a SIGKILL fallback after the grace period", async () => {
    const { transport, job } = await spawnJob();
    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });

    await job.stop(1000);

    const command = transport.execCalls.at(-1)!.command;
    expect(command).toContain("kill -TERM 4242 2>/dev/null");
    expect(command).toContain("seq 1 2"); // 1000ms grace = 2 x 0.5s probes
    expect(command).toContain("kill -0 4242 2>/dev/null || exit 0");
    expect(command).toContain("kill -KILL 4242 2>/dev/null");
  });
});

describe("Sandbox.jobs", () => {
  it("lists job log files with pid and liveness", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "worker-abc12345\t4242\t1\nold-def67890\t-\t0\n", stderr: "", exitCode: 0 });

    const jobs = await sbx.jobs();

    expect(jobs).toEqual([
      { id: "worker-abc12345", pid: 4242, logPath: "~/.xshellz/jobs/worker-abc12345.log", running: true },
      { id: "old-def67890", pid: null, logPath: "~/.xshellz/jobs/old-def67890.log", running: false },
    ]);
    expect(transport.execCalls.at(-1)!.command).toContain('kill -0 "$pid"');
  });

  it("returns an empty list when the jobs directory does not exist", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    transports[0]!.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });

    expect(await sbx.jobs()).toEqual([]);
  });
});
