# xshellz JS/TS SDK — API reference

Everything the SDK exports, with parameters, return shapes, and the errors each
call can raise. All symbols are importable from the top-level package:

```ts
import {
  Sandbox, Keystore, JobHandle,
  Ssh2Transport, generateEd25519KeyPair, buildShellCommand, sanitizeSandboxName,
  RUN_CODE_LANGUAGES, DEFAULT_API_URL, DEFAULT_KEYSTORE_DIR, JOBS_DIR,
  XshellzError, ApiError, AuthError, QuotaError, SandboxNotRunningError,
  MissingKeyError, UnsupportedLanguageError,
} from "xshellz";
import type {
  ClientOptions, CommandResult, RunOptions, RunCodeLanguage,
  CreateSandboxOptions, GetOrCreateOptions, ConnectSandboxOptions,
  SandboxInfo, SandboxStats, SandboxProcs, SandboxProcess, JobInfo,
  Ed25519KeyPair, SandboxTransport, TransportFactory, TransportTarget,
  ExecOptions, ExecResult,
} from "xshellz";
```

## Shared config (`ClientOptions`)

Every constructor / static method that talks to the control plane accepts these
(precedence: explicit option > environment variable > default):

| Option      | Env var           | Default                      |
|-------------|-------------------|------------------------------|
| `apiKey`    | `XSHELLZ_API_KEY` | — (required; throws `AuthError` if unset) |
| `apiUrl`    | `XSHELLZ_API_URL` | `https://api.xshellz.com/v1` |
| `timeoutMs` | —                 | `60000` (control-plane HTTP requests) |

---

## class `Sandbox`

A remote sandbox: control plane over HTTPS (`fetch`), data plane over SSH
(`ssh2`). All methods are async. `await using` (or `close()`) destroys a
throwaway `create()` box on scope exit; a `getOrCreate()` box is **detached**
and survives disposal — only `kill()` destroys it.

### Constructors (static)

#### `Sandbox.create(options?: CreateSandboxOptions): Promise<Sandbox>`

Spawn a new box and resolve once it is RUNNING (spawn is synchronous server-side
— typically a few seconds). Generates a fresh in-memory ed25519 keypair; only
the public half is sent to the server (`ssh_public_key`).

- `options.name?` — optional display name (used by `getOrCreate` matching).
- `options.transportFactory?` — substitute the data-plane transport (tests / v1 HTTP).
- Plus all `ClientOptions`.
- Throws `AuthError` (bad key/scopes/account gates), `QuotaError` (plan sandbox
  limit / no entitlement), `ApiError` (429 throttle, 5xx, …).

#### `Sandbox.getOrCreate(name: string, options?: GetOrCreateOptions): Promise<Sandbox>`

"Permanent mode": return the box named `name`, creating it if absent. On create,
the generated private key is persisted to the keystore; on attach, the key is
loaded (explicit `privateKey` wins, then the keystore). A `stopped` box is
`start()`ed before returning. The returned box is **detached**.

- `options.privateKey?` — OpenSSH private key for an existing box; wins over the keystore.
- `options.keystore?` — a `Keystore`, a directory path, or `false` to disable
  persistence (then attaching to an existing box requires `privateKey`).
  Default: `~/.xshellz/keys/`.
- Plus `CreateSandboxOptions`.
- Throws `MissingKeyError` (box exists, no key found — the message says where a
  key was expected), plus everything `create()` throws.

#### `Sandbox.connect(uuid: string, options: ConnectSandboxOptions): Promise<Sandbox>`

Attach to an existing box by uuid. `options.privateKey` (required) is the
OpenSSH private key whose public half the box was created with (e.g. a saved
`sbx.privateKey`). Throws `SandboxNotRunningError` if the uuid isn't among your
sandboxes.

#### `Sandbox.list(options?: ClientOptions): Promise<SandboxInfo[]>`

Your account's sandboxes (a bare JSON array on the wire, snake_case verbatim).

### Account-level template (boxfile) — static

#### `Sandbox.getBoxfile(options?: ClientOptions): Promise<string | null>`

The saved `xshellz.box` provisioning manifest, or `null` if unset.
Wire: `GET /v1/shells/agent/boxfile` → `{ "manifest": string | null }`.

#### `Sandbox.setBoxfile(manifest: string | null, options?: ClientOptions): Promise<string | null>`

Save (or clear, with `null`/blank) the manifest; returns it as stored (server
normalizes CRLF→LF, blank stored as `null`). **Applied only when a NEW box is
created** — a template that preinstalls your dependencies; existing boxes are
not re-provisioned. Wire: `PUT /v1/shells/agent/boxfile` with `{ "manifest": … }`.

### Properties (getters)

| Property | Type | Meaning |
|---|---|---|
| `info` | `SandboxInfo` | Last-known control-plane state (snake_case) |
| `uuid` | `string` | Sandbox id |
| `name` | `string` | Display name |
| `status` | `string` | `"running"`, `"stopped"`, … |
| `sshHost` / `sshPort` | `string \| null` / `number \| null` | SSH endpoint |
| `sshCommand` | `string \| null` | Copy-paste `ssh -p … root@…` line |
| `privateKey` | `string` | In-memory OpenSSH private key (persist to reconnect) |
| `detached` | `boolean` | Whether disposal keeps the box alive |

### Commands & code

#### `run(command: string, options?: RunOptions): Promise<CommandResult>`

Run a shell command and wait. A non-zero exit code does **not** throw — check
`result.exitCode`. `options`: `cwd?`, `env?`, `timeoutMs?`, `onStdout?`,
`onStderr?` (called with decoded chunks as they arrive). Throws
`SandboxNotRunningError` (box not running / killed), `XshellzError` (SSH failure
or `timeoutMs` expiry).

#### `runCode(language: string, code: string, options?: RunOptions): Promise<CommandResult>`

Write `code` to a temp file in the box, execute it with the matching interpreter,
always delete the temp file. Languages: `python` (python3), `node`, `bash`,
`ruby`, `php`. Throws `UnsupportedLanguageError` for anything else; otherwise
identical semantics to `run()`.

### Background jobs

#### `spawn(command: string, name?: string): Promise<JobHandle>`

Start `command` as a `nohup`-detached background process. Output → 
`~/.xshellz/jobs/<id>.log` in the box (PID recorded in `<id>.pid`). `name`
prefixes the generated job id. Jobs survive disconnects, not box stops/restarts.
Throws `XshellzError` if the process could not be started.

#### `jobs(): Promise<JobInfo[]>`

All job log files under `~/.xshellz/jobs` with each process's liveness.

### Files (SFTP)

| Method | Direction |
|---|---|
| `writeFile(path, data: Buffer \| Uint8Array \| string): Promise<void>` | data → box |
| `readFile(path): Promise<Buffer>` | box → Buffer |
| `upload(localPath, remotePath): Promise<void>` | local file → box |
| `download(remotePath, localPath): Promise<void>` | box → local file |

### Introspection

#### `stats(): Promise<SandboxStats>`

Live resource usage (`GET /v1/shells/agent/{uuid}/stats`): memory, CPU, pids,
disk, network, block-IO — each paired with the plan ceiling. Poll politely.

#### `procs(): Promise<SandboxProcs>`

Top processes, active SSH session count, detected agents, disk usage
(`GET /v1/shells/agent/{uuid}/procs`).

#### `terminalUrl(): Promise<string>`

Mint a fresh signed web-terminal URL (`GET /v1/shells/agent/{uuid}/terminal`).
The embedded HMAC token expires after **~1 hour**; the URL grants a root shell
until then, so treat it like a credential and mint fresh rather than storing.

### Lifecycle

| Method | Effect |
|---|---|
| `start(): Promise<void>` | Resume an idle-stopped box (same `/home`, same key). |
| `restart(): Promise<void>` | Reboot a running box (re-runs the entrypoint; `/home` preserved; processes and jobs are killed). |
| `kill(): Promise<void>` | Destroy the box (`DELETE`). Idempotent. |
| `detach(): void` | Keep the box alive when `close()` / `await using` disposal runs. |
| `close(): Promise<void>` | Dispose: close SSH and, for a throwaway box, `kill()` it. A detached box is kept alive. |
| `[Symbol.asyncDispose](): Promise<void>` | Backs `await using`; same as `close()`, swallowing a 404 for an already-gone box. |

---

## class `Keystore`

Local plaintext key storage for `getOrCreate`. One `<sanitized-name>.key` file
per sandbox name, `0600` perms inside a `0700` directory.

| Member | Description |
|---|---|
| `new Keystore(dir = DEFAULT_KEYSTORE_DIR)` | Default `~/.xshellz/keys`. |
| `keyPath(name): string` | Where the key for `name` lives. |
| `save(name, privateKey): Promise<string>` | Write (0600) and return the key file path. |
| `load(name): Promise<string \| null>` | The stored key, or `null`. |
| `delete(name): Promise<boolean>` | Remove the key file; `true` if one existed. |

`sanitizeSandboxName(name)` reduces a name to `[A-Za-z0-9._-]` for the filename
(empty → `_`). **Security:** keys are plaintext on disk; deleting the file
revokes local access only — the key stays authorized on the box until the box is
destroyed.

---

## class `JobHandle`

Returned by `Sandbox.spawn()`.

| Member | Description |
|---|---|
| `id` / `pid` / `logPath` | Job id, process id, log file path (in the box) |
| `isRunning(): Promise<boolean>` | `kill -0` probe |
| `logs(tailLines = 100): Promise<string>` | Tail of the combined stdout+stderr log |
| `stop(graceMs = 5000): Promise<void>` | SIGTERM; SIGKILL if still alive after `graceMs` |

## Types / wire shapes

Interfaces mirror the snake_case wire shapes verbatim.

- **`CommandResult`** — `stdout: string`, `stderr: string`, `exitCode: number`
  (non-zero does not throw).
- **`SandboxInfo`** — `uuid`, `name`, `status`, `ssh_command`, `ssh_host`,
  `ssh_port`, `web_terminal_ready`, `trial_ends_at`, `always_on`,
  `trial_hours_remaining`, `spawned_at`, `created_at`, `isolation`, `gvisor`.
- **`SandboxStats`** — `mem_used_mb`, `mem_limit_mb`, `mem_allowed_mb`,
  `cpu_percent`, `cpu_allowed_vcpus`, `cpu_throttled_periods`, `pids_current`,
  `pids_allowed`, `disk_used_mb`, `disk_allowed_mb`, `net_rx_mb`, `net_tx_mb`,
  `blk_read_mb`, `blk_write_mb`.
- **`SandboxProcs`** — `procs: SandboxProcess[]`, `sessions: number`,
  `agents: string[]`, `disk_used_mb`, `disk_allowed_mb`.
- **`SandboxProcess`** — `pid`, `comm`, `cpu`, `mem`.
- **`JobInfo`** — `id: string`, `pid: number | null`, `logPath: string`,
  `running: boolean`.
- **`Ed25519KeyPair`** — `publicKey: string` (authorized_keys line),
  `privateKey: string` (OpenSSH PEM).

## Errors

Hierarchy: everything extends `XshellzError`, so `catch (e) { if (e instanceof
XshellzError) … }` catches everything.

| Error | Raised when |
|---|---|
| `XshellzError` | Base class; also misc SDK failures (SSH error, spawn failed, timeout) |
| `ApiError` | Any 4xx/5xx not mapped below; carries `.status` and `.body` |
| `AuthError` | 401/403 — missing/invalid/expired token, scopes, verification/entitlement gates (extends `ApiError`) |
| `QuotaError` | 403 — plan's concurrent sandbox limit reached (extends `ApiError`) |
| `SandboxNotRunningError` | Box not `running` / not found / already killed (404 or local state) |
| `MissingKeyError` | `getOrCreate` found the box but no private key (message says where it looked) |
| `UnsupportedLanguageError` | `runCode` language not in: python, node, bash, ruby, php |
