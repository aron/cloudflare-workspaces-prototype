#!/usr/bin/env bash
#
# Tail the deployed agent Worker with the noise stripped out.
#
# Wraps `wrangler tail --format json | jq` with a filter that hides the
# event classes that dominate the raw stream but rarely carry actionable
# signal:
#
#   - Sandbox warm-pool plumbing (getState, renewActivityTimeout,
#     containerFetch, idFromName-bare-fetches) — these fire constantly.
#   - WarmPool RPCs (configure, getContainer) — same story.
#   - DO alarms whose logs[] and exceptions[] are both empty — successful
#     scheduled work, no signal.
#   - WebSocket close events (code 1006) — routine tab navigations.
#   - GET requests with outcome=ok and no logs/exceptions — polls,
#     health checks, asset fetches.
#   - Empty-string `rpcMethod` events with no payload — bare
#     `stub.fetch()` calls (warm-pool probes) that named RPCs already
#     cover.
#   - "Durable Object reset because its code was updated." exceptions —
#     normal artifact of a deploy mid-stream.
#   - "Using http transport" log lines — sandbox SDK startup chatter.
#
# What survives:
#   - Any user-facing HTTP request (entries with event.request.url).
#   - Any RPC method other than the warm-pool/keepalive set above.
#   - Anything with a non-empty logs[] that isn't the SDK chatter line.
#   - Anything with a non-empty exceptions[] that isn't a code-reset.
#   - Anything with outcome != "ok" that the rules above didn't drop.
#
# Usage:
#   ./tail-agent.sh                       # live tail
#   ./tail-agent.sh --file path.jsonl     # filter a captured log file
#   ./tail-agent.sh --raw                 # emit full JSON per event
#                                         #   (default: compact one-liner)
#   ./tail-agent.sh -- <wrangler args>    # pass-through to wrangler tail
#                                         #   (e.g. --status error)
#
# The script `cd`s into `apps/agent` so `wrangler tail` picks up the
# project's wrangler.jsonc without `--name`.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/apps/agent"

FILE=""
RAW=0
PASSTHROUGH=()

while [ $# -gt 0 ]; do
  case "$1" in
    --file)   FILE="$2"; shift 2 ;;
    --raw)    RAW=1; shift ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --)       shift; PASSTHROUGH=("$@"); break ;;
    *)        PASSTHROUGH+=("$1"); shift ;;
  esac
done

# --- Filter logic ------------------------------------------------------
#
# The jq expression is split into a `noise` predicate and a `format`
# expression. `noise` returns true for events we want to drop;
# `select(noise|not)` keeps the rest. Format is either the raw object
# (for --raw) or a compact one-line summary.

read -r -d '' FILTER <<'JQ' || true
# Path classification — what kind of event is this?
def kind:
  if   ((.event.rpcMethod // "") != "")        then .event.rpcMethod
  elif (.event.scheduledTime // null)         then "ALARM"
  elif (.event.request.url // null)           then "HTTP"
  elif (.event.getWebSocketEvent // null)     then "WS_" + (.event.getWebSocketEvent.webSocketEventType // "?")
  elif (.event.cron // null)                  then "CRON"
  else                                             "OTHER"
  end;

# Drop these RPC methods outright — pure plumbing.
def noisy_rpc:
  ["getState", "renewActivityTimeout", "containerFetch",
   "configure", "getContainer", "fetch"];

# Drop "Using http transport" SDK chatter — it fires once per Sandbox boot
# and adds nothing actionable.
def is_sdk_chatter:
  ((.logs // []) | length) > 0 and
  ((.logs | map(.message)
          | flatten
          | map(if type=="object" then .message else . end)
          | unique) == ["Using http transport"]);

# Drop code-reset exceptions that aren't real errors — they fire on every
# deploy and the live tail will catch the real next event anyway.
def is_code_reset:
  ((.exceptions // []) | length) > 0 and
  ((.exceptions | map(.message) | unique)
    == ["Durable Object reset because its code was updated."]);

# Drop alarms with no logs and no exceptions — successful scheduled work.
def is_empty_alarm:
  kind == "ALARM" and
  ((.logs // []) | length) == 0 and
  ((.exceptions // []) | length) == 0;

# Drop entries whose `event.rpcMethod` is the empty string — these are
# bare `stub.fetch()` calls (e.g. warm-pool probes hitting the DO via
# `idFromName().get().fetch()` rather than a named RPC). They never
# carry meaningful payload; the named RPCs above already cover the
# operations that matter.
def is_empty_rpc:
  ((.event.rpcMethod // null) == "") and
  ((.logs // []) | length) == 0 and
  ((.exceptions // []) | length) == 0;

# Drop routine WebSocket close events. Code 1006 ("abnormal closure")
# fires on every tab navigation/close — not signal. Genuine handshake
# failures arrive as HTTP entries with non-101 statuses, which the HTTP
# branch surfaces; this filter only catches the post-connection close.
def is_routine_ws_close:
  kind == "WS_close" and
  ((.logs // []) | length) == 0 and
  ((.exceptions // []) | length) == 0;

# Drop routine GET requests: they're polls / health checks / asset
# fetches. Keep anything with logs, exceptions, a non-ok outcome, or a
# non-GET method — those are the requests that produced signal or
# changed state.
def is_routine_http_get:
  kind == "HTTP" and
  ((.event.request.method // "GET") == "GET") and
  ((.outcome // "") == "ok") and
  ((.logs // []) | length) == 0 and
  ((.exceptions // []) | length) == 0;

def noise:
  # `kind as $k` first — inside `noisy_rpc | index(…)` the implicit
  # `.` is the array, not the original event, so any bare path
  # expression in the argument would dereference into the array.
  (kind as $k | (noisy_rpc | index($k)) != null)
  or is_sdk_chatter
  or is_code_reset
  or is_empty_alarm
  or is_routine_ws_close
  or is_routine_http_get
  or is_empty_rpc;

# Short summary line: <ts> <entrypoint>/<kind> <outcome> [<detail>]
def summarize:
  (.eventTimestamp // 0) as $ts
  | (($ts/1000) | strftime("%H:%M:%S")) as $time
  | (.entrypoint // "?") as $ep
  | kind as $k
  | (.outcome // "?") as $oc
  | (
      if (.exceptions // []) | length > 0
      then " ✗ " + (.exceptions | map(.message) | unique | join(" | "))
      elif (.logs // []) | length > 0
      then " • " + (.logs | map(.message) | flatten
                          | map(if type=="object"
                                then ((.level // "log") + " " + (.message // ""))
                                else tostring end)
                          | unique | join(" | "))
      elif kind == "HTTP"
      then " " + ((.event.request.method // "?") + " " + (.event.request.url // ""))
      else ""
      end
    ) as $detail
  | "\($time)  \($ep)/\($k)  \($oc)\($detail)";

select(noise | not) | _FORMAT_
JQ

# When `--raw` is set, emit one compact JSON object per surviving event.
# Otherwise emit the summary string. The two require different jq output
# flags: `-c` for compact JSON (so each event lands on one line and can
# be piped into another `jq`), `-r` for raw strings (no surrounding
# quotes on the summary).
if [ "$RAW" -eq 1 ]; then
  FILTER="${FILTER/_FORMAT_/.}"
  JQ_FLAGS=(-c)
else
  FILTER="${FILTER/_FORMAT_/summarize}"
  JQ_FLAGS=(-r)
fi

# --- Run ---------------------------------------------------------------

if [ -n "$FILE" ]; then
  # Capture-replay mode. `jq -s '.[]'` un-slurps a concatenated pretty
  # JSON file into one object per line so the same filter works.
  jq -s '.[]' "$FILE" | jq "${JQ_FLAGS[@]}" "$FILTER"
else
  if ! command -v wrangler >/dev/null && ! command -v npx >/dev/null; then
    echo "tail-agent.sh: need wrangler (or npx) on PATH" >&2
    exit 1
  fi
  cd "$AGENT_DIR"
  # Empty-array expansion notes:
  #   - `${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"}` is the portable idiom for
  #     expanding a possibly-empty array under `set -u`. Bash 3.2 (stock
  #     macOS) errors on `"${EMPTY_ARRAY[@]}"` with "unbound variable";
  #     this guard expands to nothing when the array is empty and to the
  #     properly-quoted elements when it isn't.
  #   - `JQ_FLAGS` is always non-empty (set to either `-c` or `-r`
  #     above), so it doesn't need the guard.
  npx wrangler tail --format json ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} \
    | jq "${JQ_FLAGS[@]}" --unbuffered "$FILTER"
fi
