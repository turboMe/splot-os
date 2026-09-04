#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  🧹 Autoheal — bezpieczne sprzątanie osieroconych worktrees/branchy
#
#  Problem (audyt): worktree-per-task + brak cleanup na ścieżkach
#  suspend/fail zostawia osierocone branche `task-*` (np. 11 branchy,
#  3 fizyczne worktrees → 8 sierot).
#
#  Ten skrypt jest BEZPIECZNY:
#   - `git worktree prune` (nieszkodliwe, czyści wpisy admin),
#   - listuje branche `task-*` BEZ aktywnego worktree,
#   - usuwa TYLKO te w pełni zmergowane do master (git branch --merged),
#   - branche z niezmergowaną pracą jedynie RAPORTUJE (decyzja człowieka).
#
#  Użycie:
#    bash scripts/autoheal-prune-worktrees.sh            # dry-run (domyślnie)
#    bash scripts/autoheal-prune-worktrees.sh --force    # usuń zmergowane sieroty
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FORCE="${1:-}"

GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${CYAN}[PRUNE]${NC} $1"; }
ok()   { echo -e "${GREEN}[PRUNE ✅]${NC} $1"; }
warn() { echo -e "${YELLOW}[PRUNE ⚠️]${NC} $1"; }

cd "$REPO_DIR"

log "git worktree prune (czyszczenie wpisów admin)..."
git worktree prune

# Branche, które mają aktywny worktree — tych NIE ruszamy
mapfile -t ACTIVE_WT_BRANCHES < <(git worktree list --porcelain | awk '/^branch /{sub("refs/heads/","",$2); print $2}')

is_active_worktree() {
  local b="$1"
  for a in "${ACTIVE_WT_BRANCHES[@]:-}"; do
    [ "$b" = "$a" ] && return 0
  done
  return 1
}

MERGED_ORPHANS=()
UNMERGED_ORPHANS=()

while IFS= read -r branch; do
  branch="${branch#"${branch%%[![:space:]]*}"}"   # ltrim
  [ -z "$branch" ] && continue
  case "$branch" in task-*) ;; *) continue ;; esac
  if is_active_worktree "$branch"; then
    continue
  fi
  if git branch --merged master --format='%(refname:short)' | grep -qx "$branch"; then
    MERGED_ORPHANS+=("$branch")
  else
    UNMERGED_ORPHANS+=("$branch")
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads/)

echo
log "Osierocone branche task-* (bez aktywnego worktree):"
log "  zmergowane do master (bezpieczne do usunięcia): ${#MERGED_ORPHANS[@]}"
for b in "${MERGED_ORPHANS[@]:-}"; do [ -n "$b" ] && echo "    - $b"; done
warn "  NIEzmergowane (zostają — wymagają decyzji człowieka): ${#UNMERGED_ORPHANS[@]}"
for b in "${UNMERGED_ORPHANS[@]:-}"; do [ -n "$b" ] && echo "    - $b"; done
echo

if [ "$FORCE" = "--force" ]; then
  for b in "${MERGED_ORPHANS[@]:-}"; do
    [ -z "$b" ] && continue
    log "Usuwam zmergowany branch: $b"
    git branch -d "$b"
  done
  ok "Usunięto ${#MERGED_ORPHANS[@]} zmergowanych sierot. Niezmergowane pozostawione nietknięte."
else
  warn "DRY-RUN — nic nie usunięto. Uruchom z --force aby usunąć TYLKO zmergowane sieroty."
fi
