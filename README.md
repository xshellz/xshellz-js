# xshellz

Official TypeScript/Node SDK for [xShellz](https://www.xshellz.com) sandboxes — spawn a
throwaway, gVisor-isolated Linux box from your program and run commands in it.

```bash
npm install xshellz
```

```ts
import { Sandbox } from "xshellz";

await using sbx = await Sandbox.create();          // spawns a box, RUNNING on return

const r = await sbx.run("node -e 'console.log(6 * 7)'");
console.log(r.stdout);                              // "42\n"
console.log(r.exitCode);                            // 0 — non-zero exit does NOT throw

await sbx.writeFile("/tmp/data.json", "{}");
const data = await sbx.readFile("/tmp/data.json"); // Buffer
// scope exit kills the box (Symbol.asyncDispose)
```

Without `await using` (any Node >= 18, no TS 5.2 needed):

```ts
const sbx = await Sandbox.create({ name: "my-box" });
try {
  await sbx.run("uname -a", { onStdout: (chunk) => process.stdout.write(chunk) });
  await sbx.upload("./local.txt", "/tmp/remote.txt");
  await sbx.download("/tmp/remote.txt", "./out.txt");
} finally {
  await sbx.kill(); // .close() is an alias
}
```

## How it works

- **Control plane** — `api.xshellz.com`: `create()`, `list()`, `connect()`, `start()`,
  `kill()` are authenticated HTTPS calls (global `fetch`, no HTTP dependency).
- **Data plane** — direct SSH to the box as `root` (fake-root inside a user namespace,
  inside [gVisor](https://gvisor.dev)) using the [`ssh2`](https://www.npmjs.com/package/ssh2)
  package — the only runtime dependency. `run()` is SSH exec; `readFile`/`writeFile`/
  `upload`/`download` are SFTP over the same connection.
- Every `Sandbox.create()` generates an **in-memory ed25519 keypair**; the public half is
  sent to the API and written into the box's `authorized_keys`, the private half never
  leaves your process. Persist `sbx.privateKey` if you want to re-attach later with
  `Sandbox.connect(uuid, { privateKey })`.
- SSH **host keys are auto-accepted**: each sandbox is freshly provisioned with a host key
  no client has seen before, so there is nothing to pin on first contact. Do not point the
  SDK at untrusted networks where a man-in-the-middle between you and `*.xshellz.com` is
  part of your threat model.

## Authentication

Create a **personal access token (PAT)** with `read` and `write` scopes in your xShellz
account settings (API tokens), then:

```bash
export XSHELLZ_API_KEY="<your PAT>"
```

or pass it explicitly: `Sandbox.create({ apiKey: "..." })`.

Config precedence: explicit option > environment variable > default.

| Option      | Env var           | Default                      |
|-------------|-------------------|------------------------------|
| `apiKey`    | `XSHELLZ_API_KEY` | — (required)                 |
| `apiUrl`    | `XSHELLZ_API_URL` | `https://api.xshellz.com/v1` |
| `timeoutMs` | —                 | `60000` (HTTP requests)      |

Staging: `export XSHELLZ_API_URL="https://api.staging.xshellz.com/v1"`.

## API

```ts
Sandbox.create({ name?, apiKey?, apiUrl?, timeoutMs? }): Promise<Sandbox>
Sandbox.connect(uuid, { privateKey, apiKey?, apiUrl?, timeoutMs? }): Promise<Sandbox>
Sandbox.list({ apiKey?, apiUrl?, timeoutMs? }): Promise<SandboxInfo[]>  // wire shape, snake_case

sbx.run(command, { cwd?, env?, timeoutMs?, onStdout?, onStderr? }): Promise<{ stdout, stderr, exitCode }>
sbx.writeFile(path, data: Buffer | Uint8Array | string): Promise<void>
sbx.readFile(path): Promise<Buffer>
sbx.upload(localPath, remotePath): Promise<void>
sbx.download(remotePath, localPath): Promise<void>
sbx.start(): Promise<void>          // resume an idle-stopped box
sbx.kill(): Promise<void>           // destroy the box (idempotent); .close() is an alias
sbx.uuid; sbx.name; sbx.status; sbx.sshHost; sbx.sshPort; sbx.sshCommand; sbx.privateKey; sbx.info
```

### Typed errors

All errors extend `XshellzError`:

| Error                    | When                                                                                  |
|--------------------------|---------------------------------------------------------------------------------------|
| `AuthError`              | Missing/invalid API key (401) or the account isn't allowed (403 entitlement/verification) |
| `QuotaError`             | Plan sandbox limit reached (403) — `connect()` to the existing box or `kill()` it first |
| `SandboxNotRunningError` | Box not found / stopped / already killed (404, or local state)                         |
| `ApiError`               | Any other API failure — carries `.status` and `.body`                                  |

## v0 limits

- **Free tier: 1 concurrent box.** `Sandbox.create()` throws `QuotaError` while one
  exists — attach to it with `Sandbox.list()` + `Sandbox.connect()` instead, or `kill()` it.
- **Free boxes idle-stop after ~30 minutes.** A stopped box keeps `/home` (and your SSH
  key); resume it with `sbx.start()`.
- Spawn is synchronous — `create()` resolves in a few seconds once the box is RUNNING.
- Create is rate-limited (10/min per account).

## Module formats

Dual ESM + CJS with an `exports` map (types included for both). Requires Node >= 18
(global `fetch`). `await using` requires TypeScript 5.2+ with `lib: ["esnext"]` or newer;
everything works without it via `try/finally` + `kill()`.

## Local development (Docker)

No local Node needed — run the full build + test suite in a container
(`node:22`, npm cache persisted in a named volume):

```bash
docker compose run --rm test
```

The repo is mounted at `/work`; the container runs `npm ci`, `npm run build`
(tsup) and `npm test` (vitest). `node_modules/` and `dist/` are masked with
anonymous volumes inside the container, so the container installs its own
dependencies and never touches your host copies.

## License

MIT © 2026 xShellz
