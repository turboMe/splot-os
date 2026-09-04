---
name: n8n-expression-syntax
category: n8n
description: n8n expression syntax patterns - accessing data, transformations, and common patterns
keywords: [n8n, expressions, syntax, json, variables, data, transform]
recommendedTier: balanced
handoffCapable: true
---
# n8n Expression Syntax Reference

## Basic Access Patterns

| Pattern | Description |
|---------|-------------|
| `={{ $json.field }}` | Current item's field |
| `={{ $json['field-with-dash'] }}` | Bracket notation for special chars |
| `={{ $json.nested.deep.field }}` | Nested field access |
| `={{ $json.array[0] }}` | Array index access |

## Cross-Node References

| Pattern | Description |
|---------|-------------|
| `={{ $('Node Name').item.json.field }}` | Specific node output |
| `={{ $('Node Name').first().json.field }}` | First item from node |
| `={{ $('Node Name').last().json.field }}` | Last item from node |
| `={{ $('Node Name').all() }}` | All items from node |
| `={{ $input.item.json.field }}` | Current input item |
| `={{ $input.all() }}` | All input items |

## Environment & Metadata

| Pattern | Description |
|---------|-------------|
| `={{ $execution.id }}` | Current execution ID (use instead of $vars) |
| `={{ $execution.id }}` | Current execution ID |
| `={{ $workflow.id }}` | Current workflow ID |
| `={{ $now.toISO() }}` | Current ISO timestamp |
| `={{ $now.toFormat('yyyy-MM-dd') }}` | Formatted date |
| `={{ $runIndex }}` | Current run index |
| `={{ $itemIndex }}` | Current item index |

## String Operations

```
={{ $json.name.toUpperCase() }}
={{ $json.text.slice(0, 100) }}
={{ $json.email.includes('@') }}
={{ $json.tags.join(', ') }}
={{ `Hello ${$json.name}, your order #${$json.orderId}` }}
```

## Conditional Expressions

```
={{ $json.status === 'active' ? 'Yes' : 'No' }}
={{ $json.score > 80 ? 'high' : $json.score > 50 ? 'medium' : 'low' }}
={{ $json.email || 'no-email@example.com' }}
```

## JSON Operations

```
={{ JSON.stringify($json) }}
={{ JSON.parse($json.rawString) }}
={{ Object.keys($json).length }}
={{ JSON.stringify($json).slice(0, 5000) }}
```

## Common Patterns for AgentForge

### Ollama HTTP Request Body
Note: URL and model name are hardcoded at workflow generation time (no $vars needed).
```
={{ JSON.stringify({
  model: 'gemma4:26b',
  stream: false,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: $json.text.slice(0, 5000) }
  ]
}) }}
```

### Telegram Message Format
```
={{ `*${$json.title}*\n\n${$json.summary}\n\n_Source: ${$json.url}_` }}
```

### AgentForge API Payload
```
={{ JSON.stringify({
  type: 'webhook_event',
  source: $workflow.id,
  data: $json,
  timestamp: $now.toISO()
}) }}
```
