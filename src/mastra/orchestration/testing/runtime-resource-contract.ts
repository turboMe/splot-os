/**
 * Public, non-authoritative declaration of the resources prepared by the
 * strict G0 parent gate. Destructive authority and raw process tokens stay in
 * the parent-only runtime session; the child receives this declaration solely
 * so its signed manifest can be compared with the parent observation.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const TEST_RUNTIME_RESOURCE_CONTRACT_VERSION =
  'g0-runtime-resource-contract/v1' as const;
export const TEST_RUNTIME_RESOURCE_CONTRACT_ENV =
  'ORCHESTRATION_G0_RUNTIME_RESOURCE_CONTRACT' as const;
export const TEST_RUNTIME_PARENT_SOURCE_ENV =
  'ORCHESTRATION_G0_PARENT_SOURCE_IDENTITY' as const;
export const TEST_RUNTIME_ENTRYPOINT_ENV =
  'ORCHESTRATION_G0_SUITE_ENTRYPOINT' as const;
export const TEST_RUNTIME_WORKSPACE_ENV =
  'ORCHESTRATION_G0_WORKSPACE_ROOT' as const;
export const TEST_RUNTIME_SOURCE_ROOT_ENV =
  'ORCHESTRATION_G0_SOURCE_ROOT' as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const SAFE_ROLE_RE = /^[a-z][a-z0-9-]{0,63}$/;

const portLeaseDeclarationSchema = z.object({
  role: z.string().regex(SAFE_ROLE_RE),
  leaseIdHash: z.string().regex(SHA256_RE),
  port: z.number().int().min(1).max(65_535),
}).strict();

const uncontrolledRuntimeResourceContractSchema = z.object({
  schemaVersion: z.literal(TEST_RUNTIME_RESOURCE_CONTRACT_VERSION),
  mode: z.literal('UNCONTROLLED_DIRECT'),
}).strict();

const parentGuardedRuntimeResourceContractSchema = z.object({
  schemaVersion: z.literal(TEST_RUNTIME_RESOURCE_CONTRACT_VERSION),
  mode: z.literal('PARENT_GUARDED_V1'),
  workspaceOwnershipMode: z.literal('PARENT_PRIVATE_DIRECTORY_V1'),
  portOwnershipMode: z.literal('PARENT_BOUND_IPC_HANDOFF_V1'),
  processOwnershipMode: z.literal('LINUX_PROCESS_GROUP_TRUSTED_V1'),
  nodePermissionMode: z.literal('NODE_PERMISSION_NO_CHILD_PROCESS_V1'),
  workspaceRootHash: z.string().regex(SHA256_RE),
  processExecutionIdHash: z.string().regex(SHA256_RE),
  runtimeRunIdHash: z.string().regex(SHA256_RE),
  portLeases: z.array(portLeaseDeclarationSchema).max(8),
  outbound: z.object({
    mode: z.literal('NODE_EGRESS_GUARD_V1'),
    allowedLoopbackPorts: z.array(
      z.number().int().min(1).max(65_535),
    ).min(1).max(16),
    osDefaultDenyProven: z.literal(false),
    externalRequestAbsenceProven: z.literal(false),
  }).strict(),
}).strict().superRefine((contract, context) => {
  const roles = contract.portLeases.map((lease) => lease.role);
  const sortedRoles = [...roles].sort();
  if (
    roles.some((role, index) => role !== sortedRoles[index])
    || new Set(roles).size !== roles.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['portLeases'],
      message: 'port lease roles must be unique and canonically sorted',
    });
  }
  const ports = contract.outbound.allowedLoopbackPorts;
  const sortedPorts = [...ports].sort((left, right) => left - right);
  if (
    ports.some((port, index) => port !== sortedPorts[index])
    || new Set(ports).size !== ports.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['outbound', 'allowedLoopbackPorts'],
      message: 'allowed loopback ports must be unique and numerically sorted',
    });
  }
  for (const lease of contract.portLeases) {
    if (!ports.includes(lease.port)) {
      context.addIssue({
        code: 'custom',
        path: ['portLeases'],
        message: `port lease ${lease.role} is absent from the exact allowlist`,
      });
    }
  }
});

export const testRuntimeResourceContractSchema = z.discriminatedUnion('mode', [
  uncontrolledRuntimeResourceContractSchema,
  parentGuardedRuntimeResourceContractSchema,
]);

export type TestRuntimeResourceContract = z.infer<
  typeof testRuntimeResourceContractSchema
>;
export type ParentGuardedRuntimeResourceContract = z.infer<
  typeof parentGuardedRuntimeResourceContractSchema
>;

function canonicalResourceContractJson(
  contract: TestRuntimeResourceContract,
): string {
  // Every object is produced by strict schemas in a fixed declaration order;
  // the two variable arrays are required to be canonically sorted above.
  return JSON.stringify(testRuntimeResourceContractSchema.parse(contract));
}

export function hashRuntimeResourceContract(
  input: unknown,
): `sha256:${string}` {
  const contract = testRuntimeResourceContractSchema.parse(input);
  return `sha256:${createHash('sha256')
    .update(canonicalResourceContractJson(contract))
    .digest('hex')}`;
}

export function parseRuntimeResourceContractEnv(
  raw: string | undefined,
): TestRuntimeResourceContract {
  if (raw === undefined) {
    return {
      schemaVersion: TEST_RUNTIME_RESOURCE_CONTRACT_VERSION,
      mode: 'UNCONTROLLED_DIRECT',
    };
  }
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) {
    throw new TypeError('runtime resource contract exceeds the fixed environment limit');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    throw new TypeError('runtime resource contract is not valid JSON');
  }
  return testRuntimeResourceContractSchema.parse(candidate);
}
