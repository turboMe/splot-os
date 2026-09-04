import { CredentialRef } from './credential-types.js';

export function getCredentialFromRegistry(service: string): CredentialRef | undefined {
  const s = service.toLowerCase();

  if (s === 'telegram') {
    const id = process.env.N8N_CREDENTIAL_TELEGRAM_ID;
    const name = process.env.N8N_CREDENTIAL_TELEGRAM_NAME || 'Telegram Bot';
    if (id) {
      return { service: 'telegram', n8nCredentialType: 'telegramApi', id, name };
    }
  }

  if (s === 'mongo' || s === 'mongodb') {
    const id = process.env.N8N_CREDENTIAL_MONGO_ID;
    const name = process.env.N8N_CREDENTIAL_MONGO_NAME || 'MongoDB';
    if (id) {
      return { service: 'mongo', n8nCredentialType: 'mongoDb', id, name };
    }
  }

  if (s === 'gmail') {
    const id = process.env.N8N_CREDENTIAL_GMAIL_ID;
    const name = process.env.N8N_CREDENTIAL_GMAIL_NAME || 'Gmail account';
    const credentialType = process.env.N8N_CREDENTIAL_GMAIL_TYPE || 'gmailOAuth2';
    if (id) {
      return { service: 'gmail', n8nCredentialType: credentialType, id, name };
    }
  }

  if (s === 'openai') {
    const id = process.env.N8N_CREDENTIAL_OPENAI_ID || 'VKJ0rkJ0Ya4kgysY';
    const name = process.env.N8N_CREDENTIAL_OPENAI_NAME || 'OpenAI account';
    return { service: 'openai', n8nCredentialType: 'openAiApi', id, name };
  }

  if (s === 'anthropic' || s === 'claude') {
    const id = process.env.N8N_CREDENTIAL_ANTHROPIC_ID || 'w4M1TuGuFM6H9AqT';
    const name = process.env.N8N_CREDENTIAL_ANTHROPIC_NAME || 'Anthropic account';
    return { service: 'anthropic', n8nCredentialType: 'anthropicApi', id, name };
  }

  if (s === 'googlemaps' || s === 'googleplaces' || s === 'places') {
    const id = process.env.N8N_CREDENTIAL_PLACES_ID || 'W3CMNQ7REtI8EDfC';
    const name = process.env.N8N_CREDENTIAL_PLACES_NAME || 'Google Places API Header Auth';
    return { service: 'googleplaces', n8nCredentialType: 'httpHeaderAuth', id, name };
  }

  if (s === 'firecrawl') {
    const id = process.env.N8N_CREDENTIAL_FIRECRAWL_ID || '4h4mHT9veScmIMWq';
    const name = process.env.N8N_CREDENTIAL_FIRECRAWL_NAME || 'Firecrawl API Header Auth';
    return { service: 'firecrawl', n8nCredentialType: 'httpHeaderAuth', id, name };
  }

  if (s === 'groq') {
    const id = process.env.N8N_CREDENTIAL_GROQ_ID || 'dxsXsuCjcemXFpVk';
    const name = process.env.N8N_CREDENTIAL_GROQ_NAME || 'Groq account';
    return { service: 'groq', n8nCredentialType: 'openAiApi', id, name };
  }

  if (s === 'deepseek') {
    const id = process.env.N8N_CREDENTIAL_DEEPSEEK_ID || 'VZ8hoHmM4CguZavw';
    const name = process.env.N8N_CREDENTIAL_DEEPSEEK_NAME || 'DeepSeek account';
    return { service: 'deepseek', n8nCredentialType: 'openAiApi', id, name };
  }

  // Fallback for generic HTTP auth if needed
  if (s === 'httpheaderauth') {
    const id = process.env.N8N_CREDENTIAL_HTTP_ID;
    if (id) {
      return {
        service: 'httpHeaderAuth',
        n8nCredentialType: 'httpHeaderAuth',
        id,
        name: process.env.N8N_CREDENTIAL_HTTP_NAME || 'HTTP Header Auth',
      };
    }
  }

  return undefined;
}
