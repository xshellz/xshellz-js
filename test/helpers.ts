import type { SandboxInfo } from "../src/api.js";
import { XshellzError } from "../src/errors.js";
import type { ExecOptions, ExecResult, SandboxTransport, TransportTarget } from "../src/transport.js";

export const UUID = "0f8b2a34-1111-2222-3333-444455556666";

export function shellInfo(overrides: Partial<SandboxInfo> = {}): SandboxInfo {
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

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * In-memory data-plane fake: records exec calls, serves files from a Map.
 * `nextResults` (FIFO) wins over `nextResult` when non-empty.
 */
export class FakeTransport implements SandboxTransport {
  target: TransportTarget;
  execCalls: Array<{ command: string; options: ExecOptions }> = [];
  files = new Map<string, Buffer>();
  closed = false;
  nextResult: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  nextResults: ExecResult[] = [];

  constructor(target: TransportTarget) {
    this.target = target;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.execCalls.push({ command, options });

    return this.nextResults.shift() ?? this.nextResult;
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
