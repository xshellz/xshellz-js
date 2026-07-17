# xshellz

[![CI](https://github.com/xshellz/xshellz-js/actions/workflows/ci.yml/badge.svg)](https://github.com/xshellz/xshellz-js/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/xshellz)](https://www.npmjs.com/package/xshellz)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

The official TypeScript/Node SDK for [xShellz](https://www.xshellz.com) — spawn a real
Linux box from your program in seconds and run anything in it.

**What is a sandbox?** A sandbox is a small, disposable Linux computer that runs in the
cloud, walled off from everything else (each one is isolated with
[gVisor](https://gvisor.dev)). Your program can create one, run commands and code inside
it — even sketchy, AI-generated code — and throw it away, without ever putting your own
machine at risk.

## Quickstart

1. **Install the SDK**

   ```bash
   npm install xshellz
   ```

2. **Get an API key.** Sign up at [app.xshellz.com](https://app.xshellz.com) and create a
   personal access token with `read` and `write` scopes under account settings → API
   tokens (the token endpoint is `POST /v1/auth/tokens`). Then:

   ```bash
   export XSHELLZ_API_KEY="<your token>"
   ```

3. **Hello, sandbox:**

   ```ts
   import { Sandbox } from "xshellz";

   await using sbx = await Sandbox.create();   // a fresh Linux box, running
   const r = await sbx.run("echo hello from $(hostname)");
   console.log(r.stdout);                      // scope exit destroys the box
   ```

   No `await using`? Wrap it in `try { ... } finally { await sbx.kill(); }` instead.

## Recipes

### Run a command

```ts
const r = await sbx.run("uname -a", { cwd: "/tmp", env: { DEBUG: "1" }, timeoutMs: 30_000 });
console.log(r.stdout, r.stderr, r.exitCode);  // non-zero exit does NOT throw — it's data
```

### A permanent named box that survives restarts

`getOrCreate` finds a box by name or creates it, and remembers the SSH key on your disk
(`~/.xshellz/keys/`, one file per box, permissions `0600`) — so the *next* run of your
program attaches to the *same* box instead of making a new one. A stopped box is started
automatically.

```ts
const sbx = await Sandbox.getOrCreate("my-agent-box");
await sbx.run("touch /home/user/i-am-still-here");
await sbx.close();   // just drops the SSH connection — the box stays alive
// ...days later, in a different process:
const same = await Sandbox.getOrCreate("my-agent-box");  // same box, same files
```

A `getOrCreate` box is **detached**: `close()` and `await using` disposal do
*not* destroy it (unlike a throwaway `create()` box) — only `kill()` does.

Security note: the private key sits in plaintext on your disk, protected only by file
permissions. Delete the key file (or `kill()` the box) to revoke access. Pass
`{ keystore: false }` to keep keys in memory only.

### Background job (keeps running after you disconnect)

```ts
const job = await sbx.spawn("while true; do date; sleep 5; done", "ticker");
console.log(job.id, job.pid);

await job.isRunning();       // true
await job.logs(20);          // last 20 log lines
await sbx.jobs();            // all jobs: [{ id, pid, logPath, running }]
await job.stop();            // SIGTERM, then SIGKILL after a 5s grace
```

### Run AI-generated code safely

```ts
const result = await sbx.runCode("python", "print(sum(range(101)))");
console.log(result.stdout);  // "5050\n"
```

Supported languages: `python` (python3), `node`, `bash`, `ruby`, `php`. The code is
written to a temp file in the box, executed, and the file is always cleaned up. An
unknown language throws `UnsupportedLanguageError`.

### Files up and down

```ts
await sbx.writeFile("/tmp/config.json", JSON.stringify({ ok: true }));
const data = await sbx.readFile("/tmp/config.json");   // Buffer
await sbx.upload("./local.csv", "/tmp/data.csv");
await sbx.download("/tmp/out.txt", "./out.txt");
```

### Check resource usage

```ts
const stats = await sbx.stats();   // { mem_used_mb, cpu_percent, disk_used_mb, ... }
const procs = await sbx.procs();   // { procs: [{ pid, comm, cpu, mem }], sessions, ... }
```

### Open a web terminal

```ts
const url = await sbx.terminalUrl();  // signed URL, valid ~1 hour — open it in a browser
```

### Preinstall dependencies on every new box (boxfile)

The account-level boxfile is a provisioning template applied when a **new** box is
created (it is seeded into `~/xshellz.box`), so destroy + recreate reproduces your
environment:

```ts
await Sandbox.setBoxfile("apt: ripgrep jq\npip: requests");
const manifest = await Sandbox.getBoxfile();
```

## Full API reference

Every public method, its parameters, return shapes, and errors:
**[docs/API.md](docs/API.md)**. The short version:

```ts
Sandbox.create({ name?, ...config })                 // new box
Sandbox.getOrCreate(name, { privateKey?, keystore?, ...config })
Sandbox.connect(uuid, { privateKey, ...config })     // attach by uuid
Sandbox.list(config?)                                // wire shape, snake_case
Sandbox.getBoxfile(config?) / Sandbox.setBoxfile(manifest, config?)

sbx.run(cmd, opts?)          sbx.runCode(lang, code, opts?)
sbx.spawn(cmd, name?)        sbx.jobs()
sbx.writeFile / readFile / upload / download
sbx.stats()                  sbx.procs()
sbx.start()                  sbx.restart()
sbx.terminalUrl()            sbx.kill()   // destroys the box
sbx.close()                  sbx.detach() // close() disposes; detach() keeps it alive
```

`await using` (and `close()`) destroy a throwaway `create()` box on scope exit.
A `getOrCreate()` box comes back **detached** — disposal keeps it alive, so only
an explicit `kill()` (or deleting its keystore key) destroys it.

## Configuration

Precedence: explicit option > environment variable > default.

| Option      | Env var           | Default                      |
|-------------|-------------------|------------------------------|
| `apiKey`    | `XSHELLZ_API_KEY` | — (required)                 |
| `apiUrl`    | `XSHELLZ_API_URL` | `https://api.xshellz.com/v1` |
| `timeoutMs` | —                 | `60000` (HTTP requests)      |

## Errors

All errors extend `XshellzError`:

| Error                      | When                                                                                      |
|----------------------------|-------------------------------------------------------------------------------------------|
| `AuthError`                | Missing/invalid API key (401) or the account isn't allowed (403 entitlement/verification)  |
| `QuotaError`               | Plan sandbox limit reached (403) — `connect()` to the existing box or `kill()` it first    |
| `SandboxNotRunningError`   | Box not found / stopped / already killed (404, or local state)                             |
| `MissingKeyError`          | `getOrCreate()` found the box but no private key (keystore file missing / keystore off)    |
| `UnsupportedLanguageError` | `runCode()` got a language other than python, node, bash, ruby, php                        |
| `ApiError`                 | Any other API failure — carries `.status` and `.body`                                      |

## v0 limits

- **Free tier: 1 concurrent box.** `Sandbox.create()` throws `QuotaError` while one
  exists — attach with `getOrCreate()`/`connect()` instead, or `kill()` it.
- **Free boxes idle-stop after ~30 minutes.** A stopped box keeps `/home` (and your SSH
  key); `getOrCreate()` resumes it automatically, or call `sbx.start()`.
- Create is rate-limited (10/min per account). Spawn is synchronous — `create()` resolves
  in a few seconds once the box is RUNNING.

## How it works

- **Control plane** — `api.xshellz.com`: create / list / start / restart / kill / stats /
  boxfile are authenticated HTTPS calls (global `fetch`, no HTTP dependency).
- **Data plane** — direct SSH to the box as `root` (fake-root inside a user namespace,
  inside gVisor) via the [`ssh2`](https://www.npmjs.com/package/ssh2) package — the only
  runtime dependency. `run()` is SSH exec; file methods are SFTP on the same connection.
- Every `Sandbox.create()` generates an **in-memory ed25519 keypair**; the public half is
  sent to the API, the private half never leaves your process (unless you opt into the
  `getOrCreate` keystore, which stores it at `~/.xshellz/keys/` with `0600` perms).
- SSH **host keys are auto-accepted**: each sandbox is freshly provisioned, so there is
  nothing to pin on first contact. Don't run the SDK where a man-in-the-middle between
  you and `*.xshellz.com` is part of your threat model.

## Module formats

Dual ESM + CJS with an `exports` map (types included for both). Requires Node >= 18
(global `fetch`). `await using` requires TypeScript 5.2+ with `lib: ["esnext"]` or newer;
everything works without it via `try/finally` + `kill()`.

## Local development (Docker)

No local Node needed — run the full build + test suite (with the 80% coverage gate) in a
container (`node:22`, npm cache persisted in a named volume):

```bash
docker compose run --rm test
```

The repo is mounted at `/work`; the container runs `npm ci`, `npm run build` (tsup) and
`npm test` (vitest + v8 coverage). `node_modules/` and `dist/` are masked with anonymous
volumes, so the container never touches your host copies.

## License

MIT © 2026 xShellz
