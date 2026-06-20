import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  realtimeConfigured,
  orgChannel,
  presenceChannel,
  publish,
  authorizeChannel,
  _resetRealtimeForTests,
} from "@/lib/realtime";

// Capture the keys we touch so each test starts from a clean, unconfigured env.
const PUSHER_VARS = ["PUSHER_APP_ID", "PUSHER_KEY", "PUSHER_SECRET", "PUSHER_CLUSTER"] as const;

beforeEach(() => {
  for (const k of PUSHER_VARS) delete process.env[k];
  _resetRealtimeForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of PUSHER_VARS) delete process.env[k];
  _resetRealtimeForTests();
});

describe("realtime channel helpers (M17) — pure", () => {
  it("orgChannel returns the private org channel name", () => {
    expect(orgChannel("abc123")).toBe("private-org-abc123");
  });

  it("presenceChannel returns the presence org channel name", () => {
    expect(presenceChannel("abc123")).toBe("presence-org-abc123");
  });

  it("channel names embed the orgId at the end (used for the auth route's org check)", () => {
    const orgId = "org_xyz";
    expect(orgChannel(orgId).endsWith(`-org-${orgId}`)).toBe(true);
    expect(presenceChannel(orgId).endsWith(`-org-${orgId}`)).toBe(true);
  });
});

describe("realtime env gating (M17)", () => {
  it("realtimeConfigured() is false with no Pusher env", () => {
    expect(realtimeConfigured()).toBe(false);
  });

  it("realtimeConfigured() is false when any of the four vars is missing", () => {
    process.env.PUSHER_APP_ID = "id";
    process.env.PUSHER_KEY = "key";
    process.env.PUSHER_SECRET = "secret";
    // PUSHER_CLUSTER intentionally left unset.
    expect(realtimeConfigured()).toBe(false);
  });

  it("realtimeConfigured() is true only when all four vars are present", () => {
    process.env.PUSHER_APP_ID = "id";
    process.env.PUSHER_KEY = "key";
    process.env.PUSHER_SECRET = "secret";
    process.env.PUSHER_CLUSTER = "mt1";
    expect(realtimeConfigured()).toBe(true);
  });
});

describe("realtime publish (M17) — safe no-op when unconfigured", () => {
  it("publish() resolves without throwing when unconfigured", async () => {
    await expect(publish(orgChannel("o1"), "deal.created", { dealId: "d1" })).resolves.toBeUndefined();
  });

  it("publish() makes NO network call when unconfigured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await publish(orgChannel("o1"), "deal.stage_changed", { dealId: "d1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("authorizeChannel() returns null (no signature) when unconfigured", async () => {
    const res = await authorizeChannel("123.456", presenceChannel("o1"), {
      id: "u1",
      info: { name: "Ada" },
    });
    expect(res).toBeNull();
  });
});
