export type CredentialRef = {
  service: 'telegram' | 'mongo' | 'gmail' | 'smtp' | 'httpHeaderAuth' | 'n8nApi' | string;
  n8nCredentialType: string;
  id: string;
  name: string;
};

export type CredentialRequirement = {
  service: string;
  required: boolean;
  credentialName?: string;
};
