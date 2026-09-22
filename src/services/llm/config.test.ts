import { describe, expect, it } from 'vitest';
import { buildApiUrl, resolveLLMSettings } from './config';

describe('TypeSafe LLM settings', () => {
  it('builds the System One endpoint', () => {
    expect(buildApiUrl('typesafe', 'https://api.typesafe.ai'))
      .toBe('https://api.typesafe.ai/v1/systemone');
    expect(buildApiUrl('typesafe', 'https://api.typesafe.ai/v1'))
      .toBe('https://api.typesafe.ai/v1/systemone');
    expect(buildApiUrl('typesafe', 'https://api.typesafe.ai/v1/systemone'))
      .toBe('https://api.typesafe.ai/v1/systemone');
  });

  it('defaults TypeSafe to jev-latest', () => {
    expect(resolveLLMSettings({
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: 'test',
    }).model).toBe('jev-latest');
  });
});
