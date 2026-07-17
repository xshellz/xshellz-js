import { randomBytes } from "node:crypto";
import { XshellzError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";

/** Remote directory (inside the sandbox) where job logs and pidfiles live. */
export const JOBS_DIR = "~/.xshellz/jobs";

/** One row from {@link Sandbox.jobs}: a background job's id, pid, log and liveness. */
export interface JobInfo {
  id: string;
  /** The recorded pid, or `null` when the pidfile is missing/unreadable. */
  pid: number | null;
  /** Remote log path (`~/.xshellz/jobs/<id>.log`). */
  logPath: string;
  /** Whether the recorded pid is still alive (`kill -0` probe). */
  running: boolean;
}

/** Generate a short job id, prefixed with the sanitized name when given. */
export function makeJobId(name?: string): string {
  const suffix = randomBytes(4).toString("hex");
  if (name === undefined) {
    return suffix;
  }

  const prefix = name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");

  return prefix === "" ? suffix : `${prefix}-${suffix}`;
}

/**
 * Handle to a background process started with {@link Sandbox.spawn}. The
 * process survives the SDK disconnecting (it is `nohup`'d and detached);
 * its output is captured to {@link logPath} inside the sandbox.
 */
export class JobHandle {
  constructor(
    private readonly sandbox: Sandbox,
    /** Job id — also names the log/pid files under `~/.xshellz/jobs/`. */
    public readonly id: string,
    /** Pid of the spawned `bash -c` process inside the sandbox. */
    public readonly pid: number,
    /** Remote path of the job's combined stdout+stderr log. */
    public readonly logPath: string,
  ) {}

  /** Whether the process is still alive (`kill -0` probe over SSH). */
  async isRunning(): Promise<boolean> {
    const result = await this.sandbox.run(`kill -0 ${this.pid} 2>/dev/null`);

    return result.exitCode === 0;
  }

  /** The last `tailLines` lines of the job's log (stdout+stderr combined). */
  async logs(tailLines = 100): Promise<string> {
    const lines = Math.floor(tailLines);
    if (!Number.isInteger(lines) || lines <= 0) {
      throw new XshellzError(`tailLines must be a positive integer, got ${tailLines}`);
    }
    const result = await this.sandbox.run(`tail -n ${lines} ${this.logPath} 2>/dev/null`);

    return result.stdout;
  }

  /**
   * Stop the job: SIGTERM, then SIGKILL if it is still alive after
   * `graceMs` (default 5000). Idempotent — a dead pid is not an error.
   */
  async stop(graceMs = 5000): Promise<void> {
    const steps = Math.max(1, Math.ceil(graceMs / 500));
    await this.sandbox.run(
      `kill -TERM ${this.pid} 2>/dev/null; ` +
        `for i in $(seq 1 ${steps}); do kill -0 ${this.pid} 2>/dev/null || exit 0; sleep 0.5; done; ` +
        `kill -KILL ${this.pid} 2>/dev/null; true`,
    );
  }
}
