/**
 * Runtime feature flags for the chef agent.
 *
 * Flags are read at call time (not cached at module load) so local runs, tests and
 * scripts can flip process.env before invoking a flag-gated path. Mirrors the
 * parse semantics of config/harness-flags.ts.
 */

function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '') return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

/**
 * Molecular flavor-pairing layer (FlavorDB).
 *
 * When ON:
 *   - chef_score_pairing / chef_suggest_pairings tools are registered on the agent.
 *   - chef_generate_menu computes and injects a `flavorAudit` block.
 * When OFF (default): the chef uses only qualitative domain.md + NotebookLM reasoning.
 *
 * The offline data scripts (load-flavordb / build-flavor-aliases / enrich-recipe-flavor)
 * ignore this flag — they only populate Mongo. This gates RUNTIME consumption, enabling a
 * clean A/B (flip env, restart) without re-importing data.
 *
 * NOTE: agent tool registration reads this ONCE at module load (agents/chef-agent.ts),
 * so a change requires a restart to take effect. The flavorAudit path is read per call.
 */
export function isFlavorPairingEnabled(): boolean {
  return parseBooleanEnv(process.env.CHEF_FLAVOR_PAIRING_ENABLED, false);
}
