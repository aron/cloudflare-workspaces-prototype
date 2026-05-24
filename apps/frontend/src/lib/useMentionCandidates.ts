/**
 * Load and cache the mention autocomplete pool.
 *
 * The pool is the union of:
 *   - one synthetic candidate, `@agent`, the only handle the server actually
 *     reacts to (RoomDO mints a thread when a message mentions `@agent`).
 *   - every user the App DO has ever seen (`/api/app/users`).
 *
 * Users are fetched once per page lifetime. They're tiny and effectively
 * static across a session — a fresh user showing up mid-session is not
 * worth cache invalidation complexity. Refresh = page reload.
 *
 * `kind` lets the popover render an icon and disambiguate when an
 * `@username` collides with `@agent` (the agent always wins for
 * behaviour, and it's listed first so it wins visually too).
 */
import { useEffect, useState } from "react";

import { fetchUsers } from "@/lib/api";

export interface MentionCandidate {
  handle: string;
  /** Display label (agent label or user.name). */
  label:  string;
  /** Subtitle: short description or user email. */
  sub:    string;
  kind:   "agent" | "user";
}

/** The one server-meaningful handle. Anything else is decorative. */
const AGENT_CANDIDATE: MentionCandidate = {
  handle: "agent",
  label:  "Agent",
  sub:    "the room's assistant",
  kind:   "agent",
};

interface State {
  candidates: MentionCandidate[];
  /** Lowercased handles, for renderers to know which `@x` to pill. */
  handles:    ReadonlySet<string>;
  loading:    boolean;
}

const INITIAL: State = {
  candidates: [AGENT_CANDIDATE],
  handles:    new Set([AGENT_CANDIDATE.handle]),
  loading:    true,
};

let cache: State = INITIAL;
const subscribers = new Set<(s: State) => void>();
let inflight: Promise<void> | null = null;

function publish(next: State) {
  cache = next;
  for (const fn of subscribers) fn(next);
}

async function load() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const users = await fetchUsers().catch(() => []);
      const seen = new Set<string>([AGENT_CANDIDATE.handle]);
      const candidates: MentionCandidate[] = [AGENT_CANDIDATE];
      for (const u of users) {
        const h = u.username.toLowerCase();
        if (seen.has(h)) continue;
        seen.add(h);
        candidates.push({ handle: h, label: u.name, sub: u.email, kind: "user" });
      }
      publish({ candidates, handles: seen, loading: false });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function useMentionCandidates(): State {
  const [state, setState] = useState<State>(cache);

  useEffect(() => {
    subscribers.add(setState);
    if (cache.loading) void load();
    return () => { subscribers.delete(setState); };
  }, []);

  return state;
}

/** Convenience hook for read-only sites that only need the handle set. */
export function useMentionHandles(): ReadonlySet<string> {
  return useMentionCandidates().handles;
}

/**
 * Case-insensitive prefix match against the candidate pool. Returns up to
 * `limit` rows. `agent` is always at the head of the list (it's inserted
 * first by `load()`), so when the user just types `@` the popover lands
 * on the most meaningful option.
 */
export function filterCandidates(
  candidates: readonly MentionCandidate[],
  prefix:     string,
  limit = 8,
): MentionCandidate[] {
  const p = prefix.toLowerCase();
  const out: MentionCandidate[] = [];
  for (const c of candidates) {
    if (!p || c.handle.startsWith(p) || c.label.toLowerCase().includes(p)) {
      out.push(c);
      if (out.length === limit) break;
    }
  }
  return out;
}
