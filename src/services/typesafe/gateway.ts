import { createHttpError } from '../../utils/errors';
import { resolveLLMSettings } from '../llm/config';
import { StoredLLMSettings } from '../llm/types';
import { SystemOneInvokePayload, SystemOneResult, TypeSafeAnswer } from './types';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 5_000);

    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(Math.max(dateMs - Date.now(), 0), 5_000);
  }
  return Math.min(350 * (2 ** attempt), 3_000);
}

function isTypeSafeAnswer(answer: unknown): answer is TypeSafeAnswer {
  if (!answer || typeof answer !== 'object') return false;
  const value = answer as Record<string, unknown>;
  if (value.type === 'noul') return typeof value.noul === 'number';
  if (value.type === 'choice') {
    return typeof value.choice === 'string' &&
      typeof value.confidence === 'number' &&
      Boolean(value.probabilities) &&
      typeof value.probabilities === 'object';
  }
  if (value.type === 'score') {
    return typeof value.score === 'number' &&
      typeof value.confidence === 'number' &&
      Boolean(value.probabilities) &&
      typeof value.probabilities === 'object';
  }
  return false;
}

function validateResult(data: unknown, requestId?: string): SystemOneResult {
  if (!data || typeof data !== 'object') throw new Error('TypeSafe 返回了无效响应');
  const result = data as Record<string, unknown>;
  if (typeof result.model !== 'string' || !result.answers || typeof result.answers !== 'object') {
    throw new Error('TypeSafe 响应缺少 model 或 answers');
  }

  for (const answer of Object.values(result.answers as Record<string, unknown>)) {
    if (!isTypeSafeAnswer(answer)) throw new Error('TypeSafe 返回了无法识别的答案类型');
  }

  return {
    model: result.model,
    answers: result.answers as Record<string, TypeSafeAnswer>,
    usage: result.usage && typeof result.usage === 'object'
      ? result.usage as SystemOneResult['usage']
      : undefined,
    requestId,
  };
}

export class TypeSafeGateway {
  public static async invoke(
    payload: SystemOneInvokePayload,
    storedSettings: StoredLLMSettings
  ): Promise<SystemOneResult> {
    const settings = resolveLLMSettings(storedSettings);
    if (settings.provider !== 'typesafe') throw new Error('当前未选择 TypeSafe Jev');
    if (!settings.apiKey) throw new Error('未设置 TypeSafe API 密钥');
    if (!settings.apiUrl) throw new Error('未设置 TypeSafe Base URL');
    if (!payload.questions || Object.keys(payload.questions).length === 0) {
      throw new Error('TypeSafe 请求至少需要一个问题');
    }

    const body = JSON.stringify({
      state: payload.state,
      questions: payload.questions,
      model: payload.model || settings.model || 'jev-latest',
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;

      try {
        response = await fetch(settings.apiUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await wait(350 * (2 ** attempt));
          continue;
        }
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('TypeSafe 请求超时');
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) {
        const data = await response.json();
        return validateResult(data, response.headers.get('x-typesafe-request-id') || undefined);
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS - 1) {
        await wait(retryDelayMs(response, attempt));
        continue;
      }

      throw await createHttpError(response, 'TypeSafe 请求失败');
    }

    throw new Error('TypeSafe 请求失败');
  }
}

