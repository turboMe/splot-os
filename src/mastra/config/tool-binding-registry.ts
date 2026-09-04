/**
 * Tool Binding Registry — Centralny rejestr klasyfikacji i poziomów ryzyka narzędzi w systemie.
 *
 * Zapobiega przypadkowemu podpinaniu narzędzi destrukcyjnych lub płatnych
 * bez odpowiednich bramek approvalowych.
 */

export type ToolRiskLevel =
  | 'read_only'
  | 'local_write'
  | 'external_write'
  | 'destructive'
  | 'financial_or_sensitive';

export interface ToolBindingDefinition {
  readonly id: string;
  readonly name: string;
  readonly category: 'system' | 'coding' | 'knowledge' | 'crm' | 'automation' | 'creative' | 'content' | 'utility';
  readonly riskLevel: ToolRiskLevel;
  readonly requiresApproval: boolean;
  readonly description: string;
}

export const TOOL_BINDING_REGISTRY: Record<string, ToolBindingDefinition> = {
  // System Tools
  system_delegate_task: {
    id: 'system_delegate_task',
    name: 'Delegate Task',
    category: 'system',
    riskLevel: 'local_write',
    requiresApproval: false,
    description: 'Deleguje zadanie do wyspecjalizowanego agenta domenowego.',
  },
  system_request_approval: {
    id: 'system_request_approval',
    name: 'Request Approval',
    category: 'system',
    riskLevel: 'read_only',
    requiresApproval: false,
    description: 'Wstrzymuje wykonanie i prosi użytkownika o decyzję.',
  },
  system_artifact_put: {
    id: 'system_artifact_put',
    name: 'Artifact Put',
    category: 'system',
    riskLevel: 'local_write',
    requiresApproval: false,
    description: 'Zapisuje ustrukturyzowany dokument w magazynie artefaktów.',
  },
  system_skill_save: {
    id: 'system_skill_save',
    name: 'Skill Save',
    category: 'system',
    riskLevel: 'local_write',
    requiresApproval: false,
    description: 'Zapisuje nową procedurę SOP w _skills/auto/ i odświeża rejestr skilli.',
  },
  system_specialist_build: {
    id: 'system_specialist_build',
    name: 'Specialist Build',
    category: 'system',
    riskLevel: 'local_write',
    requiresApproval: false,
    description: 'Buduje i aktywuje nowego specjalistę domenowego na podstawie paszportu SpecialistDossierV1.',
  },

  // Knowledge Tools
  knowledge_lookup: {
    id: 'knowledge_lookup',
    name: 'Knowledge Lookup',
    category: 'knowledge',
    riskLevel: 'read_only',
    requiresApproval: false,
    description: 'Odpytuje podpięte notatniki NotebookLM lub lokalną bazę wektorową.',
  },

  // Coding Tools
  coding_write_file_tracked: {
    id: 'coding_write_file_tracked',
    name: 'Write File Tracked',
    category: 'coding',
    riskLevel: 'local_write',
    requiresApproval: false,
    description: 'Zapisuje plik z rejestracją w task-ledgerze i migawką.',
  },
  coding_execute_command: {
    id: 'coding_execute_command',
    name: 'Execute Command',
    category: 'coding',
    riskLevel: 'destructive',
    requiresApproval: true,
    description: 'Wykonuje polecenie w terminalu sandboxowym.',
  },

  // External Communications / CRM
  crm_update_lead: {
    id: 'crm_update_lead',
    name: 'Update CRM Lead',
    category: 'crm',
    riskLevel: 'external_write',
    requiresApproval: false,
    description: 'Aktualizuje status lub notatkę leada w lokalnym CRM.',
  },
  gmail_send_message: {
    id: 'gmail_send_message',
    name: 'Send Gmail',
    category: 'content',
    riskLevel: 'external_write',
    requiresApproval: true,
    description: 'Wysyła wiadomość e-mail do odbiorcy zewnętrznego.',
  },
} as const;

export function getToolBindingDef(toolId: string): ToolBindingDefinition | undefined {
  return TOOL_BINDING_REGISTRY[toolId];
}
