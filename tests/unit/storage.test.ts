import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  storageBackend,
  storageConfigured,
  blobConfigured,
  putObject,
  readObject,
  deleteObject,
  resolveLocalPath,
  sanitizeFilename,
} from "@/lib/storage";

const ORG = "test-org-storage";
const UPLOAD_DIR = path.join(process.cwd(), ".uploads", ORG);

beforeEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(async () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  // Clean up anything this suite wrote under the org's local upload dir.
  await rm(UPLOAD_DIR, { recursive: true, force: true });
});

describe("storage adapter (M18) — backend selection", () => {
  it("storageBackend() is 'local' with no token", () => {
    expect(storageBackend()).toBe("local");
    expect(blobConfigured()).toBe(false);
  });

  it("storageBackend() is 'blob' when BLOB_READ_WRITE_TOKEN is set", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_xxx";
    expect(storageBackend()).toBe("blob");
    expect(blobConfigured()).toBe(true);
  });

  it("storageConfigured() is always true (local fallback always works)", () => {
    expect(storageConfigured()).toBe(true);
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_xxx";
    expect(storageConfigured()).toBe(true);
  });
});

describe("storage adapter (M18) — local put/read/delete round-trip", () => {
  it("putObject writes locally and readObject returns the same bytes", async () => {
    const data = Buffer.from("hello smart-docs", "utf8");
    const res = await putObject(ORG, "greeting.txt", data, "text/plain");
    expect(res.backend).toBe("local");
    expect(res.url).toBeNull();
    expect(res.storageKey.startsWith(`${ORG}/`)).toBe(true);
    expect(res.storageKey.endsWith("-greeting.txt")).toBe(true);

    const read = await readObject(res.storageKey);
    expect(read).not.toBeNull();
    expect(read?.toString("utf8")).toBe("hello smart-docs");

    // Delete removes it; a subsequent read returns null.
    await deleteObject(res.storageKey);
    expect(await readObject(res.storageKey)).toBeNull();
  });

  it("readObject returns null for a missing key", async () => {
    expect(await readObject(`${ORG}/does-not-exist`)).toBeNull();
  });

  it("deleteObject on a missing key does not throw", async () => {
    await expect(deleteObject(`${ORG}/missing`)).resolves.toBeUndefined();
  });
});

describe("storage adapter (M18) — path-traversal guard", () => {
  it("resolveLocalPath rejects keys that escape the upload root", () => {
    expect(resolveLocalPath("../../etc/passwd")).toBeNull();
    expect(resolveLocalPath("/etc/passwd")).toBeNull();
  });

  it("resolveLocalPath accepts a normal org-scoped key", () => {
    const abs = resolveLocalPath(`${ORG}/uuid-file.txt`);
    expect(abs).not.toBeNull();
    expect(abs?.includes(path.join(".uploads", ORG))).toBe(true);
  });

  it("readObject refuses to read outside the root (traversal key)", async () => {
    expect(await readObject("../../../etc/passwd")).toBeNull();
  });

  it("sanitizeFilename strips path separators and odd characters", () => {
    expect(sanitizeFilename("../../evil.txt")).toBe("evil.txt");
    expect(sanitizeFilename("a b/c\\d.txt")).toBe("d.txt");
    expect(sanitizeFilename("")).toBe("file");
  });
});
