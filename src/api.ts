import type { ResolvedConfig } from "./config.js";
import { ApiError, AuthError, QuotaError, SandboxNotRunningError, XshellzError } from "./errors.js";

const USER_AGENT = "xshellz-js/0.2.0";

/**
 * Wire shape of an agent shell (sandbox) as returned by the xShellz control
 * plane. Snake_case, verbatim from the API.
 */
export interface SandboxInfo {
  uuid: string;
  name: string;
  status: string;
  ssh_command: string | null;
  ssh_host: string | null;
  ssh_port: number | null;
  web_terminal_ready: boolean;
  /** Vestigial — always null; read `trial_hours_remaining` instead. */
  trial_ends_at: string | null;
  always_on: boolean;
  trial_hours_remaining: number;
  spawned_at: string | null;
  created_at: string | null;
  /** Effective OCI runtime: "runsc" = gVisor, "runc" = shared host kernel. */
  isolation: string | null;
  gvisor: boolean;
}

/**
 * Live resource usage for a sandbox, verbatim from
 * `GET /v1/shells/agent/{uuid}/stats` (snake_case wire shape). `*_allowed_*`
 * fields are the plan's ceilings; the rest are current usage.
 */
export interface SandboxStats {
  mem_used_mb: number;
  mem_limit_mb: number;
  mem_allowed_mb: number;
  cpu_percent: number;
  cpu_allowed_vcpus: number;
  cpu_throttled_periods: number;
  pids_current: number;
  pids_allowed: number;
  disk_used_mb: number;
  disk_allowed_mb: number;
  net_rx_mb: number;
  net_tx_mb: number;
  blk_read_mb: number;
  blk_write_mb: number;
}

/** One process row from `GET /v1/shells/agent/{uuid}/procs`. */
export interface SandboxProcess {
  pid: number;
  comm: string;
  cpu: number;
  mem: number;
}

/**
 * Top processes + active session count + disk usage, verbatim from
 * `GET /v1/shells/agent/{uuid}/procs` (snake_case wire shape).
 */
export interface SandboxProcs {
  procs: SandboxProcess[];
  /** Active SSH/terminal sessions on the box. */
  sessions: number;
  /** Names of coding agents detected running inside the box. */
  agents: string[];
  disk_used_mb: number;
  disk_allowed_mb: number;
}

/**
 * Minimal control-plane HTTP client over global fetch (node >= 18).
 * Maps error responses onto the SDK's typed error hierarchy.
 */
export class ApiClient {
  constructor(private readonly config: ResolvedConfig) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}${path}`, init);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new XshellzError(`Request to ${this.config.apiUrl}${path} failed: ${reason}`);
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      throw mapApiError(response.status, parsed);
    }

    return parsed as T;
  }
}

function extractMessage(body: unknown): string | null {
  if (body !== null && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.message === "string" && record.message !== "") {
      return record.message;
    }
    if (typeof record.error === "string" && record.error !== "") {
      return record.error;
    }
  }
  if (typeof body === "string" && body !== "") {
    return body;
  }
  return null;
}

/**
 * Map a control-plane error response onto a typed SDK error.
 *
 * Guard-chain facts (from accounts-api's AgentShellService):
 * - 401: unauthenticated (bad/expired PAT).
 * - 403 "…agent shell limit (N)":       plan quota          -> QuotaError
 * - 403 error=verification_required:    verify-to-unlock    -> AuthError
 * - 403 (entitlement/preview/abuse):    account not allowed -> AuthError
 * - 404: sandbox not found / not in the expected state -> SandboxNotRunningError
 * - everything else (422, 429, 5xx): ApiError
 */
export function mapApiError(status: number, body: unknown): XshellzError {
  const message = extractMessage(body) ?? `HTTP ${status}`;

  if (status === 401) {
    return new AuthError(
      `${message} — check XSHELLZ_API_KEY: it must be a personal access token with read+write scopes.`,
      status,
      body,
    );
  }

  if (status === 403) {
    if (/agent shell limit/i.test(message)) {
      return new QuotaError(
        `${message} Attach to your existing sandbox with Sandbox.connect()/Sandbox.list(), or kill() it first.`,
        status,
        body,
      );
    }
    return new AuthError(message, status, body);
  }

  if (status === 404) {
    return new SandboxNotRunningError(message, status, body);
  }

  return new ApiError(message, status, body);
}
