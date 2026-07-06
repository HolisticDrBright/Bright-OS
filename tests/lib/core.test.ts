import { describe, expect, it } from "vitest";
import { signHeartbeat, verifyHeartbeatSignature } from "@/lib/hmac";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { canTransition } from "@/lib/transitions";
import { autoTagDecision, isMedicalOrRegulatory, startOfTodayIso } from "@/lib/guardrails";
import { normalizeAction } from "@/lib/decisions";

describe("hmac", () => {
  const secret = "s3cret";
  it("round-trips a valid signature", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"source":"X","message":"y"}';
    const sig = signHeartbeat(secret, ts, body);
    expect(verifyHeartbeatSignature({ secret, timestamp: ts, signature: sig, rawBody: body })).toEqual({
      ok: true,
    });
  });
  it("rejects tampered bodies and stale timestamps", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signHeartbeat(secret, ts, "a");
    expect(verifyHeartbeatSignature({ secret, timestamp: ts, signature: sig, rawBody: "b" }).ok).toBe(false);
    const old = String(Math.floor(Date.now() / 1000) - 301);
    const sig2 = signHeartbeat(secret, old, "a");
    expect(verifyHeartbeatSignature({ secret, timestamp: old, signature: sig2, rawBody: "a" }).ok).toBe(false);
  });
  it("rejects when no secret configured", () => {
    expect(verifyHeartbeatSignature({ secret: "", timestamp: "1", signature: "x", rawBody: "a" }).ok).toBe(
      false,
    );
  });
});

describe("rateLimit", () => {
  it("enforces the window", () => {
    resetRateLimits();
    const opts = { limit: 3, windowMs: 1000, nowMs: 1_000_000 };
    expect(rateLimit("k", opts).allowed).toBe(true);
    expect(rateLimit("k", opts).allowed).toBe(true);
    expect(rateLimit("k", opts).allowed).toBe(true);
    expect(rateLimit("k", opts).allowed).toBe(false);
    // window slides
    expect(rateLimit("k", { ...opts, nowMs: 1_001_001 }).allowed).toBe(true);
  });
});

describe("transitions matrix", () => {
  it("humans: sensible lifecycle allowed, teleports blocked", () => {
    expect(canTransition("backlog", "assigned", "human").ok).toBe(true);
    expect(canTransition("in_progress", "awaiting_approval", "human").ok).toBe(true);
    expect(canTransition("verified", "shipped", "human").ok).toBe(true);
    expect(canTransition("backlog", "shipped", "human").ok).toBe(false);
    expect(canTransition("shipped", "verified", "human").ok).toBe(false);
  });
  it("agents: narrow matrix", () => {
    expect(canTransition("assigned", "in_progress", "agent").ok).toBe(true);
    expect(canTransition("in_progress", "awaiting_approval", "agent").ok).toBe(true);
    expect(canTransition("awaiting_approval", "verified", "agent").ok).toBe(false);
    expect(canTransition("backlog", "assigned", "agent").ok).toBe(false);
  });
  it("no-op transition is always fine", () => {
    expect(canTransition("backlog", "backlog", "agent").ok).toBe(true);
  });
});

describe("medical/regulatory hard-rule detection", () => {
  it("detects medical content in text", () => {
    expect(isMedicalOrRegulatory("Publish BPC-157 dosing comparison")).toBe(true);
    expect(isMedicalOrRegulatory("HIPAA compliance banner update")).toBe(true);
    expect(isMedicalOrRegulatory("New landing page hero image")).toBe(false);
  });
  it("respects explicit tags", () => {
    expect(isMedicalOrRegulatory("anything", ["medical"])).toBe(true);
  });
  it("autoTagDecision adds medical-regulatory", () => {
    expect(autoTagDecision({ title: "Approve GLP-1 patient education email" })).toContain(
      "medical-regulatory",
    );
    expect(autoTagDecision({ title: "Rotate API key", tags: ["ops"] })).toEqual(["ops"]);
  });
});

describe("startOfTodayIso", () => {
  it("returns local midnight for the LA timezone", () => {
    // 2026-07-06 20:00 UTC == 13:00 PDT → local midnight is 07:00 UTC
    const iso = startOfTodayIso(new Date("2026-07-06T20:00:00Z"), "America/Los_Angeles");
    expect(iso).toBe("2026-07-06T07:00:00.000Z");
  });
  it("handles the day boundary (23:30 PDT is still the same local day)", () => {
    const iso = startOfTodayIso(new Date("2026-07-07T06:30:00Z"), "America/Los_Angeles");
    expect(iso).toBe("2026-07-06T07:00:00.000Z");
  });
});

describe("normalizeAction", () => {
  it("maps human phrasings to canonical actions", () => {
    expect(normalizeAction("approve")).toBe("approved");
    expect(normalizeAction("APPROVED")).toBe("approved");
    expect(normalizeAction("reject")).toBe("rejected");
    expect(normalizeAction("discuss")).toBe("discuss");
    expect(normalizeAction("maybe")).toBe(null);
  });
});
