---
name: mcp-server-builder
description: "Use for design, build, and audit Model Context Protocol (MCP) servers with strict JSON schemas, robust error handling, and security boundaries."
category: coding
keywords:
  - mcp
  - protocol
  - integration
  - server
  - typescript
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - search_content
estimatedTokens: 264
outputFormat: typescript
tags:
  - mcp
  - integration
  - subagent-tier
version: 1
---

# Procedure: MCP Server Builder

Use this procedure (inspired by Anthropic's official `mcp-builder` skill) to implement or review Model Context Protocol servers in TypeScript/Node.js.

---

## 1. Core Architecture Requirements

1. **Strict Tool Definitions:**
   - Define all tool inputs using `zod` schemas with descriptive `.describe()` fields for every parameter.
   - Set unambiguous tool names following namespace conventions (`service_action_target`).

2. **Error Handling & Response Contract:**
   - Return structured content blocks `{ content: [{ type: "text", text: JSON.stringify(...) }] }`.
   - Never allow unhandled exceptions to crash the STDIO / SSE transport; catch errors and set `isError: true` in the response payload.

3. **Least-Privilege Security:**
   - Sanitize all path parameters to prevent directory traversal (`../`).
   - Guard destructive tools behind confirmation flags or approval gates.

---

## 2. Output Contract
Return a complete, production-ready MCP tool implementation file adhering to `@modelcontextprotocol/sdk`.
