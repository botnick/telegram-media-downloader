#!/bin/sh
# Big-data regression guard — see CLAUDE.md "Big-data patterns".
#
# Catches the two regression families that v2.13.x fixed:
#   1. `.prepare(... FROM <high-cardinality-table>).all()` without LIMIT
#      → OOM inside `Statement::JS_all` on a 1M-row library.
#   2. `Math.max/min(...arr)` over a dynamically-sized array
#      → RangeError "Maximum call stack size exceeded" past V8's
#      ~65 535-arg limit.
#
# Wired into `npm run check`, which is itself wired into the lefthook
# pre-commit hook. Code review still does the qualitative work — this
# guard is the cheap safety net that catches the obvious regressions
# before they ship.

set -e

# --- 1. Unbounded .all() over high-cardinality tables ---
HITS=$(grep -rnE "\.prepare\([^)]*FROM[[:space:]]+(downloads|peer_downloads|cluster_audit|cluster_egress_log|share_links|queue_backlog|update_history|image_embeddings|image_tags|faces)\b" src/ \
    | grep -E "\.all\(" \
    | grep -vE "LIMIT|WHERE[[:space:]]+[A-Za-z_.]+[[:space:]]*=[[:space:]]*\?|WHERE[[:space:]]+[A-Za-z_.]+[[:space:]]+IN[[:space:]]*\(" \
    || true)

if [ -n "$HITS" ]; then
    echo "❌ OOM regression — unbounded .all() over a high-cardinality table:"
    echo "$HITS" | sed 's/^/   /'
    echo
    echo "Fix: convert to .iterate() (see src/core/integrity.js sweep) or"
    echo "add an explicit LIMIT clause. Reference: CLAUDE.md → \"Big-data patterns\"."
    exit 1
fi

# --- 2. Math.max/min(...spread) — stack-overflow risk on big arrays ---
# Strip JS line-comments (`// …`) and JSDoc continuation lines (`* …`)
# before searching so a comment that *describes* the antipattern doesn't
# trip the guard. We don't try to handle block comments — they're rare
# enough in this codebase that a false positive there is acceptable.
HITS=$(grep -rnE "Math\.(max|min)\([^)]*\.\.\." src/ \
    | grep -vE ":[[:space:]]*(//|\*)[[:space:]]" \
    || true)
if [ -n "$HITS" ]; then
    echo "❌ OOM regression — Math.max/min over spread array (stack-overflow risk):"
    echo "$HITS" | sed 's/^/   /'
    echo
    echo "Fix: convert to a for-loop accumulator. Reference:"
    echo "src/core/cluster/sync.js (sinceId loop)."
    exit 1
fi

echo "✅ No big-data regressions found."
