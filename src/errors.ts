/**
 * Base class for every error thrown by the xshellz SDK.
 */
export class XshellzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An HTTP-level error from the xShellz control plane (api.xshellz.com).
 * Carries the raw status code and the parsed response body.
 */
export class ApiError extends XshellzError {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown = null,
  ) {
    super(message);
  }
}

/**
 * Authentication / authorization failure (HTTP 401 or 403), including a
 * missing API key detected before any request is made.
 */
export class AuthError extends ApiError {
  constructor(message: string, status = 401, body: unknown = null) {
    super(message, status, body);
  }
}

/**
 * The account hit its plan's sandbox quota (the control plane's 403
 * "agent shell limit" guard). Attach to the existing box with
 * `Sandbox.connect()` / `Sandbox.list()`, or `kill()` it first.
 */
export class QuotaError extends ApiError {}

/**
 * The sandbox does not exist, is stopped, or was already killed — thrown
 * both for control-plane 404s and for local operations on a dead handle.
 */
export class SandboxNotRunningError extends XshellzError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * `Sandbox.getOrCreate()` found an existing box with the requested name but
 * no private key for it — neither an explicit `privateKey` option nor a
 * keystore file. The message says where a key was expected.
 */
export class MissingKeyError extends XshellzError {}

/**
 * `sbx.runCode()` was called with a language the SDK does not know how to
 * execute. The message lists the supported languages.
 */
export class UnsupportedLanguageError extends XshellzError {}
