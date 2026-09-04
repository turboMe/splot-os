import { randomUUID } from 'node:crypto';
import { getKnownTypeVersions, KNOWN_NODE_TYPES, TRIGGER_TYPES } from '../validation/node-registry.js';

export interface GraphNodeSpec {
  id?: string;
  name: string;
  type: string;
  typeVersion?: number;
  parameters?: Record<string, any>;
  credentials?: Record<string, any>;
  position?: [number, number];
  notes?: string;
}

export interface GraphConnectionSpec {
  from: string; // source node name or id
  to: string;   // target node name or id
  type?: 'main' | 'error';
  fromOutputIndex?: number;
  toInputIndex?: number;
}

export interface WorkflowGraphSpec {
  name: string;
  nodes: GraphNodeSpec[];
  connections: GraphConnectionSpec[];
  settings?: Record<string, any>;
  active?: boolean;
  pinData?: Record<string, any>;
  meta?: Record<string, any>;
}

export interface N8nConnectionTarget {
  node: string;
  type: string;
  index: number;
}

export interface SynthesizedWorkflow {
  name: string;
  nodes: Array<{
    id: string;
    name: string;
    type: string;
    typeVersion: number;
    parameters: Record<string, any>;
    credentials?: Record<string, any>;
    position: [number, number];
    notesInFlow?: boolean;
    notes?: string;
  }>;
  connections: Record<string, Record<string, N8nConnectionTarget[][]>>;
  settings: Record<string, any>;
  active: boolean;
  pinData?: Record<string, any>;
  meta?: Record<string, any>;
}

export interface GraphValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates basic structural invariants of a WorkflowGraphSpec before synthesis.
 */
export function validateGraphSpec(spec: WorkflowGraphSpec): GraphValidationResult {
  const errors: string[] = [];

  if (!spec || typeof spec !== 'object') {
    return { valid: false, errors: ['Graph specification must be a non-null object.'] };
  }

  if (!spec.name || typeof spec.name !== 'string' || !spec.name.trim()) {
    errors.push('Workflow name is required and must be a non-empty string.');
  }

  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    errors.push('Workflow nodes must be a non-empty array.');
    return { valid: false, errors };
  }

  const nodeNameSet = new Set<string>();
  const nodeIdSet = new Set<string>();

  spec.nodes.forEach((node, index) => {
    if (!node || typeof node !== 'object') {
      errors.push(`Node at index ${index} must be an object.`);
      return;
    }

    if (!node.name || typeof node.name !== 'string' || !node.name.trim()) {
      errors.push(`Node at index ${index} missing a non-empty "name".`);
    } else {
      if (nodeNameSet.has(node.name)) {
        errors.push(`Duplicate node name "${node.name}" at index ${index}. Node names in n8n must be unique.`);
      }
      nodeNameSet.add(node.name);
    }

    if (node.id) {
      if (nodeIdSet.has(node.id)) {
        errors.push(`Duplicate node id "${node.id}" at index ${index}.`);
      }
      nodeIdSet.add(node.id);
    }

    if (!node.type || typeof node.type !== 'string' || !node.type.trim()) {
      errors.push(`Node "${node.name || index}" missing a non-empty "type".`);
    }
  });

  const connections = Array.isArray(spec.connections) ? spec.connections : [];
  connections.forEach((conn, index) => {
    if (!conn || typeof conn !== 'object') {
      errors.push(`Connection at index ${index} must be an object.`);
      return;
    }
    if (!conn.from || typeof conn.from !== 'string') {
      errors.push(`Connection at index ${index} missing "from" source identifier.`);
    } else if (!nodeNameSet.has(conn.from) && !nodeIdSet.has(conn.from)) {
      errors.push(`Connection source "${conn.from}" at index ${index} does not match any node name or id.`);
    }

    if (!conn.to || typeof conn.to !== 'string') {
      errors.push(`Connection at index ${index} missing "to" target identifier.`);
    } else if (!nodeNameSet.has(conn.to) && !nodeIdSet.has(conn.to)) {
      errors.push(`Connection target "${conn.to}" at index ${index} does not match any node name or id.`);
    }

    if (typeof conn.fromOutputIndex === 'number' && conn.fromOutputIndex < 0) {
      errors.push(`Connection at index ${index} has invalid negative fromOutputIndex.`);
    }
    if (typeof conn.toInputIndex === 'number' && conn.toInputIndex < 0) {
      errors.push(`Connection at index ${index} has invalid negative toInputIndex.`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Computes non-overlapping 2D grid coordinates for workflow nodes.
 * Flow runs left-to-right (X axis: depth) and branches expand downwards (Y axis: ranks).
 */
export function computeNodePositions(
  nodes: GraphNodeSpec[],
  connections: GraphConnectionSpec[],
  nodeNameToName: (idOrName: string) => string | undefined,
): Map<string, [number, number]> {
  const positions = new Map<string, [number, number]>();

  // Check which nodes already have explicit positions
  const explicitCount = nodes.filter((n) => Array.isArray(n.position) && n.position.length === 2).length;
  if (explicitCount === nodes.length) {
    nodes.forEach((n) => positions.set(n.name, n.position as [number, number]));
    return positions;
  }

  // Build adjacency list for layout calculation
  const inDegree = new Map<string, number>();
  const outEdges = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDegree.set(n.name, 0);
    outEdges.set(n.name, []);
  });

  connections.forEach((c) => {
    const fromName = nodeNameToName(c.from);
    const toName = nodeNameToName(c.to);
    if (fromName && toName && inDegree.has(toName) && outEdges.has(fromName)) {
      inDegree.set(toName, (inDegree.get(toName) ?? 0) + 1);
      outEdges.get(fromName)!.push(toName);
    }
  });

  // Identify triggers or root nodes (inDegree === 0)
  const roots: string[] = [];
  nodes.forEach((n) => {
    const isTrigger = TRIGGER_TYPES.has(n.type) || n.type.toLowerCase().includes('trigger');
    if ((inDegree.get(n.name) ?? 0) === 0 || isTrigger) {
      roots.push(n.name);
    }
  });

  // Fallback if graph is cyclic or roots empty
  if (roots.length === 0 && nodes.length > 0) {
    roots.push(nodes[0].name);
  }

  // BFS to assign column depth
  const depths = new Map<string, number>();
  const queue: Array<{ name: string; depth: number }> = [];

  roots.forEach((root) => {
    depths.set(root, 0);
    queue.push({ name: root, depth: 0 });
  });

  const visited = new Set<string>();

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!;
    if (visited.has(name)) continue;
    visited.add(name);

    const children = outEdges.get(name) || [];
    children.forEach((child) => {
      const nextDepth = depth + 1;
      const currentDepth = depths.get(child) ?? 0;
      if (nextDepth > currentDepth) {
        depths.set(child, nextDepth);
      }
      queue.push({ name: child, depth: nextDepth });
    });
  }

  // Catch any unvisited nodes
  nodes.forEach((n) => {
    if (!depths.has(n.name)) {
      depths.set(n.name, 0);
    }
  });

  // Group nodes by depth column to assign Y rows
  const depthColumns = new Map<number, string[]>();
  nodes.forEach((n) => {
    const d = depths.get(n.name) ?? 0;
    const col = depthColumns.get(d) ?? [];
    col.push(n.name);
    depthColumns.set(d, col);
  });

  const START_X = 240;
  const START_Y = 300;
  const STEP_X = 260;
  const STEP_Y = 160;

  nodes.forEach((n) => {
    if (Array.isArray(n.position) && n.position.length === 2) {
      positions.set(n.name, n.position as [number, number]);
      return;
    }

    const d = depths.get(n.name) ?? 0;
    const col = depthColumns.get(d) ?? [n.name];
    const rank = col.indexOf(n.name);

    const x = START_X + d * STEP_X;
    // Center branch ranks around baseline START_Y
    const yOffset = (rank - (col.length - 1) / 2) * STEP_Y;
    const y = Math.round(START_Y + yOffset);

    positions.set(n.name, [x, y]);
  });

  return positions;
}

/**
 * Resolves a default typeVersion for known n8n nodes when omitted.
 */
function resolveDefaultTypeVersion(nodeType: string, specifiedVersion?: number): number {
  if (typeof specifiedVersion === 'number' && specifiedVersion > 0) {
    return specifiedVersion;
  }
  const known = getKnownTypeVersions(nodeType);
  if (Array.isArray(known) && known.length > 0) {
    // Return latest stable version
    return known[known.length - 1];
  }
  return 1;
}

/**
 * Deterministically normalizes node credentials using environment variables
 * and known n8n credential IDs to prevent LLM hallucinations (e.g. typing "Gmail OAuth2" instead of id).
 */
function normalizeNodeCredentials(nodeType: string, existingCredentials?: Record<string, any>): Record<string, any> | undefined {
  const creds = existingCredentials ? { ...existingCredentials } : {};

  if (nodeType === 'n8n-nodes-base.gmail' || nodeType === 'n8n-nodes-base.gmailTrigger') {
    const defaultGmailId = process.env.N8N_CREDENTIAL_GMAIL_ID || 'kzneLI0ZOHDLx4yb';
    const defaultGmailName = process.env.N8N_CREDENTIAL_GMAIL_NAME || 'Gmail account';

    // Normalize legacy/misnamed googleGmailOAuth2Api -> gmailOAuth2
    if (creds.googleGmailOAuth2Api && !creds.gmailOAuth2) {
      creds.gmailOAuth2 = creds.googleGmailOAuth2Api;
      delete creds.googleGmailOAuth2Api;
    }

    if (!creds.gmailOAuth2) {
      creds.gmailOAuth2 = { id: defaultGmailId, name: defaultGmailName };
    } else if (creds.gmailOAuth2 && typeof creds.gmailOAuth2 === 'object') {
      if (!creds.gmailOAuth2.id || creds.gmailOAuth2.id === 'Gmail OAuth2' || creds.gmailOAuth2.id === 'gmailOAuth2') {
        creds.gmailOAuth2.id = defaultGmailId;
      }
      if (!creds.gmailOAuth2.name) {
        creds.gmailOAuth2.name = defaultGmailName;
      }
    }
  }

  if (nodeType === 'n8n-nodes-base.telegram' || nodeType === 'n8n-nodes-base.telegramTrigger') {
    const defaultTelegramId = process.env.N8N_CREDENTIAL_TELEGRAM_ID || 'paxwl3KAVvkQzo5L';
    const defaultTelegramName = process.env.N8N_CREDENTIAL_TELEGRAM_NAME || 'Telegram account 2';
    if (!creds.telegramApi) {
      creds.telegramApi = { id: defaultTelegramId, name: defaultTelegramName };
    } else if (typeof creds.telegramApi === 'object') {
      if (!creds.telegramApi.id || creds.telegramApi.id === 'telegramApi' || creds.telegramApi.id.includes('Telegram')) {
        creds.telegramApi.id = defaultTelegramId;
      }
      if (!creds.telegramApi.name) {
        creds.telegramApi.name = defaultTelegramName;
      }
    }
  }

  if (nodeType === 'n8n-nodes-base.mongoDb') {
    const defaultMongoId = process.env.N8N_CREDENTIAL_MONGO_ID || 'YAf7kKI1nHDQVxtC';
    const defaultMongoName = process.env.N8N_CREDENTIAL_MONGO_NAME || 'mongo-agentForge-database';
    if (!creds.mongoDb) {
      creds.mongoDb = { id: defaultMongoId, name: defaultMongoName };
    } else if (typeof creds.mongoDb === 'object') {
      if (!creds.mongoDb.id || creds.mongoDb.id === 'mongoDb' || creds.mongoDb.id.includes('mongo-')) {
        creds.mongoDb.id = defaultMongoId;
      }
      if (!creds.mongoDb.name) {
        creds.mongoDb.name = defaultMongoName;
      }
    }
  }

  if (nodeType === 'n8n-nodes-base.openAi' || nodeType.includes('OpenAi') || nodeType.includes('openAi')) {
    const defaultOpenAiId = process.env.N8N_CREDENTIAL_OPENAI_ID || 'VKJ0rkJ0Ya4kgysY';
    const defaultOpenAiName = process.env.N8N_CREDENTIAL_OPENAI_NAME || 'OpenAI account';
    if (!creds.openAiApi) {
      creds.openAiApi = { id: defaultOpenAiId, name: defaultOpenAiName };
    } else if (typeof creds.openAiApi === 'object') {
      if (!creds.openAiApi.id || creds.openAiApi.id === 'openAiApi' || creds.openAiApi.id.includes('OpenAI')) {
        creds.openAiApi.id = defaultOpenAiId;
      }
      if (!creds.openAiApi.name) {
        creds.openAiApi.name = defaultOpenAiName;
      }
    }
  }

  if (nodeType.includes('Anthropic') || nodeType.includes('anthropic')) {
    const defaultAnthropicId = process.env.N8N_CREDENTIAL_ANTHROPIC_ID || 'w4M1TuGuFM6H9AqT';
    const defaultAnthropicName = process.env.N8N_CREDENTIAL_ANTHROPIC_NAME || 'Anthropic account';
    if (!creds.anthropicApi) {
      creds.anthropicApi = { id: defaultAnthropicId, name: defaultAnthropicName };
    } else if (typeof creds.anthropicApi === 'object') {
      if (!creds.anthropicApi.id || creds.anthropicApi.id === 'anthropicApi' || creds.anthropicApi.id.includes('Anthropic')) {
        creds.anthropicApi.id = defaultAnthropicId;
      }
      if (!creds.anthropicApi.name) {
        creds.anthropicApi.name = defaultAnthropicName;
      }
    }
  }

  return Object.keys(creds).length > 0 ? creds : undefined;
}

/**
 * Normalizes parameters for known n8n nodes to ensure conformity with n8n parameter schemas
 * and repair common LLM formatting hallucinations (e.g. nested objects in Gmail message, missing subject).
 */
export function normalizeNodeParameters(nodeType: string, existingParameters?: Record<string, any>): Record<string, any> {
  const params: Record<string, any> = existingParameters ? { ...existingParameters } : {};

  if (nodeType === 'n8n-nodes-base.gmail' || nodeType === 'n8n-nodes-base.gmailTrigger') {
    // 1. Fix nested object in parameters.message: { to, body, emailType, sendTo }
    if (params.message && typeof params.message === 'object' && !Array.isArray(params.message)) {
      const msgObj = params.message;
      const body = msgObj.body || msgObj.text || msgObj.message || msgObj.content || '';
      const to = msgObj.to || msgObj.sendTo || msgObj.email;
      const emailType = msgObj.emailType || msgObj.type || 'text';

      params.message = typeof body === 'string' ? body : JSON.stringify(body);
      params.emailType = emailType;
      if (to) {
        params.options = {
          ...(params.options || {}),
          sendTo: to,
        };
      }
    }

    // 2. Ensure subject is present for draft or message creation/sending
    const resource = params.resource || 'draft';
    const operation = params.operation || 'create';
    if ((resource === 'draft' || resource === 'message') && (!params.subject || typeof params.subject !== 'string' || !params.subject.trim())) {
      params.subject = '={{ $json.subject || "Automated Outreach Notification" }}';
    }

    // 3. Move top-level `to` into `options.sendTo` if options.sendTo is missing
    if (params.to && (!params.options || !params.options.sendTo)) {
      params.options = {
        ...(params.options || {}),
        sendTo: params.to,
      };
      delete params.to;
    }
  }

  if (nodeType === 'n8n-nodes-base.telegram' || nodeType === 'n8n-nodes-base.telegramTrigger') {
    const defaultChatId = process.env.N8N_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '578179283';
    if (!params.chatId || params.chatId === '') {
      params.chatId = defaultChatId;
    }
    if (!params.additionalFields || typeof params.additionalFields !== 'object') {
      params.additionalFields = { parse_mode: 'HTML' };
    } else if (!params.additionalFields.parse_mode) {
      params.additionalFields.parse_mode = 'HTML';
    }
  }

  if (nodeType === 'n8n-nodes-base.mongoDb') {
    if (!params.database || params.database === '') {
      params.database = process.env.MONGO_DB_NAME || 'agentforge';
    }
    if (!params.operation || params.operation === '') {
      params.operation = 'insert';
    }
    if (!params.fieldsToSend || params.fieldsToSend === '') {
      params.fieldsToSend = 'all';
    }
  }

  return params;
}

/**
 * Normalizes connections to enforce Fan-Out when terminal action nodes (like Gmail)
 * are chained serially to other consumer nodes (like MongoDB or Telegram) that depend on
 * the original payload from an upstream producer node.
 */
function normalizeConnectionsFanOut(
  nodes: GraphNodeSpec[],
  connections: GraphConnectionSpec[],
  resolveNodeName: (idOrName: string) => string | undefined,
): GraphConnectionSpec[] {
  const nodeMap = new Map<string, GraphNodeSpec>();
  nodes.forEach((n) => {
    nodeMap.set(n.name, n);
    if (n.id) nodeMap.set(n.id, n);
  });

  // Find incoming producers for each node
  const incomingMap = new Map<string, string[]>();
  connections.forEach((conn) => {
    const fromName = resolveNodeName(conn.from);
    const toName = resolveNodeName(conn.to);
    if (fromName && toName) {
      const list = incomingMap.get(toName) || [];
      list.push(fromName);
      incomingMap.set(toName, list);
    }
  });

  const ACTION_PRODUCING_METADATA_NODES = new Set([
    'n8n-nodes-base.gmail',
    'n8n-nodes-base.emailSend',
  ]);

  const TERMINAL_CONSUMER_NODES = new Set([
    'n8n-nodes-base.mongoDb',
    'n8n-nodes-base.telegram',
    'n8n-nodes-base.slack',
  ]);

  const normalizedConns: GraphConnectionSpec[] = [];

  for (const conn of connections) {
    const fromName = resolveNodeName(conn.from);
    const toName = resolveNodeName(conn.to);
    if (!fromName || !toName) {
      normalizedConns.push(conn);
      continue;
    }

    const fromNode = nodeMap.get(fromName);
    const toNode = nodeMap.get(toName);

    if (
      fromNode &&
      toNode &&
      ACTION_PRODUCING_METADATA_NODES.has(fromNode.type) &&
      TERMINAL_CONSUMER_NODES.has(toNode.type)
    ) {
      // Check if toNode references properties in $json that wouldn't come from Gmail metadata
      const paramStr = JSON.stringify(toNode.parameters || {});
      const hasLeadRef = /\{\{\s*\$json\.(company|email|name|contact|lead|title|domain|website|audit|text)/i.test(paramStr);
      const upstreamProducers = incomingMap.get(fromName) || [];

      if (hasLeadRef && upstreamProducers.length === 1) {
        // Rewire connection to fan out from upstream producer directly!
        const producerName = upstreamProducers[0];
        normalizedConns.push({
          from: producerName,
          to: toName,
          type: conn.type,
          fromOutputIndex: 0,
          toInputIndex: conn.toInputIndex,
        });
        continue;
      }
    }

    normalizedConns.push(conn);
  }

  return normalizedConns;
}

/**
 * Synthesizes a canonical n8n Workflow JSON object from a WorkflowGraphSpec.
 * 
 * Guarantees:
 * 1. 100% compliant n8n connection nested array structure.
 * 2. Unambiguous resolution of connections by node name or node id.
 * 3. Safe automated topological positioning avoiding node overlap.
 * 4. Default executionOrder 'v1' and active: false.
 */
export function synthesizeN8nWorkflow(spec: WorkflowGraphSpec): SynthesizedWorkflow {
  const validation = validateGraphSpec(spec);
  if (!validation.valid) {
    throw new Error(`Invalid WorkflowGraphSpec: ${validation.errors.join('; ')}`);
  }

  // Name and ID lookup
  const nameToNode = new Map<string, GraphNodeSpec>();
  const idToNode = new Map<string, GraphNodeSpec>();
  const usedIds = new Set<string>();

  // Assign deterministic IDs if missing
  const normalizedNodes = spec.nodes.map((node) => {
    let id = node.id;
    if (!id || typeof id !== 'string' || !id.trim()) {
      const slug = node.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      id = slug && !usedIds.has(slug) ? slug : randomUUID();
    }
    usedIds.add(id);

    return {
      ...node,
      id,
    };
  });

  normalizedNodes.forEach((n) => {
    nameToNode.set(n.name, n);
    idToNode.set(n.id!, n);
  });

  const resolveNodeName = (idOrName: string): string | undefined => {
    if (nameToNode.has(idOrName)) return idOrName;
    if (idToNode.has(idOrName)) return idToNode.get(idOrName)!.name;
    return undefined;
  };

  // Normalize connections for parallel Fan-Out where appropriate
  const normalizedConnections = normalizeConnectionsFanOut(normalizedNodes, spec.connections || [], resolveNodeName);

  // Layout calculation
  const positions = computeNodePositions(normalizedNodes, normalizedConnections, resolveNodeName);

  // Build canonical n8n nodes
  const outputNodes = normalizedNodes.map((node) => {
    const position = positions.get(node.name) ?? node.position ?? [240, 300];
    const typeVersion = resolveDefaultTypeVersion(node.type, node.typeVersion);

    // Normalize parameters (e.g. Gmail message flattening, subject injection, Telegram chatId, Mongo DB)
    const parameters = normalizeNodeParameters(node.type, node.parameters);

    const out: any = {
      id: node.id!,
      name: node.name,
      type: node.type,
      typeVersion,
      position,
      parameters,
    };

    const credentials = normalizeNodeCredentials(node.type, node.credentials);
    if (credentials && Object.keys(credentials).length > 0) {
      out.credentials = credentials;
    }

    if (node.notes) {
      out.notes = node.notes;
      out.notesInFlow = true;
    }

    return out;
  });

  // Build canonical n8n connections
  // n8n connections format:
  // connections[sourceName][connectionType][fromOutputIndex] = Array<{ node: targetName, type: connectionType, index: toInputIndex }>
  const connections: Record<string, Record<string, N8nConnectionTarget[][]>> = {};

  normalizedConnections.forEach((conn) => {
    const fromName = resolveNodeName(conn.from);
    const toName = resolveNodeName(conn.to);

    if (!fromName) {
      throw new Error(`Synthesis error: connection source "${conn.from}" does not match any node name or id.`);
    }
    if (!toName) {
      throw new Error(`Synthesis error: connection target "${conn.to}" does not match any node name or id.`);
    }

    const connType = conn.type === 'error' ? 'error' : 'main';
    const fromIndex = typeof conn.fromOutputIndex === 'number' && conn.fromOutputIndex >= 0 ? conn.fromOutputIndex : 0;
    const toIndex = typeof conn.toInputIndex === 'number' && conn.toInputIndex >= 0 ? conn.toInputIndex : 0;

    if (!connections[fromName]) {
      connections[fromName] = {};
    }
    if (!connections[fromName][connType]) {
      connections[fromName][connType] = [];
    }

    const outputArrays = connections[fromName][connType];
    // Ensure sufficient outer array length for output indices
    while (outputArrays.length <= fromIndex) {
      outputArrays.push([]);
    }

    const targetList = outputArrays[fromIndex];
    // Avoid duplicate connection entries
    const alreadyConnected = targetList.some((t) => t.node === toName && t.index === toIndex && t.type === connType);
    if (!alreadyConnected) {
      targetList.push({
        node: toName,
        type: connType,
        index: toIndex,
      });
    }
  });

  return {
    name: spec.name.trim(),
    nodes: outputNodes,
    connections,
    settings: {
      executionOrder: 'v1',
      ...(spec.settings || {}),
    },
    active: spec.active ?? false,
    ...(spec.pinData ? { pinData: spec.pinData } : {}),
    ...(spec.meta ? { meta: spec.meta } : {}),
  };
}
