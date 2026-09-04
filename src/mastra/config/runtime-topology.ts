export type RuntimeTopology = {
  mode: 'local-host-network' | 'docker-compose-network';
  mastraStudioUrl: string;
  mastraApiUrlForN8n: string;
  n8nRestBaseUrl: string;
  n8nPublicWebhookBaseUrl?: string;
  ollamaBaseUrlForN8n: string;
  mongoUriForMastra: string;
  mongoHostForN8n: string;
  mongoDbName: string;
};

export function getRuntimeTopology(): RuntimeTopology {
  const mode =
    process.env.RUNTIME_MODE === 'docker-compose-network' ? 'docker-compose-network' : 'local-host-network';

  return {
    mode,
    mastraStudioUrl: process.env.MASTRA_STUDIO_URL ?? 'http://localhost:4111',
    mastraApiUrlForN8n: process.env.MASTRA_API_URL_FOR_N8N ?? 'http://localhost:4111',
    n8nRestBaseUrl: process.env.N8N_BASE_URL ?? process.env.N8N_URL ?? 'http://localhost:5678',
    n8nPublicWebhookBaseUrl: process.env.N8N_PUBLIC_WEBHOOK_BASE_URL ?? process.env.N8N_WEBHOOK_URL,
    ollamaBaseUrlForN8n: process.env.OLLAMA_BASE_URL_FOR_N8N ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    mongoUriForMastra: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/agentforge',
    mongoHostForN8n: process.env.MONGO_HOST_FOR_N8N ?? 'localhost:27017',
    mongoDbName: process.env.MONGO_DB_NAME ?? 'agentforge',
  };
}
