import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeSafeGateway } from './gateway';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TypeSafeGateway', () => {
  it('posts a System One request with the configured API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'jev-1.13.0',
      answers: {
        is_ad: { type: 'noul', noul: 0.91 },
      },
      usage: { input_tokens: 42, output_tokens: 2 },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-typesafe-request-id': 'req-test',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await TypeSafeGateway.invoke({
      state: { transcript: 'buy now' },
      questions: {
        is_ad: { type: 'noul', instructions: 'Is this an advertisement?' },
      },
    }, {
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai',
      apiKey: 'test-key',
      model: '',
    });

    expect(result.model).toBe('jev-1.13.0');
    expect(result.requestId).toBe('req-test');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(options.headers.Authorization).toBe('Bearer test-key');
    expect(JSON.parse(options.body)).toMatchObject({ model: 'jev-latest' });
  });
});

