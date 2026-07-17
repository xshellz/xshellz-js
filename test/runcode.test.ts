import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedLanguageError } from "../src/errors.js";
import { Sandbox } from "../src/sandbox.js";
import type { TransportTarget } from "../src/transport.js";
import { FakeTransport, jsonResponse, shellInfo } from "./helpers.js";

const API_KEY = "test-pat-token";
const BASE = "https://api.staging.example/v1";

const fetchMock = vi.fn();
let transports: FakeTransport[];

function transportFactory(target: TransportTarget): FakeTransport {
  const transport = new FakeTransport(target);
  transports.push(transport);

  return transport;
}

async function createSandbox(): Promise<Sandbox> {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, shellInfo()));

  return await Sandbox.create({ apiKey: API_KEY, apiUrl: BASE, transportFactory });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  transports = [];
  delete process.env.XSHELLZ_API_KEY;
  delete process.env.XSHELLZ_API_URL;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sandbox.runCode", () => {
  it.each([
    ["python", "python3", "py"],
    ["node", "node", "js"],
    ["bash", "bash", "sh"],
    ["ruby", "ruby", "rb"],
    ["php", "php", "php"],
  ])("writes a temp file, runs %s with %s, then deletes the file", async (language, interpreter, extension) => {
    const sbx = await createSandbox();
    await sbx.run("true"); // materialize the lazy transport
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "42\n", stderr: "", exitCode: 0 }); // interpreter run
    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 }); // rm -f

    const result = await sbx.runCode(language, "print(6 * 7)");

    expect(result).toEqual({ stdout: "42\n", stderr: "", exitCode: 0 });

    const [path, content] = [...transport.files.entries()].at(-1)!;
    expect(path).toMatch(new RegExp(`^/tmp/xshellz-run-[0-9a-f]{12}\\.${extension}$`));
    expect(content.toString()).toBe("print(6 * 7)");

    const runCall = transport.execCalls.at(-2)!;
    expect(runCall.command).toBe(`${interpreter} ${path}`);
    expect(transport.execCalls.at(-1)!.command).toBe(`rm -f ${path}`);
  });

  it("returns the failure result (non-zero exit) and still deletes the temp file", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "", stderr: "SyntaxError: invalid syntax\n", exitCode: 1 });
    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });

    const result = await sbx.runCode("python", "print(");

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SyntaxError");
    expect(transport.execCalls.at(-1)!.command).toMatch(/^rm -f \/tmp\/xshellz-run-/);
  });

  it("forwards RunOptions (cwd/env/timeout) to the interpreter invocation", async () => {
    const sbx = await createSandbox();
    await sbx.run("true");
    const transport = transports[0]!;
    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });
    transport.nextResults.push({ stdout: "", stderr: "", exitCode: 0 });

    await sbx.runCode("node", "console.log(1)", { cwd: "/srv", env: { DEBUG: "1" }, timeoutMs: 9000 });

    const runCall = transport.execCalls.at(-2)!;
    expect(runCall.command).toMatch(/^export DEBUG='1'; cd '\/srv' && node \/tmp\/xshellz-run-/);
    expect(runCall.options.timeoutMs).toBe(9000);
  });

  it("throws UnsupportedLanguageError listing the supported languages, without touching the box", async () => {
    const sbx = await createSandbox();

    const error = await sbx.runCode("perl", "print 42").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnsupportedLanguageError);
    expect((error as UnsupportedLanguageError).message).toContain("python, node, bash, ruby, php");
    expect(transports).toHaveLength(0);
  });
});
