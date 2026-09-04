---
name: series-architect
description: Complete multi-book series planning, cross-book continuity engine, and arc tracking
author: Writing Secrets
version: 1.0.0
triggers:
  - "plan series"
  - "series architect"
  - "multi-book"
  - "series outline"
  - "cross-book"
  - "book series"
permissions:
  - file:read
  - file:write
---

# Series Architect — Premium Skill

The complete system for planning, tracking, and maintaining multi-book series.

## Series Planning Wizard

Interactive step-by-step series creation:

### Step 1: Series Concept
- Series premise (the overarching "what if")
- Genre and subgenre
- Target audience
- Planned number of books
- Series type: sequential, standalone-connected, or anthology

### Step 2: Series Arc Design
```
Book 1: [Setup + Personal Stakes]
  └─ Series Question Introduced
Book 2: [Escalation + Broader Stakes]
  └─ Series Question Complicated
Book 3: [Crisis + Maximum Stakes]
  └─ Series Question Challenged
Book N: [Resolution + Transformation]
  └─ Series Question Answered
```

### Step 3: Character Arc Mapping
For each major character across all books:
```yaml
character: "Elena Voss"
arc_type: "redemption"
book_1:
  state: "Bitter former detective, drinking problem"
  change: "Forced to care about one case"
  end: "Sober enough to see the truth"
book_2:
  state: "Reluctantly sober, haunted by Book 1 ending"
  change: "Discovers the conspiracy goes deeper"
  end: "Loses someone she shouldn't have let herself love"
book_3:
  state: "Nothing left to lose, dangerous clarity"
  change: "Final confrontation forces her to choose"
  end: "Transformed — not redeemed, but honest"
```

### Step 4: World Evolution Tracker
How the story world changes across books:
- Political/power shifts
- Relationship webs (who knows what, who trusts whom)
- Technology/magic system evolution
- Geography changes
- New factions/groups introduced

### Step 5: Thread Tracker
Every open plot thread tracked with:
- **Planted in**: Book/Chapter
- **Status**: Open / Developing / Resolved
- **Resolves in**: Planned book/chapter
- **Dependencies**: What else needs to happen first

### Step 6: Continuity Rules Engine
Automated checks when writing any scene:
- Character age math (are ages consistent with timeline?)
- Physical state carryover (injuries, scars, changes)
- Relationship status (matches end of previous book?)
- World state (matches established facts?)
- Object tracking (where is the MacGuffin right now?)
- Knowledge tracking (who knows what secret?)

## Pre-Built Series Templates

### The Trilogy
- Book 1: Discovery + Personal Stakes
- Book 2: Deepening + Expanding Stakes + Darkest Hour
- Book 3: Resolution + Transformation

### The Five-Book Series
- Book 1: Introduction + Hook
- Book 2: Expansion + Complications
- Book 3: Midpoint Crisis
- Book 4: Dark Night + Escalation
- Book 5: Final Battle + Resolution

### Standalone-Connected (Romance/Mystery)
- Shared world, different protagonists
- Each book complete, references enrich others
- Series arc through worldbuilding, not plot

### The Duology
- Book 1: Setup + Shattering Midpoint (ends on devastation)
- Book 2: Rebuild + Final Confrontation + Resolution

## Revenue Planning Module

For indie authors planning a series:
- **Book 1 pricing strategy** (permafree, 99¢, full price)
- **Series read-through rate estimates** by genre
- **Launch timing** between books
- **Pre-order strategy**
- **Bundle pricing** once complete
- **Revenue projection** based on genre averages

## Output Files
```
workspace/memory/book-bible/[series]/
├── series-overview.md          # Master plan
├── series-arc.md              # Overarching arc
├── character-arcs/            # Per-character arc maps
├── thread-tracker.md          # All open/resolved threads
├── world-evolution.md         # How the world changes
├── continuity-rules.md        # Auto-check rules
├── per-book/                  # Individual book outlines
│   ├── book-1-outline.md
│   ├── book-2-outline.md
│   └── ...
└── revenue-plan.md            # Business side
```
