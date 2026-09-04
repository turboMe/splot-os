import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const basePrompt = readFileSync('src/mastra/prompts/meta/base.md', 'utf8');
const responsePrompt = readFileSync('src/mastra/prompts/meta/response.md', 'utf8');

assert.match(basePrompt, /Delegation Result Accounting/);
assert.match(basePrompt, /success: false/);
assert.match(basePrompt, /partial failure/);
assert.match(basePrompt, /the final answer must contain the report now/);
assert.match(basePrompt, /delegations performed and their exact success\/error status/);
assert.match(basePrompt, /final pass\/fail\/partial-pass verdict/);

assert.match(responsePrompt, /success:false/);
assert.match(responsePrompt, /częściowy błąd albo częściowe powodzenie/);
assert.match(responsePrompt, /odpowiedź musi zawierać gotowy raport teraz/);
assert.match(responsePrompt, /nie jako pełny sukces/);

console.log('Meta final synthesis prompt checks passed.');
process.exit(0);
