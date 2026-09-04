import type { TestFinding } from './test-types.js';

/**
 * Parses an n8n execution payload and extracts node-level findings.
 * Works for both sync run output and getExecution(id) responses.
 */
export function analyzeExecution(execution: any): { ok: boolean; findings: TestFinding[] } {
  const findings: TestFinding[] = [];

  if (!execution || typeof execution !== 'object') {
    return {
      ok: false,
      findings: [{ severity: 'error', message: 'Empty execution payload — workflow did not run.' }],
    };
  }

  if (execution.status === 'error' || execution.finished === false) {
    findings.push({
      severity: 'error',
      message: `Execution finished with status="${execution.status ?? 'unknown'}".`,
    });
  }

  // n8n stores per-node results under data.resultData.runData[nodeName] (array of runs)
  const runData = execution?.data?.resultData?.runData ?? execution?.resultData?.runData ?? null;
  const lastNodeExecuted = execution?.data?.resultData?.lastNodeExecuted ?? execution?.resultData?.lastNodeExecuted;

  if (runData && typeof runData === 'object') {
    for (const [nodeName, runs] of Object.entries(runData)) {
      if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        const error = (run as any)?.error;
        if (error) {
          findings.push({
            severity: 'error',
            nodeName,
            message: `Node "${nodeName}" failed: ${error.message ?? error.description ?? 'unknown error'}`,
            suggestedFix: suggestFix(nodeName, error),
          });
        }

        const data = (run as any)?.data?.main;
        if (Array.isArray(data) && data.every((items: any) => Array.isArray(items) && items.length === 0)) {
          findings.push({
            severity: 'warning',
            nodeName,
            message: `Node "${nodeName}" produced empty output.`,
          });
        }
      }
    }
  } else {
    findings.push({
      severity: 'warning',
      message: 'Execution payload had no runData — cannot inspect per-node results.',
    });
  }

  const topLevelError = execution?.data?.resultData?.error ?? execution?.resultData?.error;
  if (topLevelError) {
    findings.push({
      severity: 'error',
      nodeName: lastNodeExecuted,
      message: `Workflow-level error: ${topLevelError.message ?? JSON.stringify(topLevelError).slice(0, 200)}`,
    });
  }

  const ok = !findings.some((f) => f.severity === 'error');
  return { ok, findings };
}

function suggestFix(nodeName: string, error: any): string | undefined {
  const msg = String(error?.message ?? '').toLowerCase();

  if (msg.includes('credential') || msg.includes('unauthorized') || msg.includes('401')) {
    return `Sprawdz credential w n8n UI dla node "${nodeName}". Uzyj architect.resolve_credentials zeby zweryfikowac ID.`;
  }
  if (msg.includes('econnrefused') || msg.includes('enotfound')) {
    return `Endpoint nieosiagalny — uzyj architect.runtime_check zeby zweryfikowac topologie.`;
  }
  if (msg.includes('chatid') || msg.includes('chat_id')) {
    return `Brak chatId — ustaw N8N_TELEGRAM_CHAT_ID w .env.`;
  }
  if (msg.includes('expression') || msg.includes('referenced node')) {
    return `Wyrazenie n8n odwoluje sie do nieistniejacego node — sprawdz architect.validate_workflow.`;
  }
  if (msg.includes('json') && msg.includes('parse')) {
    return `Bledny JSON w outpucie — dodaj walidator (Code node) przed parsowaniem.`;
  }
  return undefined;
}
