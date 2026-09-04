---
name: test-generator
category: coding
description: Generate unit and integration tests from existing source code. Scaffolds test files with edge cases, mocks, and assertions for Vitest, Jest, or Pytest. Use when agent needs to add test coverage to untested code or create test suites for new functionality.
keywords: [test, unit-test, vitest, jest, pytest, testing, mock, coverage, tdd]
allowedTools: [fs_read_file, coding_write_file_tracked, shell_execute]
minComplexity: moderate
recommendedTier: pro
estimatedTokens: 1500
outputFormat: patch
tags: [coding, testing, quality, tdd]
version: 1
success_rate: 0
total_uses: 6
last_used: 2026-08-23
handoffCapable: true
---
# Test Generator

## Trigger
Agent needs to add test coverage to untested code, scaffold test suites for
new functionality, or create regression tests for bug fixes.

## Procedure

### Step 1: Analyze the source code
Read the target file(s) and extract:
- **Exports:** Functions, classes, constants that need tests
- **Dependencies:** External modules, services, APIs that need mocking
- **Side effects:** File I/O, network calls, database queries
- **Edge cases:** Null/undefined inputs, empty arrays, boundary values, error paths
- **Types:** Input/output types for type-safe assertions

### Step 2: Determine test framework

**Detection heuristic:**
1. Check `package.json` for test runner:
   - `vitest` in devDependencies → **Vitest**
   - `jest` in devDependencies → **Jest**
   - `pytest` in requirements → **Pytest**
2. Check for existing test files: `*.test.ts`, `*.spec.ts`, `*.test.py`
3. Check for config files: `vitest.config.ts`, `jest.config.js`, `pytest.ini`

**If no framework detected:** Default to Vitest for TS/JS, Pytest for Python.

### Step 3: Determine test file placement

**Convention detection:**
```bash
# Check existing test locations
find . -name "*.test.*" -o -name "*.spec.*" | head -10
```

**Common patterns:**
| Convention | Test file location |
|------------|-------------------|
| Co-located | `src/services/auth.test.ts` (next to source) |
| `__tests__/` | `src/services/__tests__/auth.test.ts` |
| Top-level `tests/` | `tests/services/auth.test.ts` |
| Mirror structure | `test/services/auth.test.ts` |

**Rule:** Match the existing project convention. If none exists, use co-located.

### Step 4: Generate test structure

**Vitest / Jest template:**
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// or: import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

import { targetFunction } from '../target-module.js';

// Mock external dependencies
vi.mock('../services/database.js', () => ({
  query: vi.fn(),
}));

describe('targetFunction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Happy path
  it('should return expected result for valid input', () => {
    const result = targetFunction({ id: 1, name: 'test' });
    expect(result).toEqual({ success: true, data: expect.any(Object) });
  });

  // Edge cases
  it('should handle null input gracefully', () => {
    expect(() => targetFunction(null)).toThrow('Input required');
  });

  it('should handle empty string', () => {
    const result = targetFunction({ id: 1, name: '' });
    expect(result.data.name).toBe('');
  });

  // Boundary values
  it('should handle maximum allowed value', () => {
    const result = targetFunction({ id: Number.MAX_SAFE_INTEGER, name: 'test' });
    expect(result.success).toBe(true);
  });

  // Error paths
  it('should propagate database errors', async () => {
    const { query } = await import('../services/database.js');
    (query as any).mockRejectedValueOnce(new Error('Connection lost'));

    await expect(targetFunction({ id: 1 })).rejects.toThrow('Connection lost');
  });
});
```

**Pytest template:**
```python
import pytest
from unittest.mock import patch, MagicMock
from module.target import target_function

class TestTargetFunction:
    def test_valid_input(self):
        result = target_function({"id": 1, "name": "test"})
        assert result["success"] is True

    def test_none_input(self):
        with pytest.raises(ValueError, match="Input required"):
            target_function(None)

    def test_empty_string(self):
        result = target_function({"id": 1, "name": ""})
        assert result["data"]["name"] == ""

    @patch("module.target.database.query")
    def test_database_error(self, mock_query):
        mock_query.side_effect = ConnectionError("Connection lost")
        with pytest.raises(ConnectionError):
            target_function({"id": 1})

    @pytest.fixture(autouse=True)
    def setup(self):
        """Reset state before each test."""
        yield
        # cleanup if needed
```

### Step 5: Apply test generation rules

**Coverage priorities (in order):**
1. **Public API** — every exported function/method
2. **Error paths** — every throw/reject/raise
3. **Boundary values** — 0, 1, -1, empty, max, null, undefined
4. **Branch coverage** — every if/else, switch case
5. **Integration points** — mocked external calls verified

**Mock strategy:**
- Mock I/O (database, filesystem, network) — always
- Mock time-dependent operations — always
- Mock heavy computation — if slow
- Don't mock the unit under test — never
- Don't mock simple utilities — unnecessary complexity

**Assertion patterns:**
| What to check | Assertion |
|---------------|-----------|
| Return value | `expect(result).toEqual(expected)` |
| Thrown error | `expect(() => fn()).toThrow(message)` |
| Async rejection | `await expect(fn()).rejects.toThrow()` |
| Mock called | `expect(mock).toHaveBeenCalledWith(args)` |
| Mock call count | `expect(mock).toHaveBeenCalledTimes(1)` |
| Type check | `expect(typeof result).toBe('string')` |
| Array contains | `expect(arr).toContain(item)` |
| Object shape | `expect(obj).toMatchObject({ key: value })` |

### Step 6: Verify tests pass

```bash
# Vitest
npx vitest run path/to/test.test.ts

# Jest
npx jest path/to/test.test.ts

# Pytest
python -m pytest tests/test_module.py -v

# Coverage check
npx vitest run --coverage path/to/test.test.ts
```

**If tests fail:**
1. Check if source code has changed since analysis
2. Verify mock setup matches actual module structure
3. Check import paths (ESM `.js` extensions in TS projects)
4. Verify test framework configuration

## Success criteria
- All generated tests pass on first run
- Each exported function has at least one happy-path and one error-path test
- Mocks are minimal and correctly reset between tests
- Test file follows project conventions (placement, naming, framework)
- No flaky tests (deterministic, no time-dependent assertions without mocking)
