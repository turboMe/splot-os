---
name: ws-workflow-engine-bridge
description: Import and execute Author Workflow Engine prompt sequences inside AuthorClaw
author: Writing Secrets
version: 1.0.0
triggers:
  - "import workflow"
  - "run workflow"
  - "workflow engine"
  - "prompt sequence"
  - "automation"
  - "load workflow"
  - "execute sequence"
permissions:
  - file:read
  - file:write
---

# Author Workflow Engine Bridge

Import prompt sequence JSON files from the Author Workflow Engine and execute them as AuthorClaw automations.

## What This Does

The Author Workflow Engine (AWE) lets you build multi-step prompt chains — like "research → premise → outline → write chapter 1." This bridge imports those chains and runs them inside AuthorClaw with full access to your book bible, voice profile, and memory.

## JSON Schema Expected

```json
{
  "name": "Novel Outline Generator",
  "description": "Takes a premise and generates a complete outline",
  "version": "1.0",
  "steps": [
    {
      "id": "step-1",
      "name": "Premise Refinement",
      "prompt": "Take this premise and refine it: {{INPUT}}. Make the stakes personal and the conflict built-in.",
      "model": "auto",
      "temperature": 0.7,
      "outputVariable": "refined_premise"
    },
    {
      "id": "step-2",
      "name": "Character Development",
      "prompt": "Based on this premise: {{refined_premise}}\n\nCreate 3-5 main characters with names, roles, motivations, and flaws.",
      "model": "auto",
      "temperature": 0.8,
      "outputVariable": "characters"
    },
    {
      "id": "step-3",
      "name": "Three-Act Outline",
      "prompt": "Premise: {{refined_premise}}\nCharacters: {{characters}}\n\nCreate a detailed three-act outline with chapter breakdowns.",
      "model": "auto",
      "temperature": 0.7,
      "outputVariable": "outline"
    }
  ],
  "variables": {
    "INPUT": { "type": "user_input", "prompt": "Enter your story premise:" }
  }
}
```

## Execution Process

1. **Import**: Load AWE JSON into AuthorClaw's automation engine
2. **Enhance**: Automatically inject AuthorClaw context into each step:
   - Book Bible data (characters, locations, timeline)
   - Voice Profile (so output matches author's style)
   - Style Guide rules
   - Active project context
3. **Execute**: Run steps sequentially, passing output variables between steps
4. **Route**: Use AuthorClaw's smart AI routing per step:
   - `"model": "auto"` → Let AuthorClaw pick the best provider
   - `"model": "creative"` → Route to Claude or GPT-4o
   - `"model": "fast"` → Route to Ollama or Gemini
   - `"model": "cheap"` → Route to DeepSeek
5. **Save**: Store all outputs in the project workspace
6. **Review**: Present results with option to re-run any step

## Enhanced Workflow Templates (Pre-Built)

### Novel-in-a-Weekend
6-step sequence: Premise → Characters → Outline → Chapter 1 → Chapter 2 → Review

### Blog Post Factory
4-step: Topic Research → Outline → Draft → SEO Optimization

### Query Letter Builder
5-step: Manuscript Analysis → Hook → Summary → Bio → Final Polish

### Series Bible Generator
7-step: Series Arc → Book Breakdowns → Character Arcs → World Evolution → Continuity Checklist → Timeline → Series Bible Document

## Commands
- `import workflow from [path]` — Load AWE JSON
- `list workflows` — Show available imported workflows
- `run [workflow name]` — Execute a workflow
- `run [workflow name] from step [N]` — Resume from a specific step
- `show workflow output` — Display results of last run
- `export workflow results` — Save outputs to project files
