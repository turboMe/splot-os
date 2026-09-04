export type ValidationFinding = {
  key?: string;
  message: string;
  nodeName?: string;
  severity: 'info' | 'warning' | 'error' | 'security';
};

export type MissingCredential = {
  service: string;
  required: boolean;
  setupHint: string;
};

export type MissingConfig = {
  key: string;
  description: string;
  required: boolean;
};

export type WorkflowGraphComponent = {
  index: number;
  nodeNames: string[];
  executableNodeNames: string[];
  triggerNodeNames: string[];
  hasTrigger: boolean;
};

export type ValidationResult = {
  valid: boolean;
  profile: 'draft' | 'strict' | 'activation';
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  securityIssues: ValidationFinding[];
  missingCredentials: MissingCredential[];
  missingConfig: MissingConfig[];
  nodeCount: number;
  connectionCount: number;
  triggerCount: number;
  reachableNodeCount: number;
  orphanNodeCount: number;
  disconnectedComponents: WorkflowGraphComponent[];
};
