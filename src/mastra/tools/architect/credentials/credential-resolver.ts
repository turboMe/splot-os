import { getCredentialFromRegistry } from './credential-registry.js';
import { CredentialRef, CredentialRequirement } from './credential-types.js';

export type ResolutionResult = {
  ok: boolean;
  credentials: Record<string, CredentialRef>;
  missing: Array<{ service: string; required: boolean; setupHint: string }>;
};

export function resolveCredentials(requirements: CredentialRequirement[]): ResolutionResult {
  const credentials: Record<string, CredentialRef> = {};
  const missing: any[] = [];
  let allOk = true;

  for (const req of requirements) {
    const resolved = getCredentialFromRegistry(req.service);
    if (resolved) {
      credentials[req.service] = resolved;
    } else if (req.required) {
      allOk = false;
      missing.push({
        service: req.service,
        required: true,
        setupHint: getSetupHint(req.service),
      });
    }
  }

  return {
    ok: allOk,
    credentials,
    missing,
  };
}

function getSetupHint(service: string): string {
  const s = service.toLowerCase();
  if (s === 'telegram') {
    return 'Create credential in n8n UI (Telegram API). Then set N8N_CREDENTIAL_TELEGRAM_ID and N8N_CREDENTIAL_TELEGRAM_NAME in .env.';
  }
  if (s === 'mongo' || s === 'mongodb') {
    return 'Create credential in n8n UI (MongoDB). Then set N8N_CREDENTIAL_MONGO_ID and N8N_CREDENTIAL_MONGO_NAME in .env.';
  }
  return `Missing credential for service ${service} in Mastra registry. Check .env file.`;
}
