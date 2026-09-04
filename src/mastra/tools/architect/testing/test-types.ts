export type TestMode = 'mock' | 'manual' | 'real_credentials';

export type TestStatus = 'passed' | 'failed' | 'manual_required' | 'blocked';

export type TestFinding = {
  severity: 'error' | 'warning' | 'info';
  nodeName?: string;
  message: string;
  suggestedFix?: string;
};

export type TestResult = {
  success: boolean;
  status: TestStatus;
  mode: TestMode;
  executionId?: string;
  findings: TestFinding[];
  testPlan?: string[];
};

export type RepairChange = {
  nodeName?: string;
  field: string;
  reason: string;
};

export type RepairResult = {
  success: boolean;
  patchedWorkflow?: any;
  changes: RepairChange[];
  remainingIssues: TestFinding[];
  stopReason?: string;
};
