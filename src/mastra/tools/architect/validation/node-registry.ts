/**
 * Supported `typeVersion` values per node type.
 *
 * RECONCILED 2026-08-24 against the live instance (n8n 2.17.8, container
 * `af-n8n`) by instantiating each node class and merging `description.version`
 * with the `nodeVersions` keys that `VersionedNodeType` exposes. 25 of the 37
 * entries here were stale, and that staleness was load-bearing: the validator
 * emitted "Unexpected typeVersion" warnings for perfectly valid workflows so
 * routinely that the architect learned to dismiss the warning as noise — and
 * then dismissed the one true instance of it, deploying `rssFeedRead`
 * typeVersion 2.5, which does not exist on this install at all.
 *
 * Regenerate the same way after an n8n upgrade rather than editing by hand;
 * a guessed value here is indistinguishable from a real one to every consumer.
 */
export const KNOWN_NODE_TYPES: Record<string, number[]> = {
  'n8n-nodes-base.webhook': [1, 1.1, 2, 2.1],
  'n8n-nodes-base.scheduleTrigger': [1, 1.1, 1.2, 1.3],
  'n8n-nodes-base.manualTrigger': [1],
  'n8n-nodes-base.errorTrigger': [1],
  'n8n-nodes-base.telegramTrigger': [1, 1.1, 1.2],
  'n8n-nodes-base.formTrigger': [2, 2.1, 2.2, 2.3, 2.4, 2.5],
  'n8n-nodes-base.emailReadImap': [2, 2.1],
  'n8n-nodes-base.gmail': [2, 2.1, 2.2],
  'n8n-nodes-base.gmailTrigger': [1, 1.1, 1.2, 1.3],
  'n8n-nodes-base.executeWorkflowTrigger': [1, 1.1],
  'n8n-nodes-base.code': [1, 2],
  'n8n-nodes-base.if': [1, 2, 2.1, 2.2, 2.3],
  'n8n-nodes-base.switch': [1, 2, 3, 3.1, 3.2, 3.3, 3.4],
  'n8n-nodes-base.set': [3, 3.1, 3.2, 3.3, 3.4],
  'n8n-nodes-base.merge': [3, 3.1, 3.2],
  'n8n-nodes-base.splitInBatches': [3],
  'n8n-nodes-base.filter': [1, 2, 2.1, 2.2, 2.3],
  'n8n-nodes-base.removeDuplicates': [2],
  'n8n-nodes-base.httpRequest': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4],
  'n8n-nodes-base.respondToWebhook': [1, 1.1, 1.2, 1.3, 1.4, 1.5],
  'n8n-nodes-base.telegram': [1, 1.1, 1.2],
  'n8n-nodes-base.cron': [1],
  'n8n-nodes-base.function': [1],
  'n8n-nodes-base.aggregate': [1],
  'n8n-nodes-base.html': [1, 1.1, 1.2],
  'n8n-nodes-base.emailSend': [2, 2.1],
  'n8n-nodes-base.slack': [1, 2, 2.1, 2.2, 2.3, 2.4],
  'n8n-nodes-base.mongoDb': [1, 1.1, 1.2],
  'n8n-nodes-base.postgres': [2, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6],
  'n8n-nodes-base.rssFeedRead': [1, 1.1, 1.2],
  'n8n-nodes-base.rssFeedReadTrigger': [1],
  'n8n-nodes-base.readWriteFile': [1, 1.1],
  'n8n-nodes-base.dateTime': [1],
  'n8n-nodes-base.crypto': [2],
  'n8n-nodes-base.wait': [1, 1.1],
  'n8n-nodes-base.noOp': [1],
  'n8n-nodes-base.stickyNote': [1],
  'n8n-nodes-base.googleSheets': [1, 2, 3, 4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7],
  'n8n-nodes-base.mysql': [2, 2.1, 2.2, 2.3, 2.4],
  'n8n-nodes-base.redis': [1, 1.1, 1.2, 1.3],
  'n8n-nodes-base.airtable': [1, 2, 2.1],
  'n8n-nodes-base.notion': [2, 2.1, 2.2],
  'n8n-nodes-base.jira': [1],
  'n8n-nodes-base.github': [1],
  'n8n-nodes-base.stripe': [1],
  'n8n-nodes-base.sort': [1],
  'n8n-nodes-base.limit': [1],
  'n8n-nodes-base.itemLists': [1, 2, 2.1, 2.2, 3],
  'n8n-nodes-base.editFields': [1, 2],
  'n8n-nodes-base.compareDatasets': [2, 2.1, 2.2],
  'n8n-nodes-base.splitOut': [1],
  '@n8n/n8n-nodes-langchain.agent': [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7],
  '@n8n/n8n-nodes-langchain.chainLlm': [1, 1.1, 1.2, 1.3, 1.4],
  '@n8n/n8n-nodes-langchain.chainSummarization': [1, 1.1, 1.2],
  '@n8n/n8n-nodes-langchain.lmChatOpenAi': [1, 1.1, 1.2],
  '@n8n/n8n-nodes-langchain.lmChatOllama': [1],
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': [1, 1.1, 1.2],
  '@n8n/n8n-nodes-langchain.lmChatGoogleGemini': [1],
  '@n8n/n8n-nodes-langchain.memoryBufferWindow': [1, 1.1, 1.2],
  '@n8n/n8n-nodes-langchain.vectorStoreInMemory': [1],
  '@n8n/n8n-nodes-langchain.toolWorkflow': [1, 1.1],
  '@n8n/n8n-nodes-langchain.toolCustom': [1, 1.1],
  '@n8n/n8n-nodes-langchain.toolCalculator': [1],
};

const DYNAMIC_NODE_TYPES: Record<string, number[]> = {};

export function registerKnownNodeType(nodeType: string, versions: number[]): void {
  DYNAMIC_NODE_TYPES[nodeType] = Array.from(new Set([...(DYNAMIC_NODE_TYPES[nodeType] || []), ...versions])).sort((a, b) => a - b);
}

export function getKnownNodeTypes(): Record<string, number[]> {
  return {
    ...KNOWN_NODE_TYPES,
    ...DYNAMIC_NODE_TYPES,
  };
}

export function isKnownNodeType(nodeType: string): boolean {
  return nodeType in KNOWN_NODE_TYPES || nodeType in DYNAMIC_NODE_TYPES;
}

export function getKnownTypeVersions(nodeType: string): number[] | undefined {
  return DYNAMIC_NODE_TYPES[nodeType] ?? KNOWN_NODE_TYPES[nodeType];
}

export const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.rssFeedReadTrigger',
  'n8n-nodes-base.telegramTrigger',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.gmailTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
]);

export const NON_ACTIVATABLE_TRIGGER_TYPES = new Set([
  'n8n-nodes-base.manualTrigger',
]);

export const FORBIDDEN_NODE_TYPES = [
  'n8n-nodes-base.executeCommand',
  'n8n-nodes-base.readBinaryFile',
  'n8n-nodes-base.readBinaryFiles',
  'n8n-nodes-base.writeBinaryFile',
  'n8n-nodes-base.readWriteFile',
  'n8n-nodes-base.ssh',
  'n8n-nodes-base.executeSsh',
];

