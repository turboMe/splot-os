/**
 * What `npm run check:all` actually runs, as an ordered list of script names.
 *
 * Several checks assert that they are wired into the gate — the cheapest known
 * guard against a check that exists, passes, and is run by nobody. They used to
 * pattern-match the `check:all` string in package.json directly, which pinned
 * not just the claim ("the gate runs me") but the gate's shape (a chain of
 * `&&`). The gate now delegates to `scripts/check-all.sh` so it can start the
 * replica set its durability sections need, so those guards read it from here
 * instead and keep asserting the same thing.
 */
import { readFileSync } from 'node:fs';

/** The raw definition: the delegated script's text, or the package.json chain. */
export function readGateDefinition(packageJsonPath = 'package.json'): string {
  const scripts = (JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  }).scripts ?? {};
  const checkAll = scripts['check:all'] ?? '';
  const delegated = /^bash\s+(\S+\.sh)$/.exec(checkAll.trim());
  return delegated ? readFileSync(delegated[1], 'utf8') : checkAll;
}

/** Every `npm run <name>` the gate performs, in order. */
export function readGateSteps(packageJsonPath = 'package.json'): string[] {
  return [...readGateDefinition(packageJsonPath).matchAll(/npm run (?:--silent )?([\w:.-]+)/g)]
    .map((match) => match[1]);
}

/** True when the gate runs `steps` in exactly that order, back to back. */
export function gateRunsInOrder(steps: string[], gateSteps = readGateSteps()): boolean {
  return gateSteps.some((_, i) =>
    steps.every((step, offset) => gateSteps[i + offset] === step));
}
