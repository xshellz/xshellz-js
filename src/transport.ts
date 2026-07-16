import { Client, type SFTPWrapper } from "ssh2";
import { XshellzError } from "./errors.js";

export interface ExecOptions {
  /** Kill the command and reject after this many milliseconds. */
  timeoutMs?: number;
  /** Called with each stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Called with each stderr chunk as it arrives. */
  onStderr?: (chunk: string) => void;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Where and how the data plane connects. */
export interface TransportTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

/**
 * The data-plane seam. v0 is SSH ({@link Ssh2Transport}); v1 will add an HTTP
 * transport against the host sidecar without changing the Sandbox API. Also
 * the unit-test seam — tests substitute a fake.
 */
export interface SandboxTransport {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export type TransportFactory = (target: TransportTarget) => SandboxTransport;

export const defaultTransportFactory: TransportFactory = (target) => new Ssh2Transport(target);

/**
 * SSH data plane over the `ssh2` package: exec for run(), SFTP for files.
 * One lazily-established connection is shared by all operations and
 * re-established transparently if it drops.
 *
 * Host keys are auto-accepted (ssh2's default when no hostVerifier is given):
 * every sandbox is freshly provisioned with a host key the client has never
 * seen, so there is nothing to pin on first contact.
 */
export class Ssh2Transport implements SandboxTransport {
  private client: Client | null = null;
  private ready: Promise<Client> | null = null;
  private sftpChannel: Promise<SFTPWrapper> | null = null;

  constructor(
    private readonly target: TransportTarget,
    private readonly connectTimeoutMs = 20_000,
  ) {}

  private connection(): Promise<Client> {
    if (this.ready !== null) {
      return this.ready;
    }

    const client = new Client();
    this.client = client;

    this.ready = new Promise<Client>((resolve, reject) => {
      client.on("ready", () => resolve(client));
      client.on("error", (error: Error) => {
        this.forget(client);
        reject(new XshellzError(`SSH connection to ${this.target.host}:${this.target.port} failed: ${error.message}`));
      });
      client.on("close", () => this.forget(client));

      client.connect({
        host: this.target.host,
        port: this.target.port,
        username: this.target.username,
        privateKey: this.target.privateKey,
        readyTimeout: this.connectTimeoutMs,
        keepaliveInterval: 15_000,
      });
    });

    return this.ready;
  }

  private forget(client: Client): void {
    if (this.client === client) {
      this.client = null;
      this.ready = null;
      this.sftpChannel = null;
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const client = await this.connection();

    return await new Promise<ExecResult>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(new XshellzError(`SSH exec failed: ${error.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";
        let exitCode: number | null = null;
        let settled = false;
        let timer: NodeJS.Timeout | undefined;

        if (options.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            settled = true;
            stream.close();
            reject(new XshellzError(`Command timed out after ${options.timeoutMs}ms: ${command}`));
          }, options.timeoutMs);
        }

        stream.on("data", (data: Buffer) => {
          const chunk = data.toString("utf8");
          stdout += chunk;
          options.onStdout?.(chunk);
        });
        stream.stderr.on("data", (data: Buffer) => {
          const chunk = data.toString("utf8");
          stderr += chunk;
          options.onStderr?.(chunk);
        });
        stream.on("exit", (code: number | null) => {
          exitCode = code;
        });
        stream.on("close", (code?: number | null) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
          }
          resolve({ stdout, stderr, exitCode: exitCode ?? code ?? -1 });
        });
      });
    });
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpChannel !== null) {
      return this.sftpChannel;
    }

    this.sftpChannel = this.connection().then(
      (client) =>
        new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((error, sftp) => {
            if (error) {
              this.sftpChannel = null;
              reject(new XshellzError(`SFTP channel failed: ${error.message}`));
              return;
            }
            resolve(sftp);
          });
        }),
    );

    return this.sftpChannel;
  }

  async readFile(path: string): Promise<Buffer> {
    const sftp = await this.sftp();

    return await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (error: Error | null | undefined, data: Buffer) => {
        if (error) {
          reject(new XshellzError(`SFTP read of ${path} failed: ${error.message}`));
          return;
        }
        resolve(data);
      });
    });
  }

  async writeFile(path: string, data: Buffer): Promise<void> {
    const sftp = await this.sftp();

    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, data, (error: Error | null | undefined) => {
        if (error) {
          reject(new XshellzError(`SFTP write of ${path} failed: ${error.message}`));
          return;
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.ready = null;
    this.sftpChannel = null;
    client?.end();
  }
}
