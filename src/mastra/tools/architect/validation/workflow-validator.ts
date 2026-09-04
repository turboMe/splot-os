import {
  ValidationFinding,
  ValidationResult,
  MissingCredential,
  MissingConfig,
  WorkflowGraphComponent,
} from './validation-types.js';
import {
  FORBIDDEN_NODE_TYPES,
  KNOWN_NODE_TYPES,
  NON_ACTIVATABLE_TRIGGER_TYPES,
  TRIGGER_TYPES,
  getKnownTypeVersions,
} from './node-registry.js';
import { getRuntimeTopology } from '../../../config/runtime-topology.js';

const DANGEROUS_CODE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\$helpers\.executeCommand(?:Sync)?\s*\(/, message: 'Uses $helpers.executeCommand* in code/function node' },
  { pattern: /\beval\s*\(/, message: 'Uses eval() - risk of injection' },
  { pattern: /\bnew\s+Function\s*\(/, message: 'Uses new Function() - risk of injection' },
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, message: 'Uses child_process in code/function node' },
  { pattern: /require\s*\(\s*['"]fs['"]\s*\)/, message: 'Uses fs module in code/function node' },
  { pattern: /\bprocess\.env\s*\[/, message: 'Uses dynamic process.env access in code/function node' },
];

/**
 * Strip enclosing single/double quotes and trim whitespace from a string.
 * Used to recover from LLM mistakes like "'Set Vars'" → "Set Vars".
 */
function stripEnclosingQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === "'" || t[0] === '"' || t[0] === '`') && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).trim();
  }
  return t;
}

type NodeLookup = {
  nodeNames: Set<string>;
  nodeIdToName: Map<string, string>;
  ambiguousNodeIds: Set<string>;
  normalizedRefToName: Map<string, string>;
  ambiguousNormalizedRefs: Set<string>;
};

type ResolvedNodeRef = {
  name: string;
  reason: 'node.id' | 'trimmed node.name' | 'trimmed node.id' | 'normalized node ref';
};

type WorkflowGraphAnalysis = {
  triggerNodeNames: string[];
  executableNodeNames: string[];
  reachableNodeNames: string[];
  reachableExecutableNodeNames: string[];
  orphanNodeNames: string[];
  disconnectedComponents: WorkflowGraphComponent[];
};

function normalizeNodeRef(value: string): string {
  return stripEnclosingQuotes(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function addUniqueLookup(
  map: Map<string, string>,
  ambiguous: Set<string>,
  key: string | undefined,
  nodeName: string,
) {
  if (!key) return;
  const existing = map.get(key);
  if (!existing) {
    if (!ambiguous.has(key)) map.set(key, nodeName);
    return;
  }

  if (existing !== nodeName) {
    map.delete(key);
    ambiguous.add(key);
  }
}

function buildNodeLookup(nodes: any[]): NodeLookup {
  const nodeNames = new Set<string>();
  const nodeIdToName = new Map<string, string>();
  const ambiguousNodeIds = new Set<string>();
  const normalizedRefToName = new Map<string, string>();
  const ambiguousNormalizedRefs = new Set<string>();

  for (const node of nodes) {
    const name = typeof node?.name === 'string' ? node.name : '';
    if (!name) continue;
    nodeNames.add(name);
    addUniqueLookup(normalizedRefToName, ambiguousNormalizedRefs, normalizeNodeRef(name), name);

    if (typeof node?.id === 'string' && node.id.length > 0) {
      addUniqueLookup(nodeIdToName, ambiguousNodeIds, node.id, name);
      addUniqueLookup(normalizedRefToName, ambiguousNormalizedRefs, normalizeNodeRef(node.id), name);
    }
  }

  return { nodeNames, nodeIdToName, ambiguousNodeIds, normalizedRefToName, ambiguousNormalizedRefs };
}

function resolveNodeRef(ref: string, lookup: NodeLookup): ResolvedNodeRef | null {
  if (lookup.nodeNames.has(ref)) return null;

  const cleaned = stripEnclosingQuotes(ref);
  if (cleaned !== ref && lookup.nodeNames.has(cleaned)) {
    return { name: cleaned, reason: 'trimmed node.name' };
  }

  if (!lookup.ambiguousNodeIds.has(ref)) {
    const byId = lookup.nodeIdToName.get(ref);
    if (byId) return { name: byId, reason: 'node.id' };
  }

  if (cleaned !== ref) {
    if (!lookup.ambiguousNodeIds.has(cleaned)) {
      const byCleanedId = lookup.nodeIdToName.get(cleaned);
      if (byCleanedId) return { name: byCleanedId, reason: 'trimmed node.id' };
    }
  }

  const normalized = normalizeNodeRef(cleaned);
  if (normalized && !lookup.ambiguousNormalizedRefs.has(normalized)) {
    const byNormalizedRef = lookup.normalizedRefToName.get(normalized);
    if (byNormalizedRef && byNormalizedRef !== ref) {
      return { name: byNormalizedRef, reason: 'normalized node ref' };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dedupeConnectionGroup(group: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];

  for (const item of group) {
    const key = stableJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function mergeMainConnections(existingMain: unknown, incomingMain: unknown): { success: true; value: any[] } | { success: false; reason: string } {
  if (!Array.isArray(existingMain) || !Array.isArray(incomingMain)) {
    return { success: false, reason: 'main connections are not both arrays' };
  }

  const merged: any[] = [];
  const maxLength = Math.max(existingMain.length, incomingMain.length);
  for (let i = 0; i < maxLength; i += 1) {
    const existingGroup = existingMain[i];
    const incomingGroup = incomingMain[i];

    if (existingGroup === undefined) {
      merged[i] = incomingGroup;
      continue;
    }
    if (incomingGroup === undefined) {
      merged[i] = existingGroup;
      continue;
    }
    if (!Array.isArray(existingGroup) || !Array.isArray(incomingGroup)) {
      return { success: false, reason: `main[${i}] connection groups are not both arrays` };
    }

    merged[i] = dedupeConnectionGroup([...existingGroup, ...incomingGroup]);
  }

  return { success: true, value: merged };
}

function mergeConnectionRecords(
  existingRecord: unknown,
  incomingRecord: unknown,
): { success: true; value: Record<string, any> } | { success: false; reason: string } {
  if (!isRecord(existingRecord) || !isRecord(incomingRecord)) {
    return { success: false, reason: 'connection records are not both objects' };
  }

  const merged: Record<string, any> = { ...existingRecord };

  for (const [key, incomingValue] of Object.entries(incomingRecord)) {
    if (key === 'main') continue;

    if (!(key in merged)) {
      merged[key] = incomingValue;
      continue;
    }

    if (stableJson(merged[key]) !== stableJson(incomingValue)) {
      return { success: false, reason: `conflicting connection property "${key}"` };
    }
  }

  if ('main' in incomingRecord) {
    if (!('main' in merged)) {
      merged.main = incomingRecord.main;
    } else {
      const mainMerge = mergeMainConnections(merged.main, incomingRecord.main);
      if (!mainMerge.success) return mainMerge;
      merged.main = mainMerge.value;
    }
  }

  return { success: true, value: merged };
}

function isConnectionItem(value: unknown): value is Record<string, any> {
  return isRecord(value) && ('node' in value || 'type' in value || 'index' in value);
}

function coerceConnectionOutputGroups(value: unknown): any[][] {
  if (!Array.isArray(value)) return [];
  if (value.every((group) => Array.isArray(group))) return value as any[][];
  if (value.every((item) => isConnectionItem(item))) return [value];
  return [];
}

function connectionOutputGroups(sourceConnections: unknown): any[][] {
  if (!isRecord(sourceConnections)) return [];

  const groups: any[][] = [];
  for (const value of Object.values(sourceConnections)) {
    groups.push(...coerceConnectionOutputGroups(value));
  }
  return groups;
}

/**
 * Normalize connection source keys and target node refs when they point to a
 * node id, or contain accidental enclosing quotes/whitespace.
 * Mutates the workflow in-place. Returns a list of normalizations performed
 * (each entry is one warning to surface to the caller).
 *
 * Why: n8n connections are keyed by node.name, but LLMs often emit node.id
 * values such as {"scheduleTrigger_01": ...}. n8n and this validator are strict
 * about names, so we repair unambiguous id/name mismatches before validation.
 */
export function normalizeConnectionKeys(workflowJson: any): string[] {
  const fixes: string[] = [];
  if (!workflowJson || typeof workflowJson !== 'object') return fixes;

  const nodes: any[] = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const lookup = buildNodeLookup(nodes);

  const conns = workflowJson.connections;
  if (!conns || typeof conns !== 'object' || Array.isArray(conns)) return fixes;

  // Fix source keys. n8n requires source keys to be node.name, not node.id.
  for (const key of Object.keys(conns)) {
    const resolved = resolveNodeRef(key, lookup);
    if (!resolved) continue;

    if (Object.prototype.hasOwnProperty.call(conns, resolved.name)) {
      const merged = mergeConnectionRecords(conns[resolved.name], conns[key]);
      if (!merged.success) {
        fixes.push(
          `Connections: cannot normalize source "${key}" to "${resolved.name}" (${resolved.reason}) because ${merged.reason}.`,
        );
        continue;
      }
      conns[resolved.name] = merged.value;
      delete conns[key];
      fixes.push(`Connections: source "${key}" matched ${resolved.reason} and was merged into node.name "${resolved.name}".`);
      continue;
    }

    conns[resolved.name] = conns[key];
    delete conns[key];
    fixes.push(`Connections: source "${key}" matched ${resolved.reason} and was normalized to node.name "${resolved.name}".`);
  }

  // Fix target node refs inside connections[*].main[*][*].node.
  for (const [sourceName, sourceConnections] of Object.entries(conns)) {
    for (const outputGroup of connectionOutputGroups(sourceConnections)) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        if (!conn || typeof conn !== 'object' || typeof conn.node !== 'string') continue;
        const resolved = resolveNodeRef(conn.node, lookup);
        if (!resolved) continue;
        fixes.push(
          `Connections from "${sourceName}": target "${conn.node}" matched ${resolved.reason} and was normalized to node.name "${resolved.name}".`,
        );
        conn.node = resolved.name;
      }
    }
  }

  for (const [sourceName, sourceConnections] of Object.entries(conns)) {
    if (!isRecord(sourceConnections)) continue;
    if (!Array.isArray(sourceConnections.error)) continue;

    const errorGroups = coerceConnectionOutputGroups(sourceConnections.error);
    if (errorGroups.length === 0) {
      delete sourceConnections.error;
      fixes.push(`Connections from "${sourceName}": removed empty non-standard error output.`);
      continue;
    }

    if (!Array.isArray(sourceConnections.main)) sourceConnections.main = [];
    while (sourceConnections.main.length <= 1) sourceConnections.main.push([]);
    if (!Array.isArray(sourceConnections.main[1])) sourceConnections.main[1] = [];

    sourceConnections.main[1] = dedupeConnectionGroup([
      ...sourceConnections.main[1],
      ...errorGroups.flat(),
    ]);
    delete sourceConnections.error;
    fixes.push(`Connections from "${sourceName}": non-standard "error" output was normalized to main[1].`);
  }

  return fixes;
}

function analyzeWorkflowGraph(nodes: any[], connections: Record<string, any>): WorkflowGraphAnalysis {
  const nodeByName = new Map<string, any>();
  const adjacency = new Map<string, Set<string>>();
  const reverseAdjacency = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (typeof node?.name !== 'string' || !node.name || nodeByName.has(node.name)) continue;
    nodeByName.set(node.name, node);
    adjacency.set(node.name, new Set());
    reverseAdjacency.set(node.name, new Set());
  }

  for (const [sourceName, sourceConnections] of Object.entries(connections)) {
    if (!adjacency.has(sourceName)) continue;

    for (const outputGroup of connectionOutputGroups(sourceConnections)) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        if (!conn || typeof conn.node !== 'string' || !adjacency.has(conn.node)) continue;
        adjacency.get(sourceName)?.add(conn.node);
        reverseAdjacency.get(conn.node)?.add(sourceName);
      }
    }
  }

  const nodeNames = [...nodeByName.keys()];
  const triggerNodeNames = nodeNames.filter((name) => isTriggerType(nodeByName.get(name)?.type));
  const executableNodeNames = nodeNames.filter((name) => isExecutableNode(nodeByName.get(name)));
  const reachable = new Set<string>();
  const queue = [...triggerNodeNames];

  while (queue.length > 0) {
    const name = queue.shift();
    if (!name || reachable.has(name)) continue;
    reachable.add(name);
    for (const target of adjacency.get(name) ?? []) {
      if (!reachable.has(target)) queue.push(target);
    }
  }

  const reachableExecutableNodeNames = executableNodeNames.filter((name) => reachable.has(name));
  const orphanNodeNames =
    triggerNodeNames.length === 0
      ? [...executableNodeNames]
      : executableNodeNames.filter((name) => !reachable.has(name));
  const components = findGraphComponents(nodeNames, nodeByName, adjacency, reverseAdjacency);
  const disconnectedComponents = components.filter((component) => component.executableNodeNames.length > 0 && !component.hasTrigger);

  return {
    triggerNodeNames,
    executableNodeNames,
    reachableNodeNames: [...reachable],
    reachableExecutableNodeNames,
    orphanNodeNames,
    disconnectedComponents,
  };
}

function findGraphComponents(
  nodeNames: string[],
  nodeByName: Map<string, any>,
  adjacency: Map<string, Set<string>>,
  reverseAdjacency: Map<string, Set<string>>,
): WorkflowGraphComponent[] {
  const visited = new Set<string>();
  const components: WorkflowGraphComponent[] = [];

  for (const start of nodeNames) {
    if (visited.has(start)) continue;

    const queue = [start];
    const componentNodes: string[] = [];

    while (queue.length > 0) {
      const name = queue.shift();
      if (!name || visited.has(name)) continue;
      visited.add(name);
      componentNodes.push(name);

      const neighbors = new Set([...(adjacency.get(name) ?? []), ...(reverseAdjacency.get(name) ?? [])]);
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    const sortedNodeNames = componentNodes.sort((a, b) => a.localeCompare(b));
    const executableNodeNames = sortedNodeNames.filter((name) => isExecutableNode(nodeByName.get(name)));
    const triggerNodeNames = sortedNodeNames.filter((name) => isTriggerType(nodeByName.get(name)?.type));

    components.push({
      index: components.length + 1,
      nodeNames: sortedNodeNames,
      executableNodeNames,
      triggerNodeNames,
      hasTrigger: triggerNodeNames.length > 0,
    });
  }

  return components;
}

function isTriggerType(type: string | undefined): boolean {
  return typeof type === 'string' && TRIGGER_TYPES.has(type);
}

function isExecutableNode(node: any): boolean {
  if (!node?.name || typeof node.type !== 'string') return false;
  if (isTriggerType(node.type)) return false;
  return node.type !== 'n8n-nodes-base.noOp' && node.type !== 'n8n-nodes-base.stickyNote';
}

export function validateWorkflow(
  workflowJson: any,
  profile: 'draft' | 'strict' | 'activation' = 'strict',
): ValidationResult {
  const errors: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const securityIssues: ValidationFinding[] = [];
  const missingCredentials: MissingCredential[] = [];
  const missingConfig: MissingConfig[] = [];
  const topology = getRuntimeTopology();

  if (!workflowJson || typeof workflowJson !== 'object') {
    return createErrorResult('workflowJson is not a valid object', profile);
  }

  if (typeof workflowJson.name !== 'string' || !workflowJson.name.trim()) {
    errors.push({ message: 'Workflow missing non-empty "name" field.', severity: 'error' });
  }

  if (!Array.isArray(workflowJson.nodes)) {
    errors.push({ message: 'Workflow "nodes" must be an array.', severity: 'error' });
  }

  if (!workflowJson.connections || typeof workflowJson.connections !== 'object' || Array.isArray(workflowJson.connections)) {
    errors.push({ message: 'Workflow "connections" must be an object.', severity: 'error' });
  }

  if (workflowJson.active === true) {
    warnings.push({ message: 'Workflow has active=true; Mastra deploy will force inactive draft.', severity: 'warning' });
  }

  const nodes: any[] = Array.isArray(workflowJson.nodes) ? workflowJson.nodes : [];
  const connections: Record<string, any> =
    workflowJson.connections && typeof workflowJson.connections === 'object' && !Array.isArray(workflowJson.connections)
      ? workflowJson.connections
      : {};
  const directWebhookTargets = findDirectWebhookTargets(nodes, connections);

  if (nodes.length === 0) {
    errors.push({ message: 'Workflow has no nodes.', severity: 'error' });
  }

  const nodeNames = new Set<string>();
  const nodeIds = new Set<string>();
  const allNodeNames = new Set(nodes.map((node) => node?.name).filter((name): name is string => typeof name === 'string' && name.length > 0));
  const hasWebhookTrigger = nodes.some((node) => node?.type === 'n8n-nodes-base.webhook');
  let hasTrigger = false;
  let hasActivatableTrigger = false;
  let connectionCount = 0;

  for (const node of nodes) {
    // 1. Basic fields
    if (!node.name) errors.push({ message: 'Node missing "name" field', severity: 'error' });
    if (!node.type) errors.push({ message: `Node "${node.name || 'unknown'}" missing "type" field`, severity: 'error' });
    if (!node.id) warnings.push({ nodeName: node.name, message: 'Node missing "id"', severity: 'warning' });
    if (node.typeVersion === undefined)
      warnings.push({ nodeName: node.name, message: 'Node missing "typeVersion"', severity: 'warning' });
    if (!isPlainObject(node.parameters)) {
      errors.push({
        nodeName: node.name,
        message: `Node "${node.name || 'unknown'}" must define "parameters" as an object.`,
        severity: 'error',
      });
    }
    if (!Array.isArray(node.position) || node.position.length !== 2) {
      warnings.push({ nodeName: node.name, message: 'Node missing valid [x,y] position', severity: 'warning' });
    }

    if (node.type) {
      const knownVersions = getKnownTypeVersions(node.type);
      if (!knownVersions) {
        // Unknown TYPE stays a warning: it means "not in the core set, get MCP
        // metadata", not "this is wrong".
        warnings.push({ nodeName: node.name, message: `Unknown node type: ${node.type}`, severity: 'warning' });
      } else if (node.typeVersion !== undefined && !knownVersions.includes(Number(node.typeVersion))) {
        // A known type on an unsupported version IS an error. n8n's REST API
        // happily creates such a node and only fails when the workflow actually
        // runs, so a warning here produced workflows that deployed green and
        // could never execute. KNOWN_NODE_TYPES is reconciled against the live
        // instance, so this is a fact about the install, not a guess.
        errors.push({
          nodeName: node.name,
          message: `Unsupported typeVersion ${node.typeVersion} for ${node.type}. This install supports: ${knownVersions.join(', ')}`,
          severity: 'error',
        });
      }
    }

    // 2. Uniqueness
    if (node.name && nodeNames.has(node.name)) {
      errors.push({ nodeName: node.name, message: `Duplicate node name: "${node.name}"`, severity: 'error' });
    }
    if (node.name) nodeNames.add(node.name);

    if (node.id && nodeIds.has(node.id)) {
      warnings.push({ nodeName: node.name, message: `Duplicate node id: "${node.id}"`, severity: 'warning' });
    }
    if (node.id) nodeIds.add(node.id);

    // 3. Trigger check
    if (TRIGGER_TYPES.has(node.type)) {
      hasTrigger = true;
      if (!NON_ACTIVATABLE_TRIGGER_TYPES.has(node.type)) {
        hasActivatableTrigger = true;
      }
    }

    // 4. Forbidden node check
    // Unlike other securityIssues (which only fail 'strict'/'activation' profiles,
    // see profile-specific logic below), a forbidden node type is not a
    // profile-relative concern: the Golden Path's forbidden_node_policy gate
    // (automation-golden-path.ts) rejects it unconditionally at every profile,
    // including 'draft'. Also pushing to errors makes isValid=false here too,
    // so a draft-profile validate call can't report a false "valid, 0 errors"
    // for a workflow that will be hard-blocked on deploy regardless.
    if (node.type && FORBIDDEN_NODE_TYPES.includes(node.type)) {
      const message = `Node uses forbidden type: ${node.type}`;
      securityIssues.push({ nodeName: node.name, message, severity: 'security' });
      errors.push({ nodeName: node.name, message, severity: 'error' });
    }

    // 5. Parameters & Security
    if (isPlainObject(node.parameters)) {
      const paramStr = JSON.stringify(node.parameters);
      const paramStrLower = paramStr.toLowerCase();

      // No $vars.*
      if (/\$vars\./.test(paramStr)) {
        errors.push({
          nodeName: node.name,
          message: 'Uses $vars.* which is not supported in n8n Community Edition.',
          severity: 'error',
        });
      }

      // No [object Object]
      if (paramStr.includes('"[object Object]"') || paramStr.includes('[object Object]')) {
        errors.push({
          nodeName: node.name,
          message: 'Contains invalid "[object Object]" in parameters.',
          severity: 'error',
        });
      }

      // Runtime placeholders
      const placeholders = ['example.com', 'placeholder', 'GastroBridge'];
      for (const p of placeholders) {
        if (paramStrLower.includes(p.toLowerCase()) && !paramStr.includes('={{')) {
          warnings.push({
            nodeName: node.name,
            message: `Contains placeholder value: "${p}"`,
            severity: 'warning',
          });
        }
      }

      // Critical unconfigured dummy API key placeholders
      const secretPlaceholders = ['your_api_key', 'your_token', 'your-api-key', '<api_key>', 'api_key_here', 'todo_api_key'];
      for (const sp of secretPlaceholders) {
        if (paramStrLower.includes(sp)) {
          errors.push({
            nodeName: node.name,
            message: `Contains unconfigured dummy API key placeholder: "${sp}". Configure the required service credential or remove the dummy placeholder.`,
            severity: 'error',
          });
        }
      }

      if (paramStr.includes('http://localhost:3000') && process.env.ALLOW_LEGACY_LOCALHOST_3000 !== 'true') {
        errors.push({
          nodeName: node.name,
          message: 'Uses legacy Jarvis endpoint http://localhost:3000. Use MASTRA_API_URL_FOR_N8N / runtime topology instead.',
          severity: 'error',
        });
      }

      if (topology.mode === 'local-host-network' && paramStr.includes('af-mongodb')) {
        errors.push({
          nodeName: node.name,
          message: 'Uses docker service hostname af-mongodb while runtime mode is local-host-network. Use localhost:27017 or MONGO_HOST_FOR_N8N.',
          severity: 'error',
        });
      }

      if (topology.mode === 'local-host-network' && paramStr.includes('host.docker.internal')) {
        warnings.push({
          nodeName: node.name,
          message: 'Uses host.docker.internal in local-host-network mode. Prefer localhost endpoints from runtime topology.',
          severity: 'warning',
        });
      }

      // 5b. Node-specific required parameter and type validations
      const nodeType = node.type;
      const params = node.parameters;

      if (nodeType === 'n8n-nodes-base.gmail') {
        const resource = params.resource || 'draft';
        const operation = params.operation || 'create';

        if (resource === 'draft' || resource === 'message') {
          // Check subject
          if (typeof params.subject !== 'string' || !params.subject.trim()) {
            errors.push({
              nodeName: node.name,
              message: `Gmail node "${node.name}" (${resource}:${operation}) is missing required parameter "subject".`,
              severity: 'error',
            });
          }

          // Check message
          if (params.message && typeof params.message === 'object' && !Array.isArray(params.message)) {
            errors.push({
              nodeName: node.name,
              message: `Gmail node "${node.name}" has invalid nested object in "message" parameter. In n8n, "message" must be a string or expression, not an object.`,
              severity: 'error',
            });
          } else if (typeof params.message !== 'string' || !params.message.trim()) {
            errors.push({
              nodeName: node.name,
              message: `Gmail node "${node.name}" (${resource}:${operation}) is missing required parameter "message".`,
              severity: 'error',
            });
          }

          // Check options.sendTo or to
          const hasRecipient = (params.options && typeof params.options.sendTo === 'string' && params.options.sendTo.trim()) ||
            (typeof params.to === 'string' && params.to.trim());
          if (!hasRecipient && profile === 'strict') {
            warnings.push({
              nodeName: node.name,
              message: `Gmail node "${node.name}" is missing recipient in options.sendTo.`,
              severity: 'warning',
            });
          }
        }
      }

      if (nodeType === 'n8n-nodes-base.telegram') {
        if (!params.chatId || (typeof params.chatId === 'string' && !params.chatId.trim())) {
          errors.push({
            nodeName: node.name,
            message: `Telegram node "${node.name}" is missing required parameter "chatId".`,
            severity: 'error',
          });
        }
        if (typeof params.text !== 'string' || !params.text.trim()) {
          errors.push({
            nodeName: node.name,
            message: `Telegram node "${node.name}" is missing required parameter "text".`,
            severity: 'error',
          });
        }
      }

      if (nodeType === 'n8n-nodes-base.mongoDb') {
        if (typeof params.collection !== 'string' || !params.collection.trim()) {
          errors.push({
            nodeName: node.name,
            message: `MongoDB node "${node.name}" is missing required parameter "collection".`,
            severity: 'error',
          });
        }
        if (typeof params.operation !== 'string' || !params.operation.trim()) {
          errors.push({
            nodeName: node.name,
            message: `MongoDB node "${node.name}" is missing required parameter "operation".`,
            severity: 'error',
          });
        }
      }

      if (nodeType === 'n8n-nodes-base.httpRequest') {
        if (typeof params.url !== 'string' || !params.url.trim()) {
          errors.push({
            nodeName: node.name,
            message: `HTTP Request node "${node.name}" is missing required parameter "url".`,
            severity: 'error',
          });
        }
      }

      for (const value of collectStringValues(node.parameters)) {
        if (hasUnbalancedExpression(value)) {
          errors.push({
            nodeName: node.name,
            message: `Expression appears unbalanced: ${truncate(value)}`,
            severity: 'error',
          });
        }

        for (const referencedName of findExpressionNodeRefs(value)) {
          if (!allNodeNames.has(referencedName)) {
            errors.push({
              nodeName: node.name,
              message: `Expression references unknown node: "${referencedName}"`,
              severity: 'error',
            });
          }
        }
      }

      // Security: code/function nodes can hide executable snippets under
      // jsCode, functionCode, code, or other string parameters.
      if (isCodeLikeNode(node.type)) {
        for (const code of collectStringValues(node.parameters)) {
          for (const { pattern, message } of DANGEROUS_CODE_PATTERNS) {
            if (pattern.test(code)) {
              securityIssues.push({ nodeName: node.name, message, severity: 'security' });
            }
          }

          if (hasWebhookTrigger && directWebhookTargets.has(String(node.name ?? '')) && hasUnsafeWebhookRootPayloadRead(code)) {
            errors.push({
              nodeName: node.name,
              message: 'Code node after Webhook reads payload fields from root $json/$input.item.json without normalizing the n8n webhook envelope. Use payload = body ?? root before reading email/message/type/payload.',
              severity: 'error',
            });
          }
        }
      }

      if (node.type === 'n8n-nodes-base.respondToWebhook') {
        const respondWith = String(node.parameters.respondWith ?? '').toLowerCase();
        if (respondWith === 'json' && isEmptyResponseBody(node.parameters.responseBody)) {
          errors.push({
            nodeName: node.name,
            message: 'Respond to Webhook uses respondWith=json but responseBody is empty. Use an explicit expression such as ={{ $json }}.',
            severity: 'error',
          });
        }
      }
    }

    // 6. Credentials
    const credentialRequirements: Record<string, { service: string; credentialTypes: string[] }> = {
      'n8n-nodes-base.telegram': { service: 'telegram', credentialTypes: ['telegramApi'] },
      'n8n-nodes-base.telegramTrigger': { service: 'telegram', credentialTypes: ['telegramApi'] },
      'n8n-nodes-base.mongoDb': { service: 'mongo', credentialTypes: ['mongoDb'] },
      'n8n-nodes-base.gmail': { service: 'gmail', credentialTypes: ['googleGmailOAuth2Api', 'gmailOAuth2'] },
      'n8n-nodes-base.gmailTrigger': { service: 'gmail', credentialTypes: ['googleGmailOAuth2Api', 'gmailOAuth2'] },
      'n8n-nodes-base.googleSheets': { service: 'googleSheets', credentialTypes: ['googleSheetsOAuth2Api', 'googleApi'] },
    };
    const credentialRequirement = credentialRequirements[node.type];
    const hasCredential = credentialRequirement?.credentialTypes.some((credentialType) => node.credentials?.[credentialType]);
    if (credentialRequirement && !hasCredential) {
      missingCredentials.push({
        service: credentialRequirement.service,
        required: credentialRequirement.service !== 'googleSheets',
        setupHint: `Missing credential (${credentialRequirement.credentialTypes.join(' or ')}) for ${node.type}`,
      });
    } else if (credentialRequirement) {
      for (const credentialType of credentialRequirement.credentialTypes) {
        if (typeof node.credentials?.[credentialType] === 'string') {
          warnings.push({
            nodeName: node.name,
            message: `Credential ${credentialType} uses legacy string shape; prefer { id, name }.`,
            severity: 'warning',
          });
        }
      }
    }

    if (node.type === 'n8n-nodes-base.telegram' && node.parameters?.chatId === '') {
      missingConfig.push({
        key: 'N8N_TELEGRAM_CHAT_ID',
        description: 'Telegram send node has empty chatId.',
        required: true,
      });
    }

    if (node.type === 'n8n-nodes-base.googleSheets') {
      const documentId = String(node.parameters?.documentId ?? node.parameters?.spreadsheetId ?? '').trim();
      if (!documentId || /placeholder|example|to[-_ ]?fill|uzupeł|uzupeln/i.test(documentId)) {
        missingConfig.push({
          key: 'GOOGLE_SHEETS_DOCUMENT_ID',
          description: `Google Sheets node "${node.name || node.type}" needs a real spreadsheet/document ID before real use.`,
          required: false,
        });
      }
    }
  }

  // 7. Connections
  for (const [sourceName, sourceConnections] of Object.entries(connections)) {
    if (!nodeNames.has(sourceName)) {
      errors.push({ message: `Connection references unknown source node: "${sourceName}"`, severity: 'error' });
    }

    for (const outputGroup of connectionOutputGroups(sourceConnections)) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        connectionCount++;
        if (!conn.node) {
          errors.push({ message: `Connection from "${sourceName}" has missing target node`, severity: 'error' });
        } else if (!nodeNames.has(conn.node)) {
          errors.push({
            message: `Connection from "${sourceName}" references unknown target: "${conn.node}"`,
            severity: 'error',
          });
        }
      }
    }
  }

  const graph = analyzeWorkflowGraph(nodes, connections);
  const triggerCount = graph.triggerNodeNames.length;
  const orphanPreview = graph.orphanNodeNames.slice(0, 8).join(', ');

  if (profile === 'draft') {
    if (graph.executableNodeNames.length > 1 && connectionCount === 0) {
      errors.push({
        message: `Workflow has ${graph.executableNodeNames.length} executable nodes but no connections; graph is disconnected.`,
        severity: 'error',
      });
    } else if (graph.orphanNodeNames.length > 0) {
      warnings.push({
        message: `Executable nodes are not reachable from any trigger: ${orphanPreview}.`,
        severity: 'warning',
      });
    }
  }

  if ((profile === 'strict' || profile === 'activation') && graph.executableNodeNames.length > 0) {
    if (triggerCount === 0) {
      errors.push({
        message: `Workflow has ${graph.executableNodeNames.length} executable nodes but no trigger node.`,
        severity: 'error',
      });
    } else if (graph.orphanNodeNames.length > 0) {
      errors.push({
        message: `Executable nodes are not reachable from any trigger: ${orphanPreview}.`,
        severity: 'error',
      });
    }
  }

  // 8. Profile-specific logic
  let isValid = errors.length === 0;

  if (profile === 'strict' || profile === 'activation') {
    if (securityIssues.length > 0) isValid = false;
    if (missingCredentials.some((c) => c.required)) isValid = false;
    if (missingConfig.some((c) => c.required)) isValid = false;
  }

  if (profile === 'activation') {
    if (!hasTrigger) {
      errors.push({ message: 'Activation profile requires a trigger node.', severity: 'error' });
      isValid = false;
    } else if (!hasActivatableTrigger) {
      errors.push({ message: 'Activation profile requires at least one non-manual trigger node.', severity: 'error' });
      isValid = false;
    } else if (graph.executableNodeNames.length > 0 && graph.reachableExecutableNodeNames.length === 0) {
      errors.push({ message: 'Activation profile requires a trigger path to at least one executable node.', severity: 'error' });
      isValid = false;
    }
  }

  return {
    valid: isValid,
    profile,
    errors,
    warnings,
    securityIssues,
    missingCredentials,
    missingConfig,
    nodeCount: nodes.length,
    connectionCount,
    triggerCount,
    reachableNodeCount: graph.reachableNodeNames.length,
    orphanNodeCount: graph.orphanNodeNames.length,
    disconnectedComponents: graph.disconnectedComponents,
  };
}

function isCodeLikeNode(type: string | undefined): boolean {
  return type === 'n8n-nodes-base.code' || type === 'n8n-nodes-base.function';
}

function findDirectWebhookTargets(nodes: any[], connections: Record<string, any>): Set<string> {
  const webhookNames = new Set(
    nodes
      .filter((node) => node?.type === 'n8n-nodes-base.webhook' && typeof node.name === 'string')
      .map((node) => node.name),
  );
  const targets = new Set<string>();

  for (const webhookName of webhookNames) {
    const main = connections[webhookName]?.main;
    if (!Array.isArray(main)) continue;
    for (const outputGroup of main) {
      if (!Array.isArray(outputGroup)) continue;
      for (const conn of outputGroup) {
        if (conn && typeof conn.node === 'string') targets.add(conn.node);
      }
    }
  }

  return targets;
}

function hasUnsafeWebhookRootPayloadRead(code: string): boolean {
  if (/\.(?:body)\b/.test(code)) return false;

  const aliases = new Set<string>();
  const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\$input\.item\.json|items\[0\]\?\.json|\$json)\b/g;
  for (const match of code.matchAll(aliasPattern)) aliases.add(match[1]);

  const payloadFields = '(?:email|message|type|payload|name|phone|company|contactEmail|fullName|companyName|text)';

  if (new RegExp(`(?:\\$input\\.item\\.json|items\\[0\\]\\?\\.json|\\$json)\\s*\\.\\s*${payloadFields}\\b`).test(code)) {
    return true;
  }

  for (const alias of aliases) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\s*\\.\\s*${payloadFields}\\b`).test(code)) {
      return true;
    }
  }

  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEmptyResponseBody(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStringValues(item));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) => collectStringValues(item));
  }
  return [];
}

function hasUnbalancedExpression(value: string): boolean {
  if (!value.includes('={{')) return false;
  const opened = (value.match(/=\{\{/g) || []).length;
  const closed = (value.match(/\}\}/g) || []).length;
  return opened !== closed;
}

function findExpressionNodeRefs(value: string): string[] {
  const refs = new Set<string>();
  const patterns = [/\$\(['"]([^'"]+)['"]\)/g, /\$node\[['"]([^'"]+)['"]\]/g, /\$items\(['"]([^'"]+)['"]/g];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      refs.add(match[1]);
    }
  }

  return [...refs];
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createErrorResult(message: string, profile: any): ValidationResult {
  return {
    valid: false,
    profile,
    errors: [{ message, severity: 'error' }],
    warnings: [],
    securityIssues: [],
    missingCredentials: [],
    missingConfig: [],
    nodeCount: 0,
    connectionCount: 0,
    triggerCount: 0,
    reachableNodeCount: 0,
    orphanNodeCount: 0,
    disconnectedComponents: [],
  };
}
