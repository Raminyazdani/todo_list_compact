import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";
const derive = promisify(scrypt);
const AAD = Buffer.from("ramin-life-os-encrypted-backup/v1");
export interface EncryptedBackup {
  format: "ramin-life-os-encrypted-backup/v1";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}
function passphraseValid(passphrase: string) {
  if (passphrase.length < 16 || passphrase.length > 512)
    throw new Error("Backup passphrase must contain 16–512 characters.");
}
export async function encryptBackup(
  backup: unknown,
  passphrase: string,
): Promise<EncryptedBackup> {
  passphraseValid(passphrase);
  const bytes = Buffer.from(JSON.stringify(backup));
  if (bytes.length > 50 * 1024 * 1024)
    throw new Error("Backup exceeds safe encryption size.");
  const salt = randomBytes(16),
    iv = randomBytes(12),
    key = (await derive(passphrase, salt, 32)) as Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return {
      format: "ramin-life-os-encrypted-backup/v1",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    key.fill(0);
    bytes.fill(0);
  }
}
export async function decryptBackup(
  encrypted: EncryptedBackup,
  passphrase: string,
): Promise<unknown> {
  passphraseValid(passphrase);
  if (
    encrypted.format !== "ramin-life-os-encrypted-backup/v1" ||
    encrypted.kdf !== "scrypt" ||
    encrypted.ciphertext.length > 70 * 1024 * 1024
  )
    throw new Error("Unsupported encrypted backup format.");
  const salt = Buffer.from(encrypted.salt, "base64"),
    iv = Buffer.from(encrypted.iv, "base64"),
    tag = Buffer.from(encrypted.tag, "base64"),
    ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid encrypted backup parameters.");
  const key = (await derive(passphrase, salt, 32)) as Buffer;
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Backup authentication failed or content is invalid.");
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}
export function verifyByteChecksum(
  bytes: Uint8Array,
  expectedSha256: string,
): boolean {
  if (!/^[a-fA-F0-9]{64}$/.test(expectedSha256)) return false;
  return timingSafeEqual(
    createHash("sha256").update(bytes).digest(),
    Buffer.from(expectedSha256, "hex"),
  );
}
