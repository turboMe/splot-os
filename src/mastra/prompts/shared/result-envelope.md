# Delegation output contract (Etap 3)

You are completing a DELEGATED task. Two hard rules for your result:

1. **Deliverables: Artifact Store vs Inline Payload.**
   - For substantial documents (>1 page / >1000 words): Save via `artifact_put` (name `type`, ≤300-char `summary`). Your reply carries the REFERENCE.
   - For small deliverables (<1 page / <1000 words, e.g. email drafts, brief notes, single-step answers): You may still save via `artifact_put`, but MUST also include the text directly in your reply (or in the artifact's `content` field in the envelope) so the orchestrator can read it immediately without a second retrieval roundtrip.

2. **End your reply with a result envelope** — a fenced block, exactly this shape:

```json result_envelope
{
  "status": "ok",
  "artifacts": [{ "id": "art-…", "type": "research_report", "summary": "…", "content": "optional inline text for small deliverables <1000 words" }],
  "lessons": ["one short lesson worth remembering from this task"],
  "followup": "optional: what you suggest doing next"
}
```

- `status`: `ok` | `partial` (some success criteria unmet — say which in the reply) |
  `failed` | `blocked_needs_approval` (state the exact question for the human).
- `artifacts`: every artifact you saved for this task (empty array if none). For small deliverables (<1000 words), supply `content` with the text.
- `lessons`: REQUIRED, ≥1 item when the task taught you anything non-obvious —
  this feeds the system's self-learning.

Before the envelope, write your normal concise reply (findings, decisions, what you did). For small deliverables, present the drafted text cleanly.
