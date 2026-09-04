---
name: openapi-to-mcp-converter
description: Convert raw OpenAPI 3.x / Swagger JSON specifications into production-grade Mastra and Model Context Protocol (MCP) tool definitions.
category: coding
keywords:
  - openapi
  - swagger
  - mcp
  - mastra
  - tools
  - typescript
minComplexity: complex
recommendedTier: pro
allowedTools:
  - view
  - coding.write_file_tracked
  - search_content
estimatedTokens: 284
outputFormat: typescript
tags:
  - mcp
  - openapi
  - subagent-tier
version: 1
---

# Procedure: OpenAPI / Swagger to Mastra & MCP Tool Converter

Use this procedure to parse OpenAPI / Swagger JSON or YAML endpoint specs and automatically generate type-safe Mastra tools (`createTool`) and MCP server handlers.

---

## 1. Conversion Rules

1. **Parameter to Zod Schema Mapping:**
   - Map query, path, and body parameters to strictly typed `z.object({})`.
   - Extract parameter `description` and `example` directly into Zod `.describe()`.
   - Map `required: true` properties and set optional fields with `.optional()`.

2. **Execution & Fetch Wrapper:**
   - Construct robust `fetch` calls injecting `baseUrl`, auth headers (`Bearer token` or `apiKey`), query string serialization, and JSON body payloads.
   - Wrap in `try/catch`, returning structured error objects `{ isError: true, status, error: error.message }` upon HTTP failure.

3. **Mastra Tool Output Format:**
   - Generate standard Mastra `createTool({ id, description, inputSchema, outputSchema, execute })`.

---

## 2. Output Contract
Return the complete TypeScript file containing the converted Mastra / MCP tool definitions ready for registration.
