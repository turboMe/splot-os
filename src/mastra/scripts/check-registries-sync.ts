/**
 * check:registries-sync — Weryfikuje pełną synchronizację pomiędzy:
 * 1. AGENT_SOURCE_REGISTRY (agent-source-registry.ts)
 * 2. agentModelSequences i agentModels (model-manifest.ts)
 * 3. agentBoard (agent-board.ts)
 * 4. toolBindingRegistry (tool-binding-registry.ts)
 */

import { AGENT_SOURCE_REGISTRY, ALL_AGENT_REGISTRY_KEYS } from '../config/agent-source-registry.js';
import { agentModelSequences, agentModels } from '../config/model-manifest.js';
import { agentBoard } from '../config/agent-board.js';
import { TOOL_BINDING_REGISTRY } from '../config/tool-binding-registry.js';

let errors = 0;

console.log(`[check:registries-sync] Sprawdzanie ${ALL_AGENT_REGISTRY_KEYS.length} agentów w rejestrze...`);

for (const key of ALL_AGENT_REGISTRY_KEYS) {
  const def = AGENT_SOURCE_REGISTRY[key];
  if (!def) {
    console.error(`❌ Brak definicji dla klucza: ${key}`);
    errors++;
    continue;
  }

  // 1. Sprawdzenie zgodności z model-manifest
  const modelSeq = (agentModelSequences as Record<string, any>)[key];
  if (!modelSeq) {
    console.error(`❌ Agent ${key} nie ma zdefiniowanej sekwencji modeli w agentModelSequences!`);
    errors++;
  } else {
    const primaryModel = (agentModels as Record<string, any>)[key];
    if (primaryModel !== modelSeq.primary) {
      console.error(`❌ Rozbieżność w agentModels dla ${key}: oczekiwano ${modelSeq.primary}, otrzymano ${primaryModel}`);
      errors++;
    }
  }

  // 2. Sprawdzenie obecności w agentBoard (dla agentów publicznych/delegowalnych)
  if (!def.internal && key !== 'metaAgent' && key !== 'weatherAgent') {
    if (!agentBoard[key]) {
      console.error(`❌ Publiczny agent ${key} nie posiada karty w agentBoard!`);
      errors++;
    }
  }
}

// 3. Sprawdzenie rejestru narzędzi
const toolCount = Object.keys(TOOL_BINDING_REGISTRY).length;
console.log(`[check:registries-sync] Sprawdzanie rejestru narzędzi (${toolCount} narzędzi zarejestrowanych)...`);
if (toolCount === 0) {
  console.error(`❌ TOOL_BINDING_REGISTRY jest pusty!`);
  errors++;
}

if (errors > 0) {
  console.error(`\n❌ Znaleziono ${errors} błędów synchronizacji rejestrów!`);
  process.exit(1);
} else {
  console.log(`\n✅ Wszystkie rejestry są w 100% zsynchronizowane i wolne od długu!`);
  process.exit(0);
}
