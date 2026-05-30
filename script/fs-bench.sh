#!/usr/bin/env bash
# Benchmark common development tasks against the wsd FUSE mount.
# Compares against a tmpfs/native baseline so you can see the overhead.
#
# Usage (inside the container):
#   MOUNT=/workspace fs-bench           # bench just the mount
#   MOUNT=/workspace BASE=/tmp fs-bench # also bench /tmp for comparison
set -u

MOUNT="${MOUNT:-/workspace}"
BASE="${BASE:-}"            # optional baseline (e.g. /tmp) for comparison
REPS="${REPS:-1}"           # repetitions per scenario

results=()

have() { command -v "$1" >/dev/null 2>&1; }

# Print ms with 1 decimal.
fmt_ms() { awk -v n="$1" 'BEGIN{printf "%.1f", n/1000000}'; }

# Measure wall time in ns using `date +%s%N` (works on linux GNU date).
now_ns() { date +%s%N; }

# bench NAME DIR -- COMMANDS
# Runs COMMANDS in a fresh subdir of DIR, captures wall time, records result.
bench() {
  local name="$1" base_dir="$2"; shift 2
  [[ "$1" == "--" ]] && shift
  if [[ ! -d "$base_dir" ]]; then
    return
  fi
  local dir="$base_dir/.bench.$$.$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '_')"
  local label
  if [[ "$base_dir" == "$MOUNT" ]]; then label="wsd"; else label="base"; fi

  local total=0 reps_done=0
  local i
  for ((i=0; i<REPS; i++)); do
    rm -rf "$dir" 2>/dev/null
    mkdir -p "$dir"
    local t0 t1
    t0=$(now_ns)
    if ! (cd "$dir" && eval "$*") >/dev/null 2>&1; then
      printf "  \033[31mFAIL\033[0m  %-30s on %s\n" "$name" "$label"
      rm -rf "$dir" 2>/dev/null
      return
    fi
    t1=$(now_ns)
    total=$(( total + t1 - t0 ))
    reps_done=$((reps_done + 1))
    rm -rf "$dir" 2>/dev/null
  done
  local avg=$(( total / reps_done ))
  printf "  \033[32mOK\033[0m    %-30s %s  %8s ms\n" "$name" "$label" "$(fmt_ms $avg)"
  results+=("$name|$label|$avg")
}

section() { printf "\n\033[1m=== %s ===\033[0m\n" "$1"; }

if [[ ! -d "$MOUNT" ]]; then
  echo "mount point $MOUNT does not exist" >&2
  exit 1
fi

declare -a TARGETS=("$MOUNT")
[[ -n "$BASE" && -d "$BASE" ]] && TARGETS+=("$BASE")

# Scenarios. Each is run once per target.

run_scenario() {
  local name="$1" cmd="$2"
  for t in "${TARGETS[@]}"; do
    bench "$name" "$t" -- "$cmd"
  done
}

section "tiny file churn (1000 files)"
run_scenario "create 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
'
run_scenario "stat 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
  for i in $(seq 1 1000); do stat f$i; done
'
run_scenario "rm 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
  rm f*
'

section "directory traversal"
run_scenario "mkdir tree (10x10x10)" '
  for a in $(seq 1 10); do
    for b in $(seq 1 10); do
      mkdir -p $a/$b
      for c in $(seq 1 10); do touch $a/$b/$c; done
    done
  done
'
run_scenario "find tree" '
  for a in $(seq 1 10); do
    for b in $(seq 1 10); do
      mkdir -p $a/$b
      for c in $(seq 1 10); do touch $a/$b/$c; done
    done
  done
  find . -type f | wc -l
'

section "large file I/O"
run_scenario "write 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
'
run_scenario "copy 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
  cp big big2
'
run_scenario "read 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
  cat big > /dev/null
'

if have git; then
  section "git"
  run_scenario "git init + commit 100 files" '
    git init -q
    for i in $(seq 1 100); do echo $i > f$i; done
    git add -A
    git -c user.email=a@b -c user.name=a commit -qm init
  '
  # Tiny repo clone; pick something small and stable.
  # Use --depth 1 to keep it light.
  run_scenario "git clone (shallow, ~1MB)" '
    git clone --depth 1 -q https://github.com/git-fixtures/empty.git r 2>/dev/null \
      || git clone --depth 1 -q https://github.com/octocat/Hello-World.git r
  '
else
  echo "  SKIP  git scenarios (git not installed)"
fi

if have npm; then
  section "npm"
  run_scenario "npm init + tiny install" '
    cat > package.json <<JSON
{"name":"b","version":"0.0.0","dependencies":{"is-number":"7.0.0"}}
JSON
    npm install --no-audit --no-fund --silent --prefer-offline 2>&1
  '
else
  echo "  SKIP  npm scenarios (npm not installed)"
fi

if have go; then
  section "go"
  run_scenario "go mod init + build hello" '
    go mod init bench >/dev/null
    cat > main.go <<GO
package main
import "fmt"
func main(){ fmt.Println("hi") }
GO
    go build -o hello .
  '
else
  echo "  SKIP  go scenarios (go not installed)"
fi

section "summary"
if (( ${#TARGETS[@]} > 1 )); then
  printf "  %-30s %12s %12s %10s\n" "scenario" "wsd (ms)" "base (ms)" "ratio"
  # Group results by name.
  declare -A wsd base
  for r in "${results[@]}"; do
    name="${r%%|*}"; rest="${r#*|}"; label="${rest%%|*}"; ns="${rest##*|}"
    if [[ "$label" == "wsd" ]]; then wsd[$name]=$ns; else base[$name]=$ns; fi
  done
  for name in "${!wsd[@]}"; do
    w="${wsd[$name]}"
    b="${base[$name]:-0}"
    if [[ "$b" != "0" ]]; then
      ratio=$(awk -v w="$w" -v b="$b" 'BEGIN{printf "%.2fx", w/b}')
    else
      ratio="-"
    fi
    printf "  %-30s %12s %12s %10s\n" "$name" "$(fmt_ms $w)" "$(fmt_ms $b)" "$ratio"
  done | sort
else
  printf "  %-30s %12s\n" "scenario" "wsd (ms)"
  for r in "${results[@]}"; do
    name="${r%%|*}"; ns="${r##*|}"
    printf "  %-30s %12s\n" "$name" "$(fmt_ms $ns)"
  done
fi
