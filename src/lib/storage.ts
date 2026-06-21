import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import path from "node:path";

/**
 * File storage adapter (M18). Abstracts two backends behind one small API so the
 * rest of the app never cares where bytes live:
 *
 *  - LOCAL filesystem (the default — needs no keys): bytes are written under a
 *    gitignored `.uploads/<orgId>/<uuid>-<filename>` directory. Always works, so
 *    {@link storageConfigured} is true even with no env at all.
 *  - Vercel Blob (when BLOB_READ_WRITE_TOKEN is set): the heavy @vercel/blob
 *    package is loaded via a lazy dynamic import() — mirroring the env-gated lazy
 *    pattern in src/lib/ai.ts / src/lib/realtime.ts — and `put()` returns a CDN
 *    URL stored alongside the key.
 *
 * The `storageKey` returned by {@link putObject} is the opaque locator the
 * caller persists on the Attachment row; pass it back to {@link readObject} /
 * {@link deleteObject}. Local keys are the relative path under `.uploads`; Blob
 * keys are the blob pathname.
 */

export type StorageBackend = "local" | "blob";

/** Root dir for local uploads (gitignored). Resolved against the project cwd. */
const LOCAL_ROOT = path.join(process.cwd(), ".uploads");

/** True when Vercel Blob is configured via its read-write token. */
export function blobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

/**
 * Which backend is active. "blob" when BLOB_READ_WRITE_TOKEN is present, else
 * "local". The local backend always works, hence {@link storageConfigured} below
 * is unconditionally true.
 */
export function storageBackend(): StorageBackend {
  return blobConfigured() ? "blob" : "local";
}

/** Storage is ALWAYS available — local fs is the zero-config fallback. */
export function storageConfigured(): boolean {
  return true;
}

/** The result of storing an object. `url` is only set for URL-backed backends. */
export type PutResult = {
  storageKey: string;
  url: string | null;
  backend: StorageBackend;
};

/** Strip path separators / control chars from a user-supplied filename. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\-]+/g, "_").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

/**
 * Store bytes for `orgId`. Returns the storageKey to persist plus an optional
 * public URL (Blob only). Uses Blob when configured, otherwise the local fs.
 */
export async function putObject(
  orgId: string,
  filename: string,
  data: Buffer,
  contentType: string,
): Promise<PutResult> {
  const safe = sanitizeFilename(filename);
  const key = `${orgId}/${randomUUID()}-${safe}`;

  if (blobConfigured()) {
    const { put } = await import("@vercel/blob");
    const blob = await put(key, data, {
      access: "public",
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return { storageKey: blob.pathname, url: blob.url, backend: "blob" };
  }

  const abs = path.join(LOCAL_ROOT, key);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, data);
  return { storageKey: key, url: null, backend: "local" };
}

/**
 * Read an object's bytes from the LOCAL backend by its storageKey. Returns null
 * if the file is missing. For the Blob backend bytes are served via the stored
 * `url` (callers redirect there), so this only covers local reads.
 */
export async function readObject(storageKey: string): Promise<Buffer | null> {
  const abs = resolveLocalPath(storageKey);
  if (!abs) return null;
  try {
    await stat(abs);
    return await readFile(abs);
  } catch {
    return null;
  }
}

/**
 * Best-effort delete of a stored object. Never throws — a missing file or a
 * Blob delete failure is swallowed so it can't break the surrounding action.
 */
export async function deleteObject(storageKey: string): Promise<void> {
  if (blobConfigured()) {
    try {
      const { del } = await import("@vercel/blob");
      await del(storageKey, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } catch {
      // ignore — deletion is best-effort
    }
    return;
  }
  const abs = resolveLocalPath(storageKey);
  if (!abs) return;
  try {
    await unlink(abs);
  } catch {
    // ignore — already gone
  }
}

/**
 * Resolve a storageKey to an absolute path UNDER the local root, or null if the
 * key would escape it (path-traversal guard). Exported for unit testing.
 */
export function resolveLocalPath(storageKey: string): string | null {
  const abs = path.resolve(LOCAL_ROOT, storageKey);
  const root = path.resolve(LOCAL_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}
