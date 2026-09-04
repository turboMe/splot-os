---
name: ws-book-bible-bridge
description: Import and sync Book Bible Engine JSON data into AuthorClaw's memory system
author: Writing Secrets
version: 1.0.0
triggers:
  - "import book bible"
  - "sync book bible"
  - "load bible"
  - "import characters"
  - "import locations"
  - "bible json"
  - "book bible engine"
permissions:
  - file:read
  - file:write
---

# Book Bible Engine Bridge

Seamlessly import data from Writing Secrets' Book Bible Engine into AuthorClaw's memory system.

## Supported Import Formats

This skill reads the JSON export from Book Bible Engine and maps it directly into AuthorClaw's book-bible memory structure.

## JSON Schema Expected

```json
{
  "title": "Book Title",
  "characters": [
    {
      "name": "Sarah Chen",
      "description": "...",
      "gender": "female",
      "age": "32",
      "hairColor": "black",
      "eyeColor": "brown",
      "traits": ["determined", "analytical", "secretly kind"],
      "relationships": [
        { "character": "Marcus", "type": "partner", "description": "..." }
      ],
      "firstAppearance": "Chapter 1",
      "arc": "From isolated researcher to reluctant leader"
    }
  ],
  "locations": [
    {
      "name": "The Compound",
      "description": "...",
      "significance": "Main setting for Acts 1-2"
    }
  ],
  "timeline": [
    {
      "event": "The Incident",
      "chapter": "Prologue",
      "date": "March 15, 2024",
      "characters": ["Sarah", "Marcus"]
    }
  ],
  "plotPoints": [...],
  "themes": [...],
  "ahaMoments": [...]
}
```

## Import Process

1. User provides path to Book Bible JSON export OR pastes JSON
2. Validate the JSON structure
3. Map each entity type to AuthorClaw's book-bible format:
   - `characters` → `workspace/memory/book-bible/[project]/characters/[name].md`
   - `locations` → `workspace/memory/book-bible/[project]/locations/[name].md`
   - `timeline` → `workspace/memory/book-bible/[project]/timeline.md`
   - `plotPoints` → `workspace/memory/book-bible/[project]/plot-points.md`
   - `themes` → `workspace/memory/book-bible/[project]/themes.md`
   - `ahaMoments` → `workspace/memory/book-bible/[project]/aha-moments.md`
4. Confirm successful import with summary

## Character Markdown Template

For each imported character, generate:

```markdown
# [Character Name]

## Physical Description
- **Gender**: [gender]
- **Age**: [age]
- **Hair**: [hairColor]
- **Eyes**: [eyeColor]
- **Description**: [description]

## Personality
- **Traits**: [comma-separated traits]
- **Speech Pattern**: [extracted or "Not yet analyzed"]
- **Quirks**: [extracted or "Not yet defined"]

## Relationships
[For each relationship:]
- **[character]** ([type]): [description]

## Story Role
- **First Appearance**: [chapter]
- **Character Arc**: [arc]
- **Current Status**: Active

## Consistency Notes
[Any contradictions or notes from the Bible Engine import]
```

## Two-Way Sync

When the author makes changes in AuthorClaw's book bible:
1. Track all modifications with timestamps
2. On "export to Book Bible Engine" command, generate updated JSON
3. This allows round-tripping between both tools

## Commands
- `import book bible from [path]` — Import JSON file
- `export to book bible` — Generate JSON for Book Bible Engine
- `sync status` — Show what's changed since last import/export
- `show imported data` — Summary of all imported entities
