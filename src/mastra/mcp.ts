import { MCPClient } from '@mastra/mcp';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';

const googleMcpDir = resolve(process.cwd(), '.google-mcp');
const credsPath = resolve(googleMcpDir, 'credentials.json');
const tokenPath = resolve(googleMcpDir, 'token.json');
export const n8nMcpEnabled = process.env.FEATURE_N8N_MCP === 'true' || process.env.N8N_MCP_ENABLED === 'true';
const n8nMcpMode = process.env.N8N_MCP_MODE ?? 'readonly';
const n8nMcpEnv: Record<string, string> = {
  MCP_MODE: 'stdio',
  LOG_LEVEL: process.env.N8N_MCP_LOG_LEVEL ?? 'error',
  DISABLE_CONSOLE_OUTPUT: 'true',
};

if (n8nMcpMode === 'management') {
  if (process.env.N8N_API_URL || process.env.N8N_BASE_URL || process.env.N8N_URL) {
    n8nMcpEnv.N8N_API_URL = process.env.N8N_API_URL ?? process.env.N8N_BASE_URL ?? process.env.N8N_URL!;
  }
  if (process.env.N8N_API_KEY) {
    n8nMcpEnv.N8N_API_KEY = process.env.N8N_API_KEY;
  }
  if (process.env.N8N_MCP_WEBHOOK_SECURITY_MODE) {
    n8nMcpEnv.WEBHOOK_SECURITY_MODE = process.env.N8N_MCP_WEBHOOK_SECURITY_MODE;
  }
}

// WS-E — n8n-mcp server definition, used by the DEDICATED client below (not the
// shared multi-server mcpClient). Isolating it means a flaky sibling server can't
// silently empty the n8nMcpEngineer's tools.
const n8nMcpServer = {
  command: 'npx',
  args: ['-y', 'n8n-mcp'],
  env: n8nMcpEnv,
};

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN) {
  if (!existsSync(googleMcpDir)) {
    mkdirSync(googleMcpDir, { recursive: true });
  }

  if (!existsSync(credsPath)) {
    writeFileSync(
      credsPath,
      JSON.stringify({
        installed: {
          client_id: process.env.GOOGLE_CLIENT_ID,
          project_id: 'agentic-agents',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
          auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uris: [
            process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4111/auth/google/callback',
            'http://localhost'
          ]
        }
      }, null, 2)
    );
  }

  if (!existsSync(tokenPath)) {
    writeFileSync(
      tokenPath,
      JSON.stringify({
        type: 'authorized_user',
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN
      }, null, 2)
    );
  }
}

export const mcpClient = new MCPClient({
  // Default 60s jest za krótki dla fresh uvx (dociąga undetected-chromedriver +
  // setuptools<70 + chromedriver matching Chrome version przy pierwszym uruchomieniu).
  // 180s daje zapas; po ucache-owaniu uvx uruchomienia są szybkie.
  timeout: 180000,
  servers: {
    // ── NotebookLM MCP — SIDECAR ───────────────────────────────────────
    // Działa jako daemon w tle (systemd user service: notebooklm-mcp.service)
    // Łączymy się z nim po szybkim SSE, aby nie blokować startu Mastry.
    'notebooklm': {
      url: new URL('http://127.0.0.1:8765/sse'),
    },

    // ── Browser Automation (Phase F2.1) ──────────────────────────────────
    // Playwright MCP — accessible tree mode (token-efficient, no screenshots)
    // Provides: navigate, click, fill, select, screenshot, evaluate, pdf
    'playwright': {
      command: 'npx',
      args: ['@playwright/mcp@latest'],
    },

    // ── Web Scraping (Phase F2.2) ────────────────────────────────────────
    // Firecrawl MCP — converts web pages to LLM-ready markdown
    // Provides: scrape, crawl, search, extract
    // Requires FIRECRAWL_API_KEY in .env
    ...(process.env.FIRECRAWL_API_KEY ? {
      'firecrawl': {
        command: 'npx',
        args: ['-y', 'firecrawl-mcp'],
        env: {
          FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY,
        },
      },
    } : {}),

    // ── Gmail MCP Server ────────────────────────────────────────────────
    // Zastępuje ręczne gmailTools.
    // Używa wygenerowanych plików credentials/token z .env.
    ...(process.env.GOOGLE_CLIENT_ID ? {
      'gmail': {
        command: 'npx',
        args: ['-y', 'mcp-server-google-workspace'],
        env: {
          GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID!,
          GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET!,
          GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN!,
        },
      },
    } : {}),

    // n8n MCP moved to a DEDICATED client (n8nMcpClient, below) so a flaky sibling
    // MCP server cannot silently empty the n8nMcpEngineer's tool set. See WS-E.

    // ── Context7 — Up-to-date Library Documentation ──────────────────────
    // Provides current API docs for npm/pypi libraries during code generation.
    // Primary use case: codingAgent building external projects with unfamiliar stacks.
    // Not needed for self-repair (agent knows its own Mastra/zod/mongodb stack).
    // Optional CONTEXT7_API_KEY increases rate limits but is not required.
    'context7': {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      ...(process.env.CONTEXT7_API_KEY ? {
        env: {
          CONTEXT7_API_KEY: process.env.CONTEXT7_API_KEY,
        },
      } : {}),
    },
  },
});

// WS-E — DEDICATED n8n-mcp client for the n8nMcpEngineer only. Separate from the
// shared mcpClient so notebooklm/playwright/firecrawl/gmail/context7 flakiness can
// never knock out (or silently empty) the engineer's n8n discovery/validation
// tools. Standalone n8n-mcp lists its 7 tools in ~0.6s, so an isolated client is
// fast and reliable. When n8n-mcp is disabled, the server map is empty and the
// engineer falls back to local n8n skills only.
export const n8nMcpClient = new MCPClient({
  id: 'n8n-mcp-dedicated',
  timeout: 60_000,
  servers: n8nMcpEnabled ? { 'n8n-mcp': n8nMcpServer } : {},
});
