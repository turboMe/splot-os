---
name: n8n-common-patterns
category: n8n
description: Common n8n workflow architecture patterns - trigger-process-output, branching, error handling
keywords: [n8n, patterns, architecture, trigger, branching, error, webhook, schedule]
recommendedTier: pro
handoffCapable: true
---
# Common n8n Workflow Patterns

## Pattern 1: Trigger -> Process -> Output (Linear)

The simplest and most common pattern. Data flows in a straight line.

```
[Webhook] -> [Code: Transform] -> [Telegram Send]
[Schedule] -> [HTTP Request: Fetch] -> [Code: Filter] -> [Telegram Send]
```

Use when: single data source, single destination, simple transformations.

## Pattern 2: Trigger -> Branch -> Multiple Outputs

IF or Switch node routes data to different destinations.

```
[Webhook] -> [IF: Check Type] -> TRUE: [Telegram Send]
                               -> FALSE: [MongoDB Save]
```

```
[Schedule] -> [HTTP: Fetch] -> [Switch: Route by Category]
                                -> Case 1: [Telegram Channel A]
                                -> Case 2: [Telegram Channel B]
                                -> Default: [Log to Memory]
```

Use when: different actions needed based on data content.

## Pattern 3: Trigger -> Enrich -> Decide -> Act

Multi-step processing with LLM enrichment before action.

```
[Webhook: Lead] -> [Code: Extract] -> [Ollama: Classify] -> [IF: Score > 70]
                                                              -> TRUE: [CRM: Create Lead]
                                                              -> FALSE: [Log: Low Quality]
```

Use when: incoming data needs AI classification before routing.

## Pattern 4: Schedule -> Fetch -> Dedup -> Alert

Periodic monitoring with deduplication to prevent spam.

```
[Schedule: Every 30min] -> [RSS Read] -> [Code: Filter Keywords]
                                       -> [Code: Dedup Check]
                                       -> [IF: New Items] -> [Telegram: Alert]
```

Key: Use workflow static data or MongoDB for dedup state.

## Pattern 5: Error Workflow

Separate workflow triggered when another workflow fails.

```
[Error Trigger] -> [Code: Format Error] -> [Telegram: Alert Admin]
                                         -> [Memory: Save Error]
```

Set via `settings.errorWorkflow` in the main workflow.

## Pattern 6: Webhook -> Validate -> Respond

Webhook with immediate response and async processing.

```
[Webhook] -> [Code: Validate Input] -> [IF: Valid]
                                         -> TRUE: [Respond: 200 OK] -> [Process Async]
                                         -> FALSE: [Respond: 400 Error]
```

Key: Use "Respond to Webhook" node for immediate response.

## Pattern 7: Batch Processing

Process multiple items from a single trigger.

```
[Schedule] -> [MongoDB: Read Batch] -> [SplitInBatches: 10 per batch]
                                      -> [Ollama: Process Each]
                                      -> [MongoDB: Save Results]
```

Key: Use SplitInBatches to control concurrency and avoid overload.

## Node Positioning Guidelines

- Start trigger at position `[250, 300]`
- Increment X by 250-300 for each subsequent node
- Keep Y consistent at 300 for linear flows
- Branch nodes: offset Y by +/- 150 for visual clarity
