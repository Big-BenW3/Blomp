import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";

const SECRET = "a-test-secret-with-enough-length";

describe("secret encryption", () => {
  it("round-trips a token", () => {
    const enc = encryptSecret("gho_abc123", SECRET);
    expect(enc).not.toContain("gho_abc123");
    expect(decryptSecret(enc, SECRET)).toBe("gho_abc123");
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same", SECRET)).not.toBe(encryptSecret("same", SECRET));
  });

  it("rejects the wrong key", () => {
    const enc = encryptSecret("token", SECRET);
    expect(() => decryptSecret(enc, "a-different-secret-entirely")).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const buf = Buffer.from(encryptSecret("token", SECRET), "base64");
    buf[buf.length - 1] ^= 0xff;
    expect(() => decryptSecret(buf.toString("base64"), SECRET)).toThrow();
  });

  it("rejects short secrets and short payloads", () => {
    expect(() => encryptSecret("x", "short")).toThrow();
    expect(() => decryptSecret("AAAA", SECRET)).toThrow();
  });
});
