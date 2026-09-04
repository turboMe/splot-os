---
name: query-letter
description: Craft compelling query letters and track submissions to literary agents
author: AuthorClaw
version: 1.0.0
triggers:
  - "query letter"
  - "agent submission"
  - "pitch my book"
  - "query tracker"
permissions:
  - file:read
  - file:write
  - network:http
---

# Query Letter Skill

Help authors write query letters that get requests from literary agents.

## Query Letter Structure (250-400 words total)

### 1. Hook (1-2 sentences)
Your strongest logline. Make the agent NEED to know more.

### 2. Story Summary (150-200 words)
- Introduce protagonist with a defining trait
- What's their normal world?
- What disrupts it? (inciting incident)
- What must they do? (goal)
- What stands in their way? (conflict)
- What's at stake? (consequences of failure)
- END before the climax — leave them wanting more

### 3. Metadata (1-2 sentences)
"[TITLE] is a [genre] complete at [word count], with series potential / standalone."
Add comp titles: "It will appeal to fans of [COMP 1] meets [COMP 2]."

### 4. Bio (2-3 sentences)
Relevant credentials only. Writing awards, relevant expertise, platform.
If no credentials: skip or keep to one sentence.

### 5. Closing
"Thank you for your time and consideration. Per your submission guidelines, I've included [pages/chapters]. The full manuscript is available upon request."

## Submission Tracker
Track: Agent name, agency, date sent, status, response, notes.
Save to project's `submissions/tracker.md`

## Personalization
- Reference a specific book the agent represented
- Mention meeting them at a conference
- Note why your book fits their wishlist
