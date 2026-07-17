import { randomBytes } from "node:crypto";
import { readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import { ApiClient, type SandboxInfo, type SandboxProcs, type SandboxStats } from "./api.js";
import { resolveConfig, type ClientOptions } from "./config.js";
import { MissingKeyError, SandboxNotRunningError, UnsupportedLanguageError, XshellzError } from "./errors.js";
import { JobHandle, JOBS_DIR, makeJobId, type JobInfo } from "./jobs.js";
import { generateEd25519KeyPair } from "./keys.js";
import { Keystore } from "./keystore.js";
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

export interface GetOrCreateOptions extends CreateSandboxOptions {
  /**
   * Private key for an existing box with this name. Wins over the keystore
   * lookup when both are available.
   */
  privateKey?: string;
  /**
   * Where private keys are persisted/loaded: a {@link Keystore}, a directory
   * path, or `false` to disable persistence entirely (then an existing box
   * needs an explicit `privateKey`, and a newly created box's key lives only
   * in `sbx.privateKey`). Default: `~/.xshellz/keys/`.
   */
  keystore?: Keystore | string | false;
}

/** Languages `sbx.runCode()` knows how to execute, with interpreter + file extension. */
export const RUN_CODE_LANGUAGES = {
  python: { interpreter: "python3", extension: "py" },
  node: { interpreter: "node", extension: "js" },
  bash: { interpreter: "bash", extension: "sh" },
  ruby: { interpreter: "ruby", extension: "rb" },
  php: { interpreter: "php", extension: "php" },
} as const;

export type RunCodeLanguage = keyof typeof RUN_CODE_LANGUAGES;

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
  #detached = false;

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
   * Idempotent "permanent mode": attach to the sandbox named `name` if it
   * exists, otherwise create it. Keys are persisted in a local keystore
   * (default `~/.xshellz/keys/`, one 0600 file per name) so a later process
   * can re-attach without saving `sbx.privateKey` manually.
   *
   * - Not found → create (persisting the generated key when the keystore is
   *   enabled).
   * - Found → attach with the explicit `privateKey` option if given, else the
   *   keystore key; a stopped box is `start()`ed first. Throws
   *   {@link MissingKeyError} when no key can be found.
   *
   * The returned box is **detached**: it is a permanent box, so `close()` and
   * `await using` disposal keep it alive — only an explicit {@link kill} (or
   * {@link Keystore.delete}) destroys it.
   */
  static async getOrCreate(name: string, options: GetOrCreateOptions = {}): Promise<Sandbox> {
    const api = new ApiClient(resolveConfig(options));
    const factory = options.transportFactory ?? defaultTransportFactory;
    const store =
      options.keystore === false
        ? null
        : options.keystore instanceof Keystore
          ? options.keystore
          : new Keystore(options.keystore);

    const shells = await api.request<SandboxInfo[]>("GET", "/shells/agent");
    const existing = shells.find((shell) => shell.name === name);

    if (existing === undefined) {
      const keys = generateEd25519KeyPair();
      const info = await api.request<SandboxInfo>("POST", "/shells/agent", {
        name,
        ssh_public_key: keys.publicKey,
      });
      if (store !== null) {
        await store.save(name, keys.privateKey);
      }

      const created = new Sandbox(api, info, keys.privateKey, factory);
      created.#detached = true;

      return created;
    }

    const privateKey = options.privateKey ?? (store !== null ? await store.load(name) : null);
    if (privateKey === null || privateKey === undefined) {
      const expected =
        store !== null
          ? `a key file at ${store.keyPath(name)}`
          : `an explicit { privateKey } option (keystore disabled)`;
      throw new MissingKeyError(
        `Sandbox "${name}" already exists but no private key was found — expected ${expected}. ` +
          `Pass { privateKey }, or kill() the box and let getOrCreate() recreate it with a fresh key.`,
      );
    }

    const sandbox = new Sandbox(api, existing, privateKey, factory);
    sandbox.#detached = true;
    if (existing.status === "stopped") {
      await sandbox.start();
    }

    return sandbox;
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

  /**
   * The account's saved `xshellz.box` manifest (provisioning template), or
   * `null` when none is saved. The manifest is applied when a NEW box is
   * created — it is seeded into `~/xshellz.box` so destroy+recreate reproduces
   * your package environment (preinstalled deps etc.).
   */
  static async getBoxfile(options: ClientOptions = {}): Promise<string | null> {
    const api = new ApiClient(resolveConfig(options));
    const response = await api.request<{ manifest: string | null }>("GET", "/shells/agent/boxfile");

    return response.manifest;
  }

  /**
   * Save (or clear, with `null`/blank) the account's `xshellz.box` manifest.
   * Applies to the NEXT box created, not to already-running boxes. Returns
   * the stored manifest (normalized server-side; `null` when cleared).
   */
  static async setBoxfile(manifest: string | null, options: ClientOptions = {}): Promise<string | null> {
    const api = new ApiClient(resolveConfig(options));
    const response = await api.request<{ manifest: string | null }>("PUT", "/shells/agent/boxfile", { manifest });

    return response.manifest;
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
   * Start a background process that keeps running after this call returns
   * (and after your program disconnects). Output goes to a log file inside
   * the box (`~/.xshellz/jobs/<id>.log`); use the returned {@link JobHandle}
   * to check liveness, read logs, or stop it.
   */
  async spawn(command: string, name?: string): Promise<JobHandle> {
    this.#assertUsable();

    const id = makeJobId(name);
    const logPath = `${JOBS_DIR}/${id}.log`;
    const pidPath = `${JOBS_DIR}/${id}.pid`;
    const script =
      `mkdir -p ${JOBS_DIR} && ` +
      `nohup bash -c ${shellQuote(command)} > ${logPath} 2>&1 < /dev/null & ` +
      `pid=$!; echo $pid > ${pidPath}; echo $pid`;

    const result = await this.run(script);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new XshellzError(
        `spawn failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
      );
    }

    return new JobHandle(this, id, pid, logPath);
  }

  /** List background jobs previously started with {@link spawn}: log files + liveness. */
  async jobs(): Promise<JobInfo[]> {
    this.#assertUsable();

    const script =
      `cd ${JOBS_DIR} 2>/dev/null || exit 0; ` +
      `for f in *.log; do [ -e "$f" ] || continue; id="\${f%.log}"; ` +
      `pid="$(cat "$id.pid" 2>/dev/null || true)"; ` +
      `if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then run=1; else run=0; fi; ` +
      `printf '%s\\t%s\\t%s\\n' "$id" "\${pid:--}" "$run"; done`;

    const result = await this.run(script);

    return result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => {
        const [id = "", pidField = "-", runField = "0"] = line.split("\t");
        const pid = Number.parseInt(pidField, 10);

        return {
          id,
          pid: Number.isInteger(pid) && pid > 0 ? pid : null,
          logPath: `${JOBS_DIR}/${id}.log`,
          running: runField.trim() === "1",
        };
      });
  }

  /**
   * Run a snippet of code in the sandbox: the code is written to a temp file
   * via SFTP, executed with the language's interpreter, and the temp file is
   * always deleted. Supported languages: `python` (python3), `node`, `bash`,
   * `ruby`, `php`. Returns the same shape as {@link run}; throws
   * {@link UnsupportedLanguageError} for anything else.
   */
  async runCode(language: string, code: string, options: RunOptions = {}): Promise<CommandResult> {
    const spec = Object.hasOwn(RUN_CODE_LANGUAGES, language)
      ? RUN_CODE_LANGUAGES[language as RunCodeLanguage]
      : undefined;
    if (spec === undefined) {
      throw new UnsupportedLanguageError(
        `Unsupported language ${JSON.stringify(language)}. Supported: ${Object.keys(RUN_CODE_LANGUAGES).join(", ")}.`,
      );
    }

    const path = `/tmp/xshellz-run-${randomBytes(6).toString("hex")}.${spec.extension}`;
    await this.writeFile(path, code);
    try {
      return await this.run(`${spec.interpreter} ${path}`, options);
    } finally {
      await this.run(`rm -f ${path}`).catch(() => undefined);
    }
  }

  /**
   * Live resource usage (memory, CPU, pids, disk, network, block IO) plus the
   * plan's ceilings. Wire shape verbatim from the control plane (snake_case).
   */
  async stats(): Promise<SandboxStats> {
    this.#assertNotKilled();

    return await this.#api.request<SandboxStats>("GET", `/shells/agent/${this.uuid}/stats`);
  }

  /** Top processes, active session count, detected agents, and disk usage. */
  async procs(): Promise<SandboxProcs> {
    this.#assertNotKilled();

    return await this.#api.request<SandboxProcs>("GET", `/shells/agent/${this.uuid}/procs`);
  }

  /**
   * Reboot the box (re-runs the entrypoint; `/home` is preserved). The SSH
   * connection is dropped and re-established on the next operation.
   */
  async restart(): Promise<void> {
    this.#assertNotKilled();

    await this.#closeTransport();
    this.#info = await this.#api.request<SandboxInfo>("POST", `/shells/agent/${this.uuid}/restart`);
  }

  /**
   * Mint a fresh signed web-terminal URL for this box — open it in a browser
   * for an interactive shell. The link is short-lived (HMAC token, ~1 hour
   * TTL); call again for a fresh one rather than storing it.
   */
  async terminalUrl(): Promise<string> {
    this.#assertNotKilled();

    const response = await this.#api.request<{ url: string }>("GET", `/shells/agent/${this.uuid}/terminal`);

    return response.url;
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

  /**
   * Keep the box alive when {@link close} or `await using` disposal runs.
   * `Sandbox.getOrCreate()` boxes are detached automatically (they are
   * permanent) — call this on a `create()` box you want to outlive its scope.
   */
  detach(): void {
    this.#detached = true;
  }

  /** Whether disposal keeps the box alive ({@link detach}). */
  get detached(): boolean {
    return this.#detached;
  }

  /**
   * Dispose of the sandbox: close the SSH connection and, for a throwaway box,
   * {@link kill} it. A **detached** box (any `getOrCreate()` box, or after
   * {@link detach}) is kept alive — only an explicit {@link kill} destroys it.
   */
  async close(): Promise<void> {
    if (this.#detached) {
      await this.#closeTransport();

      return;
    }
    await this.kill();
  }

  /**
   * `await using sbx = await Sandbox.create()` kills the box on scope exit.
   * A detached box (e.g. from `getOrCreate()`) is kept alive instead.
   */
  async [asyncDisposeSymbol](): Promise<void> {
    try {
      await this.close();
    } catch (error) {
      if (!(error instanceof SandboxNotRunningError)) {
        throw error;
      }
    }
  }

  #assertNotKilled(): void {
    if (this.#killed) {
      throw new SandboxNotRunningError(`Sandbox ${this.uuid} was killed.`);
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
