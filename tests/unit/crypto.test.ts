import { describe, it, expect, afterEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  isEncryptionConfigured,
  DEV_KEY_ID,
  type EncryptedRecord,
} from "@/lib/crypto";

/**
 * Secrets vault (M15). These run with no ENCRYPTION_KEY in the environment, so
 * the dev-only fallback key is exercised end-to-end.
 */

const savedKey = process.env.ENCRYPTION_KEY;
afterEach(() => {
  if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedKey;
});

describe("crypto vault (M15)", () => {
  it("uses the dev fallback key when ENCRYPTION_KEY is unset", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    const rec = encryptSecret("hello");
    expect(rec.keyId).toBe(DEV_KEY_ID);
  });

  it("round-trips encrypt → decrypt (dev key)", () => {
    delete process.env.ENCRYPTION_KEY;
    const secret = "https://hooks.slack.com/services/T000/B000/abcdef123456";
    const rec = encryptSecret(secret);
    expect(rec.ciphertext).not.toContain("hooks.slack.com");
    expect(decryptSecret(rec)).toBe(secret);
  });

  it("produces a fresh IV per call (ciphertext differs for same plaintext)", () => {
    delete process.env.ENCRYPTION_KEY;
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("returns null (does not throw) when the ciphertext is tampered with", () => {
    delete process.env.ENCRYPTION_KEY;
    const rec = encryptSecret("tamperme");
    // Flip a byte in the base64 ciphertext → GCM auth check must fail.
    const raw = Buffer.from(rec.ciphertext, "base64");
    raw[0] = raw[0] ^ 0xff;
    const tampered: EncryptedRecord = { ...rec, ciphertext: raw.toString("base64") };
    expect(decryptSecret(tampered)).toBeNull();
  });

  it("returns null when the auth tag is wrong", () => {
    delete process.env.ENCRYPTION_KEY;
    const rec = encryptSecret("tagcheck");
    const badTag = Buffer.alloc(16, 0).toString("base64");
    expect(decryptSecret({ ...rec, authTag: badTag })).toBeNull();
  });

  it("returns null for an unknown keyId", () => {
    delete process.env.ENCRYPTION_KEY;
    const rec = encryptSecret("x");
    expect(decryptSecret({ ...rec, keyId: "rotated-away" })).toBeNull();
  });

  it("round-trips with a real base64 32-byte key (keyId=env)", () => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    expect(isEncryptionConfigured()).toBe(true);
    const rec = encryptSecret("prod-secret");
    expect(rec.keyId).toBe("env");
    expect(decryptSecret(rec)).toBe("prod-secret");
  });
});
