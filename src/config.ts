import { AuthError } from "./errors.js";

/** Default control-plane base URL (production). */
export const DEFAULT_API_URL = "https://api.xshellz.com/v1";

/** Default timeout for control-plane HTTP calls (sandbox spawn is synchronous and can take a few seconds). */
export const DEFAULT_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  /** xShellz personal access token (PAT). Falls back to `XSHELLZ_API_KEY`. */
  apiKey?: string;
  /** Control-plane base URL. Falls back to `XSHELLZ_API_URL`, then `https://api.xshellz.com/v1`. */
  apiUrl?: string;
  /** Timeout for control-plane HTTP requests, in milliseconds. Default 60 000. */
  timeoutMs?: number;
}

export interface ResolvedConfig {
  apiKey: string;
  apiUrl: string;
  timeoutMs: number;
}

/**
 * Resolve configuration with precedence: explicit option > environment
 * variable > default. Throws {@link AuthError} when no API key is found.
 */
export function resolveConfig(options: ClientOptions = {}): ResolvedConfig {
  const apiKey = options.apiKey ?? process.env.XSHELLZ_API_KEY ?? "";
  if (apiKey === "") {
    throw new AuthError(
      "Missing xShellz API key. Set the XSHELLZ_API_KEY environment variable or pass { apiKey } explicitly. " +
        "Create a personal access token with `read` and `write` scopes in your xShellz account settings (API tokens).",
    );
  }

  const apiUrl = (options.apiUrl ?? process.env.XSHELLZ_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");

  return {
    apiKey,
    apiUrl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
