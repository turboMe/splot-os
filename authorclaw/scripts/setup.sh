#!/bin/bash
# AuthorClaw Setup Wizard
# Interactive setup for first-time users

set -e

echo ""
echo "  ✍️  AuthorClaw Setup Wizard"
echo "  ═══════════════════════════════════"
echo "  The Secure AI Writing Agent"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  ❌ Node.js 22+ is required. Install from https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "  ⚠️  Node.js 22+ recommended (found v$(node -v))"
fi

echo "  ✓ Node.js $(node -v) detected"

# Install dependencies
echo ""
echo "  Installing dependencies..."
npm install --silent
echo "  ✓ Dependencies installed"

# ── AI Provider Setup ──
echo ""
echo "  ═══ AI Provider Setup ═══"
echo ""
echo "  AuthorClaw supports free AND paid AI providers."
echo "  You need at least ONE provider configured."
echo ""

# Check for Ollama
if command -v ollama &> /dev/null || curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "  ✓ Ollama detected (FREE local AI)"
    echo "    Checking for models..."
    if curl -s http://localhost:11434/api/tags | grep -q "llama"; then
        echo "    ✓ Models available"
    else
        echo "    ⚠️  No models found. Run: ollama pull llama3.2"
    fi
else
    echo "  ℹ  Ollama not detected."
    echo "     For FREE local AI, install from https://ollama.ai"
    echo "     Then run: ollama pull llama3.2"
fi

echo ""
echo "  Optional: Add API keys for paid providers"
echo "  (You can add these later in the vault)"
echo ""

read -p "  Do you have a Google Gemini API key? (free tier) [y/N]: " GEMINI_YN
if [[ "$GEMINI_YN" =~ ^[Yy]$ ]]; then
    read -sp "  Gemini API key: " GEMINI_KEY
    echo ""
    echo "  ✓ Gemini key will be stored in encrypted vault"
fi

read -p "  Do you have an Anthropic Claude API key? [y/N]: " CLAUDE_YN
if [[ "$CLAUDE_YN" =~ ^[Yy]$ ]]; then
    read -sp "  Claude API key: " CLAUDE_KEY
    echo ""
    echo "  ✓ Claude key will be stored in encrypted vault"
fi

read -p "  Do you have an OpenAI API key? [y/N]: " OPENAI_YN
if [[ "$OPENAI_YN" =~ ^[Yy]$ ]]; then
    read -sp "  OpenAI API key: " OPENAI_KEY
    echo ""
    echo "  ✓ OpenAI key will be stored in encrypted vault"
fi

read -p "  Do you have a DeepSeek API key? [y/N]: " DEEPSEEK_YN
if [[ "$DEEPSEEK_YN" =~ ^[Yy]$ ]]; then
    read -sp "  DeepSeek API key: " DEEPSEEK_KEY
    echo ""
    echo "  ✓ DeepSeek key will be stored in encrypted vault"
fi

# ── Telegram Setup ──
echo ""
read -p "  Set up Telegram integration? [y/N]: " TELEGRAM_YN
if [[ "$TELEGRAM_YN" =~ ^[Yy]$ ]]; then
    echo "  To create a Telegram bot:"
    echo "  1. Message @BotFather on Telegram"
    echo "  2. Send /newbot and follow the prompts"
    echo "  3. Copy the token"
    read -sp "  Telegram bot token: " TELEGRAM_TOKEN
    echo ""
    echo "  ✓ Telegram token will be stored in encrypted vault"
fi

# ── Vault Setup ──
echo ""
echo "  ═══ Security Setup ═══"
echo ""
echo "  AuthorClaw encrypts all credentials with AES-256-GCM."
echo "  Set a vault passphrase (or press Enter for dev default)."
read -sp "  Vault passphrase: " VAULT_PASS
echo ""

if [ -n "$VAULT_PASS" ]; then
    echo "AUTHORCLAW_VAULT_KEY=$VAULT_PASS" > .env
    echo "  ✓ Vault passphrase saved to .env"
else
    echo "  ℹ  Using development default (change before production!)"
fi

# ── Done ──
echo ""
echo "  ═══════════════════════════════════"
echo "  ✍️  AuthorClaw is ready!"
echo ""
echo "  Start with:  npm start"
echo "  Or Docker:   npm run docker:up"
echo ""
echo "  Dashboard:   http://localhost:3847"
echo "  ═══════════════════════════════════"
echo ""
