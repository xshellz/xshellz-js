import { readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import { ApiClient, type SandboxInfo } from "./api.js";
import { resolveConfig, type ClientOptions } from "./config.js";
import { SandboxNotRunningError, XshellzError } from "./errors.js";
import { generateEd25519KeyPair } from "./keys.js";
import {
  defaultTransportFactory,
  type ExecOptions,
  type SandboxTransport,
  type TransportFactory,
} from "./transport.js";

const asyncDisposeSymbol: typeof Symbol.asyncDispose =
  (Symbol as { asyncDispose?: symbol }).asyncDispose !== undefined
    ? Symbol.asyncDispose
    : (Symbol.for("Symbol.asyncDispose") as typeof Symbol.asyncDispose);

export interface CreateSandboxOptions extends ClientOptions {
  /** Human-readable box name (defaults server-side to "agent-shell"). */
  name?: string;
  /** Advanced: substitute the data-plane transport (used by tests; v1 HTTP transport). */
  transportFactory?: TransportFactory;
}

export interface ConnectSandboxOptions extends ClientOptions {
  /** The OpenSSH private key that matches the public key the box was created with. */
  privateKey: string;
  /** Advanced: substitute the data-plane transport. */
  transportFactory?: TransportFactory;
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Extra environment variables, exported before the command runs. */
  env?: Record<string, string>;
  /** Kill the command and throw after this many milliseconds. */
  timeoutMs?: number;
  /** Called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** The command's exit code. A non-zero exit does NOT throw — it is data. */
  exitCode: number;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a command with env exports and a cwd change, for one `sh -c` execution. */
export function buildShellCommand(command: string, options: Pick<RunOptions, "cwd" | "env"> = {}): string {
  const parts: string[] = [];

  if (options.env !== undefined) {
    for (const [key, value] of Object.entries(options.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new XshellzError(`Invalid environment variable name: ${JSON.stringify(key)}`);
      }
      parts.push(`export ${key}=${shellQuote(value)};`);
    }
  }

  if (options.cwd !== undefined) {
    parts.push(`cd ${shellQuote(options.cwd)} &&`);
  }

  parts.push(command);

  return parts.join(" ");
}

/**
 * A throwaway, gVisor-isolated Linux box on the xShellz fleet.
 *
 * Control plane: api.xshellz.com (create / list / start / kill).
 * Data plane: direct SSH to the box as root (fake-root inside a user
 * namespace, inside gVisor) — commands never route through the API.
 *
 * ```ts
 * await using sbx = await Sandbox.create();
 * const r = await sbx.run("echo hello");
 * ```
 */
export class Sandbox {
  #api: ApiClient;
  #info: SandboxInfo;
  #privateKey: string;
  #transportFactory: TransportFactory;
  #transport: SandboxTransport | null = null;
  #killed = false;

  private constructor(api: ApiClient, info: SandboxInfo, privateKey: string, transportFactory: TransportFactory) {
    this.#api = api;
    this.#info = info;
    this.#privateKey = privateKey;
    this.#transportFactory = transportFactory;
  }

  /**
   * Spawn a new sandbox. Generates an in-memory ed25519 keypair, sends the
   * public half to the control plane, and returns once the box is RUNNING
   * (the spawn is synchronous server-side — typically a few seconds).
   */
  static async create(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    const api = new ApiClient(resolveConfig(options));
    const keys = generateEd25519KeyPair();

    const body: Record<string, string> = { ssh_public_key: keys.publicKey };
    if (options.name !== undefined) {
      body.name = options.name;
    }

    const info = await api.request<SandboxInfo>("POST", "/shells/agent", body);

    return new Sandbox(api, info, keys.privateKey, options.transportFactory ?? defaultTransportFactory);
  }

  /**
   * Attach to an existing sandbox by uuid, using the private key saved from
   * the original `create()` (see {@link Sandbox.privateKey}).
   */
  static async connect(uuid: string, options: ConnectSandboxOptions): Promise<Sandbox> {
    const api = new ApiClient(resolveConfig(options));
    const shells = await api.request<SandboxInfo[]>("GET", "/shells/agent");
    const info = shells.find((shell) => shell.uuid === uuid);

    if (info === undefined) {
      throw new SandboxNotRunningError(`Sandbox ${uuid} not found on this account.`);
    }

    return new Sandbox(api, info, options.privateKey, options.transportFactory ?? defaultTransportFactory);
  }

  /** List the account's active sandboxes (wire shape, snake_case, verbatim). */
  static async list(options: ClientOptions = {}): Promise<SandboxInfo[]> {
    const api = new ApiClient(resolveConfig(options));

    return await api.request<SandboxInfo[]>("GET", "/shells/agent");
  }

  get uuid(): string {
    return this.#info.uuid;
  }

  get name(): string {
    return this.#info.name;
  }

  get status(): string {
    return this.#info.status;
  }

  get sshHost(): string | null {
    return this.#info.ssh_host;
  }

  get sshPort(): number | null {
    return this.#info.ssh_port;
  }

  get sshCommand(): string | null {
    return this.#info.ssh_command;
  }

  /** The full wire object from the control plane (snake_case). */
  get info(): SandboxInfo {
    return this.#info;
  }

  /**
   * The generated OpenSSH private key. Persist it if you want to
   * `Sandbox.connect()` to this box from another process later.
   */
  get privateKey(): string {
    return this.#privateKey;
  }

  /**
   * Run a command in the sandbox over SSH. Resolves with stdout, stderr and
   * the exit code; a non-zero exit does NOT throw. Throws
   * {@link SandboxNotRunningError} if the box is stopped or was killed, and
   * {@link XshellzError} on SSH failure or `timeoutMs` expiry.
   */
  async run(command: string, options: RunOptions = {}): Promise<CommandResult> {
    this.#assertUsable();

    const execOptions: ExecOptions = {};
    if (options.timeoutMs !== undefined) {
      execOptions.timeoutMs = options.timeoutMs;
    }
    if (options.onStdout !== undefined) {
      execOptions.onStdout = options.onStdout;
    }
    if (options.onStderr !== undefined) {
      execOptions.onStderr = options.onStderr;
    }

    return await this.#getTransport().exec(buildShellCommand(command, options), execOptions);
  }

  /** Write a file inside the sandbox via SFTP. */
  async writeFile(path: string, data: Buffer | Uint8Array | string): Promise<void> {
    this.#assertUsable();
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    await this.#getTransport().writeFile(path, bytes);
  }

  /** Read a file from the sandbox via SFTP. */
  async readFile(path: string): Promise<Buffer> {
    this.#assertUsable();

    return await this.#getTransport().readFile(path);
  }

  /** Upload a local file into the sandbox. */
  async upload(localPath: string, remotePath: string): Promise<void> {
    const data = await readLocalFile(localPath);
    await this.writeFile(remotePath, data);
  }

  /** Download a file from the sandbox to a local path. */
  async download(remotePath: string, localPath: string): Promise<void> {
    const data = await this.readFile(remotePath);
    await writeLocalFile(localPath, data);
  }

  /**
   * Resume a stopped box (e.g. after the free tier's 30-minute idle stop).
   * /home is preserved, so the key from `create()` still works.
   */
  async start(): Promise<void> {
    if (this.#killed) {
      throw new SandboxNotRunningError(`Sandbox ${this.uuid} was killed.`);
    }

    await this.#closeTransport();
    this.#info = await this.#api.request<SandboxInfo>("POST", `/shells/agent/${this.uuid}/start`);
  }

  /** Destroy the sandbox (DELETE on the control plane). Idempotent. */
  async kill(): Promise<void> {
    if (this.#killed) {
      return;
    }

    await this.#closeTransport();
    await this.#api.request<{ deleted: boolean }>("DELETE", `/shells/agent/${this.uuid}`);
    this.#killed = true;
    this.#info = { ...this.#info, status: "deleted", ssh_host: null, ssh_port: null, ssh_command: null };
  }

  /** Alias for {@link kill}. */
  async close(): Promise<void> {
    await this.kill();
  }

  /** `await using sbx = await Sandbox.create()` kills the box on scope exit. */
  async [asyncDisposeSymbol](): Promise<void> {
    try {
      await this.kill();
    } catch (error) {
      if (!(error instanceof SandboxNotRunningError)) {
        throw error;
      }
    }
  }

  #assertUsable(): void {
    if (this.#killed) {
      throw new SandboxNotRunningError(`Sandbox ${this.uuid} was killed.`);
    }
    if (this.#info.status !== "running") {
      throw new SandboxNotRunningError(
        `Sandbox ${this.uuid} is ${this.#info.status}, not running. Call start() to resume a stopped box.`,
      );
    }
  }

  #getTransport(): SandboxTransport {
    if (this.#transport === null) {
      const host = this.#info.ssh_host;
      const port = this.#info.ssh_port;
      if (host === null || host === "" || port === null) {
        throw new SandboxNotRunningError(`Sandbox ${this.uuid} has no SSH endpoint yet.`);
      }
      this.#transport = this.#transportFactory({ host, port, username: "root", privateKey: this.#privateKey });
    }

    return this.#transport;
  }

  async #closeTransport(): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    if (transport !== null) {
      await transport.close();
    }
  }
}
