import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  consumeFreeProviderRateLimit,
  createFreeProviderRateLimitStore,
  resolveFreeProviderDailyLimit
} from '../../src/engines/server/freeProviderRateLimit.js';
import { prepareBuiltInChatPayloadForModel } from '../../src/engines/server/builtInChatPayload.js';
import { isAllowedPolarisApiOrigin } from '../../src/engines/server/corsOrigin.js';

const DEFAULT_FREE_UPSTREAM_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_FREE_UPSTREAM_PATH = '/chat/completions';
const MIMO_CHAT_COMPLETIONS_URL = 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions';
const SILICONFLOW_CHAT_COMPLETIONS_URL = 'https://api.siliconflow.cn/v1/chat/completions';
const POLARIS_FREE_PROVIDER_MODELS = [
  'openai/gpt-oss-120b:free',
  'openrouter/free',
  'mimo-v2.5-pro',
  'mimo-v2-omni',
  'mimo-v2-pro',
  'mimo-v2-flash',
  'moonshotai/Kimi-K2-Instruct',
  'moonshotai/Kimi-K2-Thinking',
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'Qwen/Qwen3-235B-A22B-Thinking-2507',
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-R1',
  'Pro/MiniMaxAI/MiniMax-M2.5'
] as const;
const DAILY_LIMIT = resolveFreeProviderDailyLimit(process.env);
const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V3';
const rateLimitStore = createFreeProviderRateLimitStore(process.env);

function applyCors(req: VercelRequest, res: VercelResponse) {
  const origin = req.headers.origin || '';
  if (isAllowedPolarisApiOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Polaris-Device-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function getUserId(req: VercelRequest) {
  const deviceId = (req.headers['x-polaris-device-id'] as string | undefined)?.trim();
  if (deviceId) return deviceId;
  const forwarded = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const ip = (req.headers['x-real-ip'] as string | undefined)?.trim();
  if (ip) return ip;
  return 'anonymous';
}

function setRateLimitHeaders(res: VercelResponse, remaining: number) {
  res.setHeader('X-RateLimit-Limit', String(DAILY_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
}

function normalizeMimoPayload(payload: Record<string, unknown>) {
  const normalized = { ...payload };
  const rawMaxTokens = normalized.max_tokens;
  if (rawMaxTokens !== undefined && normalized.max_completion_tokens === undefined) {
    normalized.max_completion_tokens = rawMaxTokens;
  }
  delete normalized.max_tokens;
  return normalized;
}

function resolveFreeModel(rawModel: unknown) {
  if (typeof rawModel !== 'string') return DEFAULT_MODEL;
  const normalized = rawModel.trim();
  return POLARIS_FREE_PROVIDER_MODELS.includes(normalized as typeof POLARIS_FREE_PROVIDER_MODELS[number])
    ? normalized
    : DEFAULT_MODEL;
}

function joinUpstreamUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/g, '')}/${path.replace(/^\/+/g, '')}`;
}

function isPolarisFreeMimoModel(model: string) {
  return model.trim().toLowerCase().startsWith('mimo-');
}

function isPolarisFreeOpenRouterModel(model: string) {
  const normalized = model.trim().toLowerCase();
  return normalized === 'openrouter/free' || normalized.endsWith(':free');
}

function resolveFreeUpstream(model: string) {
  if (isPolarisFreeMimoModel(model)) {
    return {
      apiKey: process.env.MIMO_API_KEY?.trim(),
      url: MIMO_CHAT_COMPLETIONS_URL,
      provider: 'mimo' as const
    };
  }

  if (!isPolarisFreeOpenRouterModel(model)) {
    return {
      apiKey: process.env.SILICONFLOW_API_KEY?.trim(),
      url: SILICONFLOW_CHAT_COMPLETIONS_URL,
      provider: 'siliconflow' as const
    };
  }

  return {
    apiKey: (
      process.env.POLARIS_FREE_UPSTREAM_API_KEY
      || process.env.OPENROUTER_API_KEY
      || process.env.OPENROUTER_KEY
    )?.trim(),
    url: joinUpstreamUrl(
      process.env.POLARIS_FREE_UPSTREAM_BASE_URL?.trim() || DEFAULT_FREE_UPSTREAM_BASE_URL,
      process.env.POLARIS_FREE_UPSTREAM_PATH?.trim() || DEFAULT_FREE_UPSTREAM_PATH
    ),
    provider: 'openrouter' as const
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed', type: 'invalid_request' } });
    return;
  }

  const userId = getUserId(req);

  const payload = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body ?? {});
  const model = resolveFreeModel(payload.model);
  const basePayload = prepareBuiltInChatPayloadForModel(payload, model);
  const upstream = resolveFreeUpstream(model);
  const upstreamApiKey = upstream.apiKey;
  if (!upstreamApiKey) {
    const missingKey =
      upstream.provider === 'mimo'
        ? 'MIMO_API_KEY'
        : upstream.provider === 'siliconflow'
          ? 'SILICONFLOW_API_KEY'
          : 'POLARIS_FREE_UPSTREAM_API_KEY / OPENROUTER_API_KEY';
    res.status(500).json({
      error: {
        message: `${missingKey} 未配置。`,
        type: 'configuration_error'
      }
    });
    return;
  }

  let nextRateLimit;
  try {
    nextRateLimit = await consumeFreeProviderRateLimit({
      store: rateLimitStore,
      userId,
      limit: DAILY_LIMIT
    });
  } catch {
    res.status(503).json({
      error: {
        message: '免费线路限流状态暂时不可用。',
        type: 'rate_limit_unavailable'
      }
    });
    return;
  }
  setRateLimitHeaders(res, nextRateLimit.remaining);
  if (!nextRateLimit.allowed) {
    res.status(429).json({ error: { message: '今天的对话次数用完了，明天再来吧 ✨', type: 'rate_limit' } });
    return;
  }

  const upstreamPayload = upstream.provider === 'mimo' ? normalizeMimoPayload(basePayload) : basePayload;
  const upstreamResponse = await fetch(upstream.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${upstreamApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER?.trim() || 'https://example.com',
      'X-Title': process.env.OPENROUTER_X_TITLE?.trim() || 'Polaris'
    },
    body: JSON.stringify(upstreamPayload)
  });

  res.status(upstreamResponse.status);
  res.setHeader('Cache-Control', 'no-store');
  const contentType = upstreamResponse.headers.get('content-type');
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }

  if (!upstreamResponse.body) {
    res.send(await upstreamResponse.text());
    return;
  }

  Readable.fromWeb(upstreamResponse.body as NodeReadableStream<Uint8Array>).pipe(res);
}
