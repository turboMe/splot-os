function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasCredentials(node: any): boolean {
  return isRecord(node?.credentials) && Object.keys(node.credentials).length > 0;
}

function buildExistingNodeMaps(existingWorkflow: any): {
  byName: Map<string, any>;
  byId: Map<string, any>;
} {
  const byName = new Map<string, any>();
  const byId = new Map<string, any>();
  const nodes = Array.isArray(existingWorkflow?.nodes) ? existingWorkflow.nodes : [];

  for (const node of nodes) {
    if (typeof node?.name === 'string' && node.name.trim()) byName.set(node.name, node);
    if (typeof node?.id === 'string' && node.id.trim()) byId.set(node.id, node);
  }

  return { byName, byId };
}

function findExistingNode(node: any, maps: ReturnType<typeof buildExistingNodeMaps>): any | null {
  if (typeof node?.name === 'string' && node.name.trim()) {
    const byName = maps.byName.get(node.name);
    if (byName) return byName;
  }
  if (typeof node?.id === 'string' && node.id.trim()) {
    const byId = maps.byId.get(node.id);
    if (byId) return byId;
  }
  return null;
}

/**
 * Preserve existing n8n node credentials during update writes.
 *
 * Repair loops often patch structural fields and accidentally omit credentials
 * that were already present on the live workflow. n8n treats an omitted
 * `node.credentials` as "remove credentials", so update payloads must merge the
 * existing credentials back unless the new workflow explicitly provides them.
 */
export function preserveExistingNodeCredentials<TWorkflow = any>(
  workflow: TWorkflow,
  existingWorkflow: any,
): TWorkflow {
  if (!isRecord(workflow) || !Array.isArray((workflow as any).nodes)) return workflow;
  if (!isRecord(existingWorkflow) || !Array.isArray(existingWorkflow.nodes)) return workflow;

  const cloned: any = cloneJson(workflow);
  const maps = buildExistingNodeMaps(existingWorkflow);

  for (const node of cloned.nodes) {
    if (!isRecord(node)) continue;
    const existingNode = findExistingNode(node, maps);
    if (!hasCredentials(existingNode)) continue;

    if (!hasCredentials(node)) {
      node.credentials = cloneJson(existingNode.credentials);
      continue;
    }

    for (const [credentialType, credentialRef] of Object.entries(existingNode.credentials)) {
      if (node.credentials[credentialType] === undefined || node.credentials[credentialType] === null) {
        node.credentials[credentialType] = cloneJson(credentialRef);
      }
    }
  }

  return cloned as TWorkflow;
}
