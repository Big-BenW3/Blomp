import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM. Output format: base64(iv[12] | tag[16] | ciphertext). */
function keyFrom(secret: string): Buffer {
  if (!secret || secret.length < 16) throw new Error("encryption secret must be at least 16 characters");
  return createHash("sha256").update(secret).digest();
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(payload: string, secret: string): string {
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 29) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}
