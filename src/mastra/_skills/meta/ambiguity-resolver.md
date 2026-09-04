---
name: ambiguity-resolver
category: meta
description: >-
  Decision framework for when an agent MUST ask clarifying questions
  vs when it can make reasonable assumptions. Prevents both
  "analysis paralysis" (too many questions) and "blind execution"
  (wrong assumptions). Includes checklist, decision matrix,
  and question templates.
keywords: [requirements, ambiguity, clarification, assumptions, planning, questions, task-understanding]
allowedTools: [fs_read_file, repo_map]
minComplexity: simple
recommendedTier: fast
estimatedTokens: 1050
outputFormat: text
tags: [meta, planning, requirements, task-understanding]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Ambiguity Resolver

## Trigger
- Agent receives a new task from user or orchestrator
- Task description is vague, incomplete, or contradictory
- Multiple valid interpretations exist
- Before starting any coding task (quick mental check)

## Decision Matrix: Ask vs Assume

```
                    HIGH impact if wrong
                    │
         ┌──────────┼──────────┐
         │  🔴 MUST  │  🟡 SHOULD│
HIGH     │   ASK    │   ASK    │
ambiguity│          │          │
         ├──────────┼──────────┤
         │  🟡 CAN   │  🟢 CAN   │
LOW      │  ASSUME  │  ASSUME  │
ambiguity│ (state)  │          │
         └──────────┴──────────┘
                    LOW impact if wrong
```

### 🔴 MUST ASK (High ambiguity + High impact)
- Architecture decisions (monolith vs microservice, DB choice)
- Breaking changes to existing APIs
- Security-sensitive operations (auth, payments)
- Irreversible operations (data deletion, production deploy)
- Multiple valid tech stack choices

### 🟡 SHOULD ASK (either high)
- Naming conventions when project has no standard
- UI/UX decisions when no design spec exists
- Performance requirements not specified
- Error handling strategy (fail-fast vs graceful)

### 🟢 CAN ASSUME (Low ambiguity + Low impact)
- Code formatting (follow existing project style)
- Variable naming (follow conventions)
- Import organization (follow existing patterns)
- Test file location (follow project structure)
- Comment language (follow existing code)

## Ambiguity Detection Checklist

Before starting any task, run through this checklist:

### Scope
- [ ] Is it clear WHAT files/modules to change?
- [ ] Is the desired END STATE clearly described?
- [ ] Are there BOUNDARIES (what NOT to change)?

### Technical
- [ ] Is the tech stack specified or obvious from context?
- [ ] Are external dependencies/APIs clear?
- [ ] Is the target environment clear (dev/staging/prod)?

### Behavior
- [ ] Are edge cases defined? (empty input, errors, nulls)
- [ ] Is error handling strategy clear?
- [ ] Are performance requirements stated?

### Integration
- [ ] Are other systems affected by this change?
- [ ] Is backward compatibility required?
- [ ] Are there migration steps needed?

### Verification
- [ ] Is it clear how to verify the change works?
- [ ] Are test requirements specified?
- [ ] Who approves the change?

**Scoring:**
- 0-2 unchecked → 🟢 Proceed with assumptions
- 3-5 unchecked → 🟡 State assumptions, proceed cautiously
- 6+ unchecked → 🔴 MUST ask clarifying questions

## Question Templates

### Scope Clarification
```
"I understand you want [X]. To proceed correctly, I need to clarify:
1. Should I modify only [file/module] or also [related files]?
2. Is [constraint Y] still valid?"
```

### Technical Choice
```
"For [feature X], I see two approaches:
A) [Approach A] — pros: [fast, simple]; cons: [limited]
B) [Approach B] — pros: [scalable]; cons: [complex]
Which do you prefer, or should I choose based on [criteria]?"
```

### Assumption Statement
```
"I'll proceed with these assumptions (correct me if wrong):
- [Assumption 1]
- [Assumption 2]
- [Assumption 3]"
```

## Anti-Patterns

### ❌ Analysis Paralysis
Asking 10+ questions before writing a single line.
**Fix:** Group related questions, provide default options.

### ❌ Blind Execution
Making critical assumptions without stating them.
**Fix:** Always state assumptions, even when confident.

### ❌ Assumption Cascade
One wrong assumption leads to more wrong assumptions.
**Fix:** Verify early assumptions before building on them.

### ❌ Premature Implementation
Starting coding before understanding the task.
**Fix:** 30-second checklist before any code.

## Integration with DiagnosticPlan

When the `diagnose-and-plan` phase generates a diagnostic plan:
```typescript
interface DiagnosticPlan {
  // ... existing fields ...
  assumptions: string[];           // ← State ALL assumptions
  clarificationNeeded: string[];   // ← Questions that MUST be answered
  ambiguityLevel: 'low' | 'medium' | 'high';
}
```

## Success Criteria
- Agent asks ≤ 3 questions per task (not 0, not 10)
- Critical assumptions are ALWAYS stated before coding
- Architecture decisions never assumed
- Simple formatting/style decisions never asked
