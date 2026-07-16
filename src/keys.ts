import { generateKeyPairSync, randomBytes } from "node:crypto";

const KEY_TYPE = "ssh-ed25519";

export interface Ed25519KeyPair {
  /** OpenSSH authorized_keys line: `ssh-ed25519 <base64> <comment>`. */
  publicKey: string;
  /** Unencrypted OpenSSH private key (openssh-key-v1 PEM), parseable by ssh2's utils.parseKey. */
  privateKey: string;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function sshString(data: Buffer | string): Buffer {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return Buffer.concat([uint32(bytes.length), bytes]);
}

/**
 * Generate an in-memory ed25519 keypair encoded in the two formats SSH needs:
 * the OpenSSH public-key line (sent to the control plane, which writes it into
 * the box's authorized_keys) and the openssh-key-v1 private key (fed to ssh2).
 * The private half never leaves the process.
 *
 * Raw key extraction relies on the fixed ASN.1 layout of ed25519 keys:
 * SPKI DER is 44 bytes with the 32-byte public key last; PKCS#8 DER is
 * 48 bytes with the 32-byte seed last.
 */
export function generateEd25519KeyPair(comment = "xshellz-sdk"): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const rawPublic = Buffer.from(spkiDer.subarray(spkiDer.length - 32));

  const pkcs8Der = privateKey.export({ type: "pkcs8", format: "der" });
  const seed = Buffer.from(pkcs8Der.subarray(pkcs8Der.length - 32));

  const publicBlob = Buffer.concat([sshString(KEY_TYPE), sshString(rawPublic)]);
  const publicLine = `${KEY_TYPE} ${publicBlob.toString("base64")} ${comment}`;

  return {
    publicKey: publicLine,
    privateKey: encodeOpenSshPrivateKey(publicBlob, rawPublic, seed, comment),
  };
}

/**
 * Encode an unencrypted openssh-key-v1 private key block (the format written
 * by `ssh-keygen -t ed25519`):
 *
 *   "openssh-key-v1\0"
 *   string cipher   = "none"
 *   string kdf      = "none"
 *   string kdfopts  = ""
 *   uint32 nkeys    = 1
 *   string publicKeyBlob
 *   string privateSection (checkint x2, keytype, pub, seed||pub, comment, pad 1..n to 8-byte blocks)
 */
function encodeOpenSshPrivateKey(publicBlob: Buffer, rawPublic: Buffer, seed: Buffer, comment: string): string {
  const checkInt = randomBytes(4);

  let privateSection = Buffer.concat([
    checkInt,
    checkInt,
    sshString(KEY_TYPE),
    sshString(rawPublic),
    sshString(Buffer.concat([seed, rawPublic])),
    sshString(comment),
  ]);

  const blockSize = 8;
  const remainder = privateSection.length % blockSize;
  if (remainder !== 0) {
    const padding = Buffer.from(Array.from({ length: blockSize - remainder }, (_, i) => i + 1));
    privateSection = Buffer.concat([privateSection, padding]);
  }

  const blob = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);

  const base64 = blob.toString("base64");
  const lines = base64.match(/.{1,70}/g) ?? [];

  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}
