#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Ollama GPU Safety Hardening Script
#
# Sets systemd environment overrides for the ollama.service to prevent
# VRAM exhaustion that causes hard system freezes (lockups).
#
# What this does:
#   1. OLLAMA_MAX_VRAM    — Hard limit on VRAM usage (reserves MB for system)
#   2. OLLAMA_MAX_LOADED_MODELS — Limit concurrent model instances
#   3. OLLAMA_NUM_PARALLEL      — Limit parallel requests per model
#
# Usage:
#   sudo bash scripts/harden-ollama.sh [OPTIONS]
#
# Options:
#   --reserve-mb <MB>   MB to reserve for system (default: 1000)
#   --max-models <N>    Max loaded models (default: 1)
#   --num-parallel <N>  Parallel requests per model (default: 2)
#   --dry-run           Show what would be written without applying
#   --gpu-total <MB>    Override GPU total MB (auto-detected if not set)
#
# Environments:
#   Desktop (GNOME/KDE): 1000 MB reserve (compositor + Xwayland + apps)
#   Headless server:     300 MB reserve (driver overhead)
#   Container:           200 MB reserve (minimal)
#
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Defaults ──
RESERVE_MB=1000
MAX_MODELS=1
NUM_PARALLEL=2
DRY_RUN=false
GPU_TOTAL_MB=""

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case $1 in
    --reserve-mb) RESERVE_MB="$2"; shift 2 ;;
    --max-models) MAX_MODELS="$2"; shift 2 ;;
    --num-parallel) NUM_PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --gpu-total) GPU_TOTAL_MB="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Detect GPU ──
if [ -z "$GPU_TOTAL_MB" ]; then
  if command -v nvidia-smi &>/dev/null; then
    GPU_TOTAL_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
    echo "🔍 Detected GPU VRAM: ${GPU_TOTAL_MB} MB"
  else
    echo "⚠️  No nvidia-smi found. Set --gpu-total manually."
    exit 1
  fi
fi

# ── Calculate max VRAM for Ollama ──
MAX_VRAM_MB=$(( GPU_TOTAL_MB - RESERVE_MB ))
if [ "$MAX_VRAM_MB" -lt 1000 ]; then
  echo "❌ Max VRAM for Ollama would be ${MAX_VRAM_MB} MB — too low. Reduce --reserve-mb."
  exit 1
fi

# Convert MB to bytes (Ollama expects bytes)
MAX_VRAM_BYTES=$(( MAX_VRAM_MB * 1024 * 1024 ))

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Ollama GPU Safety Configuration"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  GPU Total:              ${GPU_TOTAL_MB} MB"
echo "  System Reserve:         ${RESERVE_MB} MB"
echo "  ─────────────────────────────────────"
echo "  Ollama Max VRAM:        ${MAX_VRAM_MB} MB (${MAX_VRAM_BYTES} bytes)"
echo "  Max Loaded Models:      ${MAX_MODELS}"
echo "  Parallel per Model:     ${NUM_PARALLEL}"
echo ""

OVERRIDE_DIR="/etc/systemd/system/ollama.service.d"
OVERRIDE_FILE="${OVERRIDE_DIR}/gpu-safety.conf"

OVERRIDE_CONTENT="[Service]
# GPU Safety Hardening — prevents VRAM exhaustion / system freeze
# Applied by: scripts/harden-ollama.sh
# GPU: ${GPU_TOTAL_MB} MB total, ${RESERVE_MB} MB reserved for system
Environment=\"OLLAMA_MAX_VRAM=${MAX_VRAM_BYTES}\"
Environment=\"OLLAMA_MAX_LOADED_MODELS=${MAX_MODELS}\"
Environment=\"OLLAMA_NUM_PARALLEL=${NUM_PARALLEL}\"
"

if [ "$DRY_RUN" = true ]; then
  echo "📋 [DRY RUN] Would write to ${OVERRIDE_FILE}:"
  echo "────────────────────────────────────────────────"
  echo "$OVERRIDE_CONTENT"
  echo "────────────────────────────────────────────────"
  echo ""
  echo "Then would run:"
  echo "  systemctl daemon-reload"
  echo "  systemctl restart ollama"
  exit 0
fi

# ── Check root ──
if [ "$EUID" -ne 0 ]; then
  echo "❌ Must be run as root (sudo). Use --dry-run to preview."
  exit 1
fi

# ── Apply ──
mkdir -p "$OVERRIDE_DIR"
echo "$OVERRIDE_CONTENT" > "$OVERRIDE_FILE"
echo "✅ Written: ${OVERRIDE_FILE}"

# Reload and restart
systemctl daemon-reload
echo "✅ systemd daemon reloaded"

systemctl restart ollama
echo "✅ Ollama restarted with GPU safety limits"

echo ""
echo "🛡️  Ollama is now limited to ${MAX_VRAM_MB} MB VRAM (${RESERVE_MB} MB reserved for system)"
echo ""
echo "Verify with:"
echo "  systemctl cat ollama.service | grep -i 'max_vram\|max_loaded\|num_parallel'"
echo "  ollama ps"
