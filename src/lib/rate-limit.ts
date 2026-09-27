import type { NextRequest } from "next/server";

/**
 * Per-process in-memory rate limiter (token bucket) for local development.
 *
 * Tradeoff: data lives in this process's memory, so limits reset on restart
 * and are not shared across multiple server instances. For production this
 * should be swapped for a shared store (Upstash Redis / Redis) — the
 * `RateLimitStore` interface below is the seam to plug one in without
 * touching the route handlers.
 */
export interface RateLimitStore {
  check(key: string, now: number): { allowed: boolean; retryAfter: number };
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

// In-memory implementation. Replace with a Redis-backed implementation behind
// the same interface for production. NOTE: local-only, resets on restart.
const buckets = new Map<string, TokenBucketState>();

export function createMemoryRateLimiter(
  capacity: number,
  refillPerSecond: number
): RateLimitStore {
  return {
    check(key: string, now: number) {
      return checkTokenBucket(key, now, capacity, refillPerSecond);
    },
  };
}

function refillBucket(
  bucket: TokenBucketState,
  capacity: number,
  refillPerSecond: number,
  now: number
) {
  bucket.tokens = Math.min(
    capacity,
    bucket.tokens + ((now - bucket.lastRefill) / 1000) * refillPerSecond
  );
  bucket.lastRefill = now;
}

function checkTokenBucket(
  key: string,
  now = Date.now(),
  capacity: number,
  refillPerSecond: number
): { allowed: boolean; retryAfter: number } {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, lastRefill: now };
    buckets.set(key, bucket);
  } else {
    refillBucket(bucket, capacity, refillPerSecond, now);
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }

  const deficit = 1 - bucket.tokens;
  return { allowed: false, retryAfter: Math.ceil(deficit / refillPerSecond) };
}

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

// Endpoint budgets. Keyed by IP + email so one endpoint can be hammered only
// from that combination, without an attacker on a single IP locking out a
// legit user's email globally.
export const RATE_LIMITS = {
  signin: { capacity: 5, refillPerSecond: 5 / 60 }, //  5 / min  per IP+email
  signup: { capacity: 5, refillPerSecond: 5 / 60 }, //  5 / min  per IP+email
  resetRequest: { capacity: 3, refillPerSecond: 3 / 3600 }, // 3 / hour per IP+email
  resend: { capacity: 5, refillPerSecond: 5 / 600 }, //  5 / 10min per IP+email
  verify: { capacity: 5, refillPerSecond: 5 / 60 }, //  5 / min  per IP+email
  // Processing a brief calls a paid AI provider, so it gets its own (tighter)
  // budget rather than sharing the generic per-IP bucket.
  process: { capacity: 10, refillPerSecond: 10 / 60 }, // 10 / min per IP
  // File upload is cheap on CPU but unbounded in bandwidth and storage, and a
  // request can carry up to 10 files, so it is budgeted separately rather than
  // inheriting `process`'s allowance.
  upload: { capacity: 20, refillPerSecond: 20 / 60 }, // 20 / min per IP
  ip: { capacity: 40, refillPerSecond: 40 / 60 }, // 40 / min  per IP (any endpoint)
} satisfies Record<string, RateLimitConfig>;

/** Extracts the best-effort client IP from forwarded headers (dev-safe). */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "local";
}

export type Endpoint =
  | "signin"
  | "signup"
  | "resetRequest"
  | "resend"
  | "verify"
  | "process"
  | "upload";

/**
 * Applies the endpoint budget (IP+email keyed) plus the shared per-IP bucket.
 * Buckets are namespaced with the endpoint so "5/min" on signin means five
 * sign-in attempts, not five any-endpoint calls. Returns the effective
 * Retry-After (seconds) from the bucket that failed.
 */
export function checkEndpointRateLimit(
  request: NextRequest,
  endpoint: Endpoint,
  email: string
): { allowed: boolean; retryAfter: number } {
  const ip = clientIp(request);
  const config = RATE_LIMITS[endpoint];

  const emailResult = checkTokenBucket(
    `${endpoint}:${ip}:${email}`,
    Date.now(),
    config.capacity,
    config.refillPerSecond
  );
  if (!emailResult.allowed) return emailResult;

  const ipResult = checkTokenBucket(
    `ip:${ip}`,
    Date.now(),
    RATE_LIMITS.ip.capacity,
    RATE_LIMITS.ip.refillPerSecond
  );
  return ipResult;
}