import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";
import { generateEd25519KeyPair } from "../src/keys.js";

const { utils } = ssh2;

/** Rebuild a node KeyObject from the 32 raw ed25519 public bytes (SPKI prefix + raw). */
function publicKeyObjectFromRaw(raw: Buffer) {
  const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: "der", type: "spki" });
}

describe("generateEd25519KeyPair", () => {
  it("produces an OpenSSH public-key line", () => {
    const { publicKey } = generateEd25519KeyPair();

    expect(publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ xshellz-sdk$/);

    const blob = Buffer.from(publicKey.split(" ")[1]!, "base64");
    // string "ssh-ed25519" + string <32 bytes>
    expect(blob.readUInt32BE(0)).toBe(11);
    expect(blob.subarray(4, 15).toString()).toBe("ssh-ed25519");
    expect(blob.readUInt32BE(15)).toBe(32);
    expect(blob.length).toBe(4 + 11 + 4 + 32);
  });

  it("round-trips: the private key parses with ssh2 and matches the public line", () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();

    const parsed = utils.parseKey(privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    if (parsed instanceof Error) {
      throw parsed;
    }

    const key = Array.isArray(parsed) ? parsed[0]! : parsed;
    expect(key.type).toBe("ssh-ed25519");

    const expectedBlob = Buffer.from(publicKey.split(" ")[1]!, "base64");
    expect(Buffer.compare(key.getPublicSSH(), expectedBlob)).toBe(0);
  });

  it("round-trips: an ssh2 signature verifies against the node public key", () => {
    const { publicKey, privateKey } = generateEd25519KeyPair();

    const parsed = utils.parseKey(privateKey);
    if (parsed instanceof Error) {
      throw parsed;
    }
    const key = Array.isArray(parsed) ? parsed[0]! : parsed;

    const data = Buffer.from("xshellz ed25519 round trip");
    const signature = key.sign(data);
    expect(signature).not.toBeInstanceOf(Error);
    if (signature instanceof Error) {
      throw signature;
    }

    const blob = Buffer.from(publicKey.split(" ")[1]!, "base64");
    const rawPublic = blob.subarray(blob.length - 32);
    const verified = cryptoVerify(null, data, publicKeyObjectFromRaw(Buffer.from(rawPublic)), signature);

    expect(verified).toBe(true);
  });

  it("generates a distinct keypair per call", () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();

    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });

  it("honours a custom comment", () => {
    const { publicKey } = generateEd25519KeyPair("my-box");

    expect(publicKey.endsWith(" my-box")).toBe(true);
  });
});
