import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XshellzError } from "../src/errors.js";
import { Ssh2Transport } from "../src/transport.js";

type Handler = (...args: unknown[]) => void;

const mocked = vi.hoisted(() => {
  class Emitter {
    handlers: Record<string, Handler[]> = {};

    on(event: string, handler: Handler): this {
      (this.handlers[event] ??= []).push(handler);

      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers[event] ?? []) {
        handler(...args);
      }
    }
  }

  class FakeStream extends Emitter {
    stderr = new Emitter();
    closeCalled = false;

    close(): void {
      this.closeCalled = true;
    }
  }

  type ExecCallback = (error: Error | undefined, stream: FakeStream) => void;
  type SftpCallback = (error: Error | undefined, sftp: unknown) => void;

  class FakeClient extends Emitter {
    static instances: FakeClient[] = [];
    static failConnectWith: string | null = null;

    connectConfig: Record<string, unknown> | null = null;
    execCalls: Array<{ command: string; callback: ExecCallback }> = [];
    onExec: ((command: string, callback: ExecCallback) => void) | null = null;
    onSftp: ((callback: SftpCallback) => void) | null = null;
    ended = false;

    constructor() {
      super();
      FakeClient.instances.push(this);
    }

    connect(config: Record<string, unknown>): void {
      this.connectConfig = config;
      queueMicrotask(() => {
        if (FakeClient.failConnectWith !== null) {
          this.emit("error", new Error(FakeClient.failConnectWith));
        } else {
          this.emit("ready");
        }
      });
    }

    exec(command: string, callback: ExecCallback): void {
      this.execCalls.push({ command, callback });
      this.onExec?.(command, callback);
    }

    sftp(callback: SftpCallback): void {
      this.onSftp?.(callback);
    }

    end(): void {
      this.ended = true;
      this.emit("close");
    }
  }

  return { FakeClient, FakeStream };
});

vi.mock("ssh2", () => ({
  Client: mocked.FakeClient,
  default: { Client: mocked.FakeClient },
}));

const { FakeClient, FakeStream } = mocked;

const TARGET = { host: "shellus1.xshellz.com", port: 42001, username: "root", privateKey: "KEY" };

beforeEach(() => {
  FakeClient.instances = [];
  FakeClient.failConnectWith = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function respondWith(stdout: string, stderr: string, exitCode: number | null, closeCode?: number | null) {
  return (command: string, callback: (error: Error | undefined, stream: InstanceType<typeof FakeStream>) => void) => {
    const stream = new FakeStream();
    callback(undefined, stream);
    if (stdout !== "") {
      stream.emit("data", Buffer.from(stdout));
    }
    if (stderr !== "") {
      stream.stderr.emit("data", Buffer.from(stderr));
    }
    if (exitCode !== null) {
      stream.emit("exit", exitCode);
    }
    stream.emit("close", closeCode);
  };
}

describe("Ssh2Transport.exec", () => {
  it("connects with the target credentials and resolves stdout/stderr/exitCode", async () => {
    const transport = new Ssh2Transport(TARGET);
    const promise = transport.exec("echo hi");
    const client = FakeClient.instances.at(-1)!;
    client.onExec = respondWith("hi\n", "warn\n", 0);

    const result = await promise;

    expect(result).toEqual({ stdout: "hi\n", stderr: "warn\n", exitCode: 0 });
    expect(client.connectConfig).toMatchObject({
      host: "shellus1.xshellz.com",
      port: 42001,
      username: "root",
      privateKey: "KEY",
    });
    expect(client.execCalls[0]!.command).toBe("echo hi");
  });

  it("streams chunks to onStdout/onStderr as they arrive", async () => {
    const transport = new Ssh2Transport(TARGET);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const promise = transport.exec("run", {
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    FakeClient.instances.at(-1)!.onExec = respondWith("a", "b", 2);

    const result = await promise;

    expect(result.exitCode).toBe(2);
    expect(stdoutChunks).toEqual(["a"]);
    expect(stderrChunks).toEqual(["b"]);
  });

  it("falls back to the close-event code, then -1, when no exit event fires", async () => {
    const transport = new Ssh2Transport(TARGET);
    const withCloseCode = transport.exec("a");
    FakeClient.instances.at(-1)!.onExec = respondWith("", "", null, 5);
    expect((await withCloseCode).exitCode).toBe(5);

    const withoutAnyCode = transport.exec("b");
    FakeClient.instances.at(-1)!.onExec = respondWith("", "", null, null);
    expect((await withoutAnyCode).exitCode).toBe(-1);
  });

  it("reuses one connection for sequential commands", async () => {
    const transport = new Ssh2Transport(TARGET);
    const first = transport.exec("one");
    const client = FakeClient.instances.at(-1)!;
    client.onExec = respondWith("", "", 0);
    await first;
    await transport.exec("two");

    expect(FakeClient.instances).toHaveLength(1);
    expect(client.execCalls.map((call) => call.command)).toEqual(["one", "two"]);
  });

  it("rejects with XshellzError when the SSH connection fails, and can reconnect after", async () => {
    FakeClient.failConnectWith = "ECONNREFUSED";
    const transport = new Ssh2Transport(TARGET);

    const error = await transport.exec("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XshellzError);
    expect((error as XshellzError).message).toContain("shellus1.xshellz.com:42001");
    expect((error as XshellzError).message).toContain("ECONNREFUSED");

    FakeClient.failConnectWith = null;
    const retry = transport.exec("y");
    FakeClient.instances.at(-1)!.onExec = respondWith("ok", "", 0);
    expect((await retry).stdout).toBe("ok");
    expect(FakeClient.instances).toHaveLength(2); // a fresh client after the failed one
  });

  it("rejects with XshellzError when exec itself errors", async () => {
    const transport = new Ssh2Transport(TARGET);
    const promise = transport.exec("boom");
    FakeClient.instances.at(-1)!.onExec = (_command, callback) => {
      callback(new Error("channel open failure"), new FakeStream());
    };

    await expect(promise).rejects.toThrowError(/SSH exec failed: channel open failure/);
  });

  it("times out long-running commands and closes the stream", async () => {
    const transport = new Ssh2Transport(TARGET);
    let stream: InstanceType<typeof FakeStream> | null = null;
    const promise = transport.exec("sleep 999", { timeoutMs: 20 });
    FakeClient.instances.at(-1)!.onExec = (_command, callback) => {
      stream = new FakeStream();
      callback(undefined, stream);
      // never closes — the timeout must fire
    };

    await expect(promise).rejects.toThrowError(/timed out after 20ms/);
    expect(stream!.closeCalled).toBe(true);
  });
});

describe("Ssh2Transport SFTP", () => {
  function sftpBackend(files: Map<string, Buffer>) {
    return {
      readFile: (path: string, callback: (error: Error | null, data?: Buffer) => void) => {
        const data = files.get(path);
        if (data === undefined) {
          callback(new Error("No such file"));
        } else {
          callback(null, data);
        }
      },
      writeFile: (path: string, data: Buffer, callback: (error: Error | null) => void) => {
        files.set(path, Buffer.from(data));
        callback(null);
      },
    };
  }

  it("round-trips files over one sftp channel", async () => {
    const files = new Map<string, Buffer>();
    const transport = new Ssh2Transport(TARGET);
    let sftpRequests = 0;

    const write = transport.writeFile("/tmp/a.txt", Buffer.from("hello"));
    FakeClient.instances.at(-1)!.onSftp = (callback) => {
      sftpRequests += 1;
      callback(undefined, sftpBackend(files));
    };
    await write;

    expect(files.get("/tmp/a.txt")!.toString()).toBe("hello");
    expect((await transport.readFile("/tmp/a.txt")).toString()).toBe("hello");
    expect(sftpRequests).toBe(1); // channel is cached
  });

  it("wraps read/write failures in XshellzError with the path", async () => {
    const files = new Map<string, Buffer>();
    const transport = new Ssh2Transport(TARGET);
    const read = transport.readFile("/missing");
    FakeClient.instances.at(-1)!.onSftp = (callback) => callback(undefined, sftpBackend(files));

    await expect(read).rejects.toThrowError(/SFTP read of \/missing failed/);
  });

  it("rejects when the sftp channel cannot be opened", async () => {
    const transport = new Ssh2Transport(TARGET);
    const read = transport.readFile("/x");
    FakeClient.instances.at(-1)!.onSftp = (callback) => callback(new Error("no sftp subsystem"), null);

    await expect(read).rejects.toThrowError(/SFTP channel failed: no sftp subsystem/);
  });
});

describe("Ssh2Transport.close", () => {
  it("ends the client and reconnects lazily afterwards", async () => {
    const transport = new Ssh2Transport(TARGET);
    const first = transport.exec("one");
    const client = FakeClient.instances.at(-1)!;
    client.onExec = respondWith("", "", 0);
    await first;

    await transport.close();
    expect(client.ended).toBe(true);

    const second = transport.exec("two");
    FakeClient.instances.at(-1)!.onExec = respondWith("again", "", 0);
    expect((await second).stdout).toBe("again");
    expect(FakeClient.instances).toHaveLength(2);
  });

  it("is a no-op when never connected", async () => {
    const transport = new Ssh2Transport(TARGET);

    await expect(transport.close()).resolves.toBeUndefined();
    expect(FakeClient.instances).toHaveLength(0);
  });
});
