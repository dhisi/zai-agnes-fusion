/**
 * Image provider access control — MULTI-KEY POOL.
 *
 * Every render goes through `agnes-image-2.5-flash`. The app now holds several
 * free Agnes keys (AGNES_API_KEY plus AGNES_API_KEY_2..AGNES_API_KEY_9). Each
 * key is a separate free account, so each one carries its OWN budget:
 *
 *   - a small number of renders in flight at once (the real free-tier rule),
 *   - a minimum gap between two request starts,
 *   - a rolling per-minute ceiling,
 *   - its own cooldown after a 429 (one blocked key never stalls the others).
 *
 * Work is handed to whichever key is free, so N keys give roughly N times the
 * throughput while each individual account stays under its own limit. Keys are
 * read only here, on the server, and never reach the browser.
 */

/** Requests allowed per rolling minute, PER KEY. */
export const IMAGE_RPM = 19;
/** Rolling window length. */
const WINDOW_MS = 60_000;
/** Minimum gap between two request starts, PER KEY. */
const SPACING_MS = 3_400;

/** How many renders a single key may have in flight at once. */
export const PER_KEY_CONCURRENCY = 3;

/** Reads every configured Agnes key, in order, skipping blanks/duplicates. */
function readKeys(): string[] {
  const names = [
    "AGNES_API_KEY",
    "AGNES_API_KEY_2",
    "AGNES_API_KEY_3",
    "AGNES_API_KEY_4",
    "AGNES_API_KEY_5",
    "AGNES_API_KEY_6",
    "AGNES_API_KEY_7",
    "AGNES_API_KEY_8",
    "AGNES_API_KEY_9",
  ];
  const out: string[] = [];
  for (const n of names) {
    const v = process.env[n]?.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Back-compat: the first configured key. */
export function agnesKey(): string {
  const keys = readKeys();
  if (keys.length === 0) throw new Error("Missing AGNES_API_KEY (Agnes AI image key)");
  return keys[0] as string;
}

type KeyState = {
  key: string;
  /** Start times of recent requests, oldest first. */
  starts: number[];
  inFlight: number;
  lastStart: number;
  /** No request may start on this key before this timestamp. */
  cooldownUntil: number;
  /** Consecutive rate-limit hits; drives cooldown length and spacing. */
  throttleLevel: number;
  /** Escalated account-wide block: drop this key to a single lane. */
  hardBlocked: boolean;
};

let pool: KeyState[] = [];
let poolSignature = "";

function states(): KeyState[] {
  const keys = readKeys();
  if (keys.length === 0) throw new Error("Missing AGNES_API_KEY (Agnes AI image key)");
  const sig = keys.join("|");
  if (sig !== poolSignature) {
    poolSignature = sig;
    pool = keys.map((key) => ({
      key,
      starts: [],
      inFlight: 0,
      lastStart: 0,
      cooldownUntil: 0,
      throttleLevel: 0,
      hardBlocked: false,
    }));
  }
  return pool;
}

/** Total renders that may be in flight across the whole pool. */
export function poolCapacity(): number {
  return states().length * PER_KEY_CONCURRENCY;
}

/** Number of configured keys. */
export function keyCount(): number {
  return states().length;
}

function spacing(s: KeyState): number {
  return SPACING_MS * (1 + Math.min(s.throttleLevel, 1));
}

/**
 * Record a rate-limit response for ONE key. The other keys keep working.
 * `hard` marks the escalated account-wide block, which needs a real pause and
 * a single lane on that key until a render succeeds again.
 */
export function noteRateLimit(retryAfterMs?: number, hard = false, keyIndex = 0): number {
  const s = states()[keyIndex] ?? states()[0]!;
  s.throttleLevel = Math.min(s.throttleLevel + 1, 3);
  if (hard) s.hardBlocked = true;
  const backoff = hard
    ? 60_000
    : retryAfterMs && retryAfterMs > 0
      ? Math.min(Math.max(retryAfterMs, 2_000), 20_000)
      : Math.min(3_000 + 2_000 * (s.throttleLevel - 1), 12_000);
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + backoff);
  return backoff;
}

/** Record a success so that key's throttle relaxes again. */
export function noteImageSuccess(keyIndex = 0): void {
  const s = states()[keyIndex];
  if (!s) return;
  s.throttleLevel = 0;
  s.cooldownUntil = 0;
  s.hardBlocked = false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prune(s: KeyState, now: number) {
  s.starts = s.starts.filter((t) => now - t < WINDOW_MS);
}

/** Milliseconds until this key may start another request. 0 = go now. */
function waitFor(s: KeyState, now: number): number {
  prune(s, now);
  if (now < s.cooldownUntil) return s.cooldownUntil - now;
  if (s.inFlight >= (s.hardBlocked ? 1 : PER_KEY_CONCURRENCY)) return 200;
  const sinceLast = now - s.lastStart;
  const gap = spacing(s);
  if (sinceLast < gap) return gap - sinceLast;
  if (s.starts.length >= IMAGE_RPM) {
    const oldest = s.starts[0] as number;
    return Math.max(50, WINDOW_MS - (now - oldest));
  }
  return 0;
}

/** Longest a single server call may sit in this gate. */
const MAX_GATE_WAIT_MS = 90_000;

/** Round-robin cursor so consecutive renders spread across the pool. */
let cursor = 0;

/**
 * Leases a slot on whichever key is free and hands that key to `fn`.
 * `fn` receives the key and its index — pass that index back to
 * `noteRateLimit`/`noteImageSuccess` so throttling stays per key.
 */
export async function withImageKey<T>(
  _slot: number,
  _attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const all = states();
  const deadline = Date.now() + MAX_GATE_WAIT_MS;
  let picked = -1;
  for (;;) {
    const now = Date.now();
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < all.length; i++) {
      const idx = (cursor + i) % all.length;
      const wait = waitFor(all[idx] as KeyState, now);
      if (wait <= 0) {
        picked = idx;
        break;
      }
      if (wait < best) best = wait;
    }
    if (picked >= 0) break;
    if (now + best > deadline) {
      throw new Error("429 rate limited, waiting 90s (local pacing gate)");
    }
    await sleep(Math.min(best, 400));
  }
  cursor = (picked + 1) % all.length;
  const s = all[picked] as KeyState;
  const now = Date.now();
  s.lastStart = now;
  s.starts.push(now);
  s.inFlight++;
  try {
    return await fn(s.key, picked);
  } finally {
    s.inFlight--;
  }
}
