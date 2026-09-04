---
name: prompt-tester
category: meta
description: >-
  Systematically evaluate LLM prompt quality through structured testing.
  Compare prompt variations, score outputs on consistency/accuracy/format,
  detect regressions, and optimize token efficiency. Use when developing,
  refining, or auditing prompts for agentic workflows.
keywords: [prompt, testing, evaluation, llm, quality, regression, scoring, optimization]
allowedTools: [shell_execute, fs_read_file, fs_write_file]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1100
outputFormat: text
tags: [meta, prompt-engineering, evaluation, quality]
version: 1
success_rate: null
total_uses: 0
last_used: null
handoffCapable: true
---
# Prompt Tester

## Trigger
Agent is developing, refining, or auditing LLM prompts and needs systematic
evaluation of prompt quality, regression detection, or A/B comparison.

## Procedure

### Step 1: Define test cases

Create a test matrix with:
- **Input variations:** Different user queries that should activate the prompt
- **Expected behaviors:** What the output must contain/avoid
- **Edge cases:** Adversarial inputs, ambiguous queries, multilingual inputs
- **Regression anchors:** Known-good outputs from previous prompt versions

**Test case template:**
```json
{
  "test_id": "TC001",
  "input": "User query or context",
  "expected": {
    "must_contain": ["key phrase", "required element"],
    "must_not_contain": ["hallucination", "forbidden action"],
    "format": "json|markdown|text",
    "max_tokens": 500,
    "tone": "professional|casual|technical"
  },
  "category": "happy_path|edge_case|adversarial|regression"
}
```

### Step 2: Define scoring rubric

**Standard dimensions (score 1-5):**

| Dimension | 1 (Fail) | 3 (Acceptable) | 5 (Excellent) |
|-----------|----------|-----------------|---------------|
| **Accuracy** | Factually wrong | Mostly correct | Precisely correct |
| **Relevance** | Off-topic | Addresses query | Directly answers with context |
| **Format** | Wrong format | Correct but messy | Clean, structured output |
| **Completeness** | Missing key info | Covers basics | Comprehensive coverage |
| **Safety** | Violates rules | No violations | Actively enforces boundaries |
| **Token efficiency** | Verbose/repetitive | Reasonable length | Concise, no waste |

**Weighted scoring formula:**
```
score = (accuracy × 0.30) + (relevance × 0.25) + (format × 0.15)
       + (completeness × 0.15) + (safety × 0.10) + (efficiency × 0.05)
```

### Step 3: Run evaluation

**Single prompt test:**
1. Send the prompt + test input to the model
2. Capture the full output
3. Score against rubric dimensions
4. Record: input, output, scores, notes

**A/B comparison:**
1. Run same test cases against Prompt A and Prompt B
2. Score both outputs independently
3. Compare aggregated scores
4. Note specific cases where one outperforms the other

**Consistency test (same input, multiple runs):**
1. Run the same input 3-5 times
2. Compare outputs for semantic consistency
3. Flag high variance as instability indicator
4. Calculate consistency score: `1 - (variance / max_possible_variance)`

### Step 4: Analyze results

**Aggregation:**
```
Overall Score:  4.2 / 5.0
Accuracy:       4.5 (strong)
Relevance:      4.3 (strong)
Format:         4.0 (good)
Completeness:   3.8 (needs improvement)
Safety:         5.0 (excellent)
Efficiency:     3.5 (could be more concise)

Test Results:   12/15 passed (80%)
Failed cases:   TC007 (edge case), TC011 (adversarial), TC014 (multilingual)
```

**Regression detection:**
Compare current scores against baseline:
- Score drop > 0.5 on any dimension → **REGRESSION**
- New test case failure → **REGRESSION**
- Score improvement > 0.3 → **IMPROVEMENT**

### Step 5: Token efficiency analysis

```
Prompt token count:     850 tokens
Average output tokens:  320 tokens
Total per-call cost:    1,170 tokens

Optimization opportunities:
- Remove redundant instruction X (saves ~60 tokens)
- Consolidate rules Y and Z (saves ~40 tokens)
- Replace verbose examples with concise patterns (saves ~120 tokens)
```

**Token reduction strategies:**
1. Remove repeated instructions (models remember from first mention)
2. Use structured formats over prose ("Do X. Do Y." vs paragraphs)
3. Replace examples with patterns (one good example > three mediocre ones)
4. Move stable context to system prompt (reused across calls)
5. Use reference IDs instead of inline content for large documents

### Step 6: Report findings

**Report structure:**
1. **Summary:** Overall quality score, pass/fail rate, regression status
2. **Dimension breakdown:** Per-dimension scores with trends
3. **Failed cases:** Each failure with input, expected, actual, root cause
4. **Recommendations:** Specific prompt changes with expected impact
5. **Token analysis:** Current cost and optimization opportunities

## Success criteria
- All test cases executed and scored
- Scoring rubric applied consistently across all dimensions
- Regressions detected with specific failing cases identified
- Token efficiency quantified with actionable optimization suggestions
- A/B comparisons include statistical significance indicators (N≥5 runs)
