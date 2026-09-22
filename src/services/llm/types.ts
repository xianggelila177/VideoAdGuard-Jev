export type LLMProvider = 'openai' | 'anthropic' | 'custom_fetch' | 'typesafe';

export type LLMResponseFormat = 'json' | 'text';

export interface LLMInvokePayload {
  systemPrompt: string;
  userPrompt: string;
  responseFormat: LLMResponseFormat;
  maxTokens: number;
}

export interface LLMInvokeResult {
  text: string;
  provider: LLMProvider;
  model: string;
  requestId?: string;
}

export interface StoredLLMSettings {
  provider?: LLMProvider;
  baseUrl?: string;
  apiUrl?: string;
  apiKey?: string;
  model?: string;
  enableLocalOllama?: boolean;
}

export interface ResolvedLLMSettings {
  provider: LLMProvider;
  apiUrl: string;
  apiKey: string | null;
  model: string;
  baseUrl: string;
}
