# Communication & API Integrations

> **Phase:** F5 (Skills Audit Implementation Plan)  
> **Status:** ✅ Implemented  
> **Date:** 2026-05-09

## Overview

Phase 5 adds external communication channels for agent notifications, alerts, and outreach automation.

## Components

### 1. Telegram Bot Tools (`tools/communication/telegram.ts`)

Three tools for Telegram Bot API integration:

| Tool | Purpose |
|------|---------|
| `telegram.send_message` | Send text messages (MarkdownV2 support) |
| `telegram.send_alert` | Formatted alerts with severity icons (🔴/🟡/🔵) |
| `telegram.send_document` | Send files/documents via URL |

**Use cases:**
- ErrorCollector critical alerts → Telegram notification
- Build status reports
- Agent task completion notifications

**Required env vars:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

### 2. Webhook Sender (`tools/communication/webhook.ts`)

Generic and preset webhook tools:

| Tool | Purpose |
|------|---------|
| `webhook.send` | Generic JSON POST to any webhook URL |
| `webhook.slack` | Slack Incoming Webhook preset |
| `webhook.discord` | Discord Webhook preset with embeds |

**Use cases:**
- n8n/Make/Zapier integration
- Cross-platform notifications
- CI/CD pipeline triggers

### 3. Email Communication Strategy (`_skills/meta/email-communication-strategy.md`)

Comprehensive cold email and outreach strategy:
- **AIDA framework** (Attention → Interest → Desire → Action)
- **Subject line rules** with effectiveness patterns
- **Follow-up cadence** (Day 0/3/7/14, max 4 emails)
- **Personalization levels** (L1 Basic → L4 Bespoke)
- **Thread management** schema
- **Producer-hunt integration** pipeline

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TELEGRAM_BOT_TOKEN` | For Telegram | Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | For Telegram | Default chat for messages |
| `SLACK_WEBHOOK_URL` | For Slack | Incoming webhook URL |
| `DISCORD_WEBHOOK_URL` | For Discord | Channel webhook URL |

## Skipped (per user decision)

- ~~5.3 Stripe~~ — not needed currently
- ~~5.4 SendGrid/Resend~~ — not needed currently
- ~~5.5 Slack/Discord~~ — webhook.ts included as bonus but not priority
