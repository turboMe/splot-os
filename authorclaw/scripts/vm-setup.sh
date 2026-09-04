#!/bin/bash
# ═══════════════════════════════════════════════════════════
# AuthorClaw VM Setup Script
# Run this INSIDE the Ubuntu VM after copying files over
# Sets up Node.js 22, shared folders, and SSH access
# ═══════════════════════════════════════════════════════════

set -e

echo ""
echo "  AuthorClaw VM Setup"
echo "  ======================================="
echo ""

# ── Step 1: Update system ──
echo "  [1/5] Updating system packages..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# ── Step 2: Install Node.js 22 ──
echo "  [2/5] Installing Node.js 22..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 22 ]]; then
    # Install curl first if missing
    if ! command -v curl &> /dev/null; then
        sudo apt-get install -y curl
    fi
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "  Node.js $(node -v) installed"
else
    echo "  Node.js $(node -v) already installed"
fi

# ── Step 3: Install VirtualBox Guest Additions + SSH ──
echo "  [3/5] Installing VirtualBox tools and SSH..."
sudo apt-get install -y -qq virtualbox-guest-utils virtualbox-guest-x11 openssh-server 2>/dev/null || true

# Enable SSH
sudo systemctl enable ssh 2>/dev/null || true
sudo systemctl start ssh 2>/dev/null || true
echo "  Guest Additions and SSH ready"
echo "  TIP: SSH from Windows PowerShell for copy/paste support:"
echo "    ssh $(whoami)@localhost -p 2222"
echo "  (Requires VirtualBox port forwarding: Host 2222 -> Guest 22)"

# ── Step 4: Create directory structure ──
echo "  [4/5] Creating AuthorClaw directory structure..."
mkdir -p ~/authorclaw
mkdir -p ~/author-os

echo "  Directories created:"
echo "    ~/authorclaw        - Main application"
echo "    ~/author-os         - Author OS tools"

# ── Step 5: Set hostname ──
echo "  [5/5] Setting hostname to 'authorclaw'..."
sudo hostnamectl set-hostname authorclaw 2>/dev/null || true
echo "  Hostname set to 'authorclaw'"

echo ""
echo "  ======================================="
echo "  VM base setup complete!"
echo ""
echo "  Next steps:"
echo "  1. Copy files from shared folder:"
echo "     cp -r /media/sf_authorclaw-transfer/authorclaw ~/authorclaw"
echo "     cp -r /media/sf_authorclaw-transfer/author-os ~/author-os"
echo ""
echo "  2. Install deps and start AuthorClaw:"
echo "     cd ~/authorclaw && npm install"
echo "     npx tsx gateway/src/index.ts &"
echo ""
echo "  3. Or use the quick deploy script:"
echo "     bash /media/sf_authorclaw-transfer/run.sh"
echo ""
echo "  4. Open dashboard: http://localhost:3847"
echo "  ======================================="
echo ""
