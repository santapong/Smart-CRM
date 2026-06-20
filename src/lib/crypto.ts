import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Secrets vault (M15). AES-256-GCM envelope encryption for integration secrets
 * (e.g. a Slack incoming-webhook URL) so they are never persisted in plaintext.
 *
 * The key comes from `ENCRYPTION_KEY` (base64-encoded 32 bytes). When it is
 * unset — local dev, CI, tests — we derive a clearly-labeled DEV-ONLY fallback
 * key so the app still builds and round-trips secrets. Records written with the
 * fallback carry `keyId="dev"`; real keys use `keyId="env"`. {@link decryptSecret}
 * never throws: a tampered or undecryptable record yields `null`, so a single
 * bad row can't crash the outbox drain or a settings page.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length.

/** keyId written alongside ciphertext so future key rotation is possible. */
export const DEV_KEY_ID = "dev";
export const ENV_KEY_ID = "env";

/**
 * A stable, clearly-labeled DEV-ONLY key. NOT secret — it is derived from a
 * constant string and only exists so encrypt/decrypt work without configuration.
 * Production MUST set ENCRYPTION_KEY; see .env.example.
 */
const DEV_KEY = createHash("sha256")
  .update("smart-crm::DEV-ONLY-INSECURE-ENCRYPTION-KEY::do-not-use-in-production")
  .digest(); // 32 bytes

/** Decode and validate the configured key, or null when unset/invalid. */
function envKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return buf.length === 32 ? buf : null;
}

/** Resolve the active key + its id for new writes. */
function activeKey(): { key: Buffer; keyId: string } {
  const k = envKey();
  return k ? { key: k, keyId: ENV_KEY_ID } : { key: DEV_KEY, keyId: DEV_KEY_ID };
}

/** Resolve the key a record was encrypted with, by its keyId. */
function keyForId(keyId: string): Buffer | null {
  if (keyId === ENV_KEY_ID) return envKey();
  if (keyId === DEV_KEY_ID) return DEV_KEY;
  return null;
}

/** The persisted shape of an encrypted secret (base64 fields). */
export type EncryptedRecord = {
  keyId: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

/** Encrypt UTF-8 plaintext, returning base64 envelope fields ready to store. */
export function encryptSecret(plaintext: string): EncryptedRecord {
  const { key, keyId } = activeKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    keyId,
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt an envelope back to plaintext. Returns `null` instead of throwing for
 * any failure — unknown/rotated keyId, tampered ciphertext or auth tag (GCM
 * integrity check), or malformed input — so callers can degrade gracefully.
 */
export function decryptSecret(record: EncryptedRecord): string | null {
  try {
    const key = keyForId(record.keyId);
    if (!key) return null;
    const iv = Buffer.from(record.iv, "base64");
    const authTag = Buffer.from(record.authTag, "base64");
    const ciphertext = Buffer.from(record.ciphertext, "base64");
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/** True when a real ENCRYPTION_KEY is configured (vs. the dev fallback). */
export function isEncryptionConfigured(): boolean {
  return envKey() !== null;
}
