import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Default keystore directory: `~/.xshellz/keys/`. */
export const DEFAULT_KEYSTORE_DIR = join(homedir(), ".xshellz", "keys");

/**
 * Map a sandbox name onto a safe keystore filename: every character outside
 * `[A-Za-z0-9._-]` becomes `_`, and an empty result becomes a single `_`.
 */
export function sanitizeSandboxName(name: string): string {
  const sanitized = name.replace(/[^A-Za-z0-9._-]/g, "_");

  return sanitized === "" ? "_" : sanitized;
}

/**
 * Local on-disk store for sandbox private keys, used by
 * `Sandbox.getOrCreate()` to make named boxes survive process restarts.
 * One file per sanitized sandbox name (`<name>.key`) under {@link dir}
 * (default `~/.xshellz/keys/`), containing the OpenSSH private key.
 *
 * **Security note:** keys are stored in plaintext, protected only by file
 * permissions (directory `0700`, files `0600`). Anyone who can read the file
 * can SSH into the box. Delete the file (or `kill()` the box) to revoke.
 */
export class Keystore {
  readonly dir: string;

  constructor(dir: string = DEFAULT_KEYSTORE_DIR) {
    this.dir = dir;
  }

  /** Absolute path where the key for `name` is (or would be) stored. */
  keyPath(name: string): string {
    return join(this.dir, `${sanitizeSandboxName(name)}.key`);
  }

  /** Persist a private key for `name` (creates the directory, mode 0600). Returns the file path. */
  async save(name: string, privateKey: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const path = this.keyPath(name);
    await writeFile(path, privateKey, { mode: 0o600 });
    await chmod(path, 0o600);

    return path;
  }

  /** Load the private key for `name`, or `null` when no key file exists. */
  async load(name: string): Promise<string | null> {
    try {
      return await readFile(this.keyPath(name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  /** Delete the stored key for `name` (revokes SDK access to the box). Returns whether a file was removed. */
  async delete(name: string): Promise<boolean> {
    try {
      await rm(this.keyPath(name));

      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
