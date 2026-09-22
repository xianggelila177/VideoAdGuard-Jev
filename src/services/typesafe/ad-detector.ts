import { normalizeErrorForUser } from '../../utils/errors';
import {
  ChoiceAnswer,
  NoulAnswer,
  SystemOneInvokePayload,
  SystemOneResult,
  TypeSafeAnswer,
  TypeSafeQuestion,
  TypeSafeValue,
} from './types';

const WINDOW_SIZE = 18;
const WINDOW_OVERLAP = 4;
const WINDOWS_PER_REQUEST = 8;
const REGION_PADDING = 4;
const MAX_REGION_CAPTIONS = 72;
const REGION_OVERLAP = 6;
const STRONG_MEMBERSHIP = 0.62;
const WEAK_MEMBERSHIP = 0.38;

export interface JevCaption {
  content: string;
  from: number;
  to: number;
}

export interface JevVideoInfo {
  title: string;
  topComment: string | null;
  additionalMessages: Record<string, Record<string, unknown>> | null;
  captions: Record<number, string>;
  goodNames?: string[];
}

export interface JevDetectionResult {
  text: string;
  provider: 'typesafe';
  model: string;
  confidenceScore: number;
  isDetectionConfident: boolean;
}

export interface CaptionWindow {
  id: number;
  start: number;
  end: number;
  captions: Array<{ index: number; text: string }>;
}

interface WindowEvidence extends CaptionWindow {
  adProbability: number;
  purchaseProbability: number;
  ordinaryProbability: number;
  linkedProductProbability: number;
}

interface IndexRange {
  start: number;
  end: number;
}

interface SystemOneMessageResponse {
  success: boolean;
  data?: SystemOneResult;
  error?: string;
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: number[], fallback = 0): number {
  if (!values.length) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function makeNoul(instructions: string, yes: string, no: string): TypeSafeQuestion {
  return {
    type: 'noul',
    instructions,
    criteria: {
      true: yes,
      false: no,
    },
  };
}

function requireNoul(answers: Record<string, TypeSafeAnswer>, id: string): number {
  const answer = answers[id] as NoulAnswer | undefined;
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul)) {
    throw new Error(`TypeSafe 响应缺少判断结果: ${id}`);
  }
  return clampProbability(answer.noul);
}

function optionalChoice(answers: Record<string, TypeSafeAnswer>, id: string): ChoiceAnswer | null {
  const answer = answers[id] as ChoiceAnswer | undefined;
  if (!answer || answer.type !== 'choice' || typeof answer.choice !== 'string') return null;
  return answer;
}

async function invokeSystemOne(payload: SystemOneInvokePayload): Promise<SystemOneResult> {
  const response = (await chrome.runtime.sendMessage({
    type: 'SYSTEM_ONE_INVOKE',
    payload,
  }).catch((error) => {
    throw new Error(normalizeErrorForUser(error, 'llm'));
  })) as SystemOneMessageResponse;

  if (!response?.success || !response.data) {
    throw new Error(normalizeErrorForUser(response?.error || 'TypeSafe 未返回结果', 'llm'));
  }
  return response.data;
}

export function buildCaptionWindows(captions: Record<number, string>): CaptionWindow[] {
  const ordered = Object.entries(captions)
    .map(([index, text]) => ({ index: Number(index), text: String(text || '').trim() }))
    .filter((item) => Number.isInteger(item.index) && item.text.length > 0)
    .sort((a, b) => a.index - b.index);

  if (!ordered.length) return [];

  const stride = WINDOW_SIZE - WINDOW_OVERLAP;
  const windows: CaptionWindow[] = [];
  for (let offset = 0; offset < ordered.length; offset += stride) {
    const slice = ordered.slice(offset, offset + WINDOW_SIZE);
    if (!slice.length) break;
    windows.push({
      id: windows.length,
      start: slice[0].index,
      end: slice[slice.length - 1].index,
      captions: slice,
    });
    if (offset + WINDOW_SIZE >= ordered.length) break;
  }
  return windows;
}

function collectProductCandidates(videoInfo: JevVideoInfo): string[] {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized && normalized.length <= 180) candidates.add(normalized);
  };

  (videoInfo.goodNames || []).forEach(add);
  for (const message of Object.values(videoInfo.additionalMessages || {})) {
    for (const [key, value] of Object.entries(message || {})) {
      if (key.includes('标题') || key.toLowerCase().includes('title')) add(value);
    }
  }
  return Array.from(candidates).slice(0, 12);
}

function videoState(videoInfo: JevVideoInfo, productCandidates: string[]): Record<string, TypeSafeValue> {
  return {
    title: videoInfo.title,
    top_comment: videoInfo.topComment || null,
    linked_product_titles: productCandidates,
    detection_policy: {
      advertisement: 'Creator-inserted commercial promotion or paid sponsorship intended to drive a purchase, signup, download, subscription, or other conversion.',
      not_advertisement: 'Ordinary editorial content, an independent review or comparison, incidental product mention, platform UI, or creator discussion without a commercial call to action.',
      full_segment: 'Includes the transition into the promotion, the product or service pitch, price or benefit details, purchase guidance, and the closing transition when present.',
    },
  };
}

async function classifyWindowBatch(
  videoInfo: JevVideoInfo,
  productCandidates: string[],
  windows: CaptionWindow[]
): Promise<{ evidence: WindowEvidence[]; model: string }> {
  const questions: Record<string, TypeSafeQuestion> = {};
  windows.forEach((window, localIndex) => {
    const path = `windows[${localIndex}].captions`;
    questions[`w${window.id}_ad`] = makeNoul(
      `Does the transcript window at \`${path}\` contain or substantially overlap a creator-inserted commercial advertisement or paid sponsorship as defined in \`video.detection_policy.advertisement\`? Judge the spoken content, not merely the presence of a product name.`,
      'The window contains a commercial pitch or sponsorship intended to cause a conversion, including its lead-in or closing.',
      'The window is ordinary video content, an independent review, or an incidental mention without a commercial pitch.'
    );
    questions[`w${window.id}_purchase`] = makeNoul(
      `Does \`${path}\` contain conversion guidance such as a price, discount, coupon, buying channel, link, app download, signup, subscription, or an explicit recommendation to act?`,
      'There is concrete conversion guidance or a call to action.',
      'There is no conversion guidance or call to action.'
    );
    questions[`w${window.id}_ordinary`] = makeNoul(
      `Is \`${path}\` ordinary editorial content or an independent product discussion without evidence of a creator-inserted commercial promotion?`,
      'It is ordinary editorial or independent discussion, not an inserted advertisement.',
      'It contains evidence of an inserted commercial promotion or sponsorship.'
    );
    if (productCandidates.length) {
      questions[`w${window.id}_linked`] = makeNoul(
        `Does the commercial subject discussed in \`${path}\`, if any, match one of \`video.linked_product_titles\`?`,
        'The promoted subject clearly matches at least one linked product title.',
        'There is no promoted subject or it does not match the linked product titles.'
      );
    }
  });

  const state: TypeSafeValue = {
    video: videoState(videoInfo, productCandidates),
    windows: windows.map((window) => ({
      start_caption_index: window.start,
      end_caption_index: window.end,
      captions: window.captions,
    })),
  };
  const result = await invokeSystemOne({ state, questions });

  return {
    model: result.model,
    evidence: windows.map((window) => ({
      ...window,
      adProbability: requireNoul(result.answers, `w${window.id}_ad`),
      purchaseProbability: requireNoul(result.answers, `w${window.id}_purchase`),
      ordinaryProbability: requireNoul(result.answers, `w${window.id}_ordinary`),
      linkedProductProbability: productCandidates.length
        ? requireNoul(result.answers, `w${window.id}_linked`)
        : 0,
    })),
  };
}

function isCandidateWindow(window: WindowEvidence, hasLinkedProducts: boolean): boolean {
  const conversionEvidence = Math.max(
    window.purchaseProbability,
    hasLinkedProducts ? window.linkedProductProbability : 0
  );
  return (
    window.adProbability >= 0.58 &&
    window.ordinaryProbability <= 0.78 &&
    (conversionEvidence >= 0.35 || window.adProbability >= 0.82)
  );
}

function mergeRanges(ranges: IndexRange[], maxGap = 0): IndexRange[] {
  const ordered = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: IndexRange[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end + maxGap + 1) {
      merged.push({ ...range });
    } else {
      last.end = Math.max(last.end, range.end);
    }
  }
  return merged;
}

function splitRegion(range: IndexRange, captionCount: number): IndexRange[] {
  const expanded = {
    start: Math.max(0, range.start - REGION_PADDING),
    end: Math.min(captionCount - 1, range.end + REGION_PADDING),
  };
  if (expanded.end - expanded.start + 1 <= MAX_REGION_CAPTIONS) return [expanded];

  const regions: IndexRange[] = [];
  const stride = MAX_REGION_CAPTIONS - REGION_OVERLAP;
  for (let start = expanded.start; start <= expanded.end; start += stride) {
    regions.push({ start, end: Math.min(expanded.end, start + MAX_REGION_CAPTIONS - 1) });
    if (start + MAX_REGION_CAPTIONS - 1 >= expanded.end) break;
  }
  return regions;
}

export function extractMembershipRanges(
  captions: Array<{ index: number; text: string }>,
  probabilities: number[]
): IndexRange[] {
  if (captions.length !== probabilities.length || captions.length === 0) return [];
  const included = probabilities.map((value) => value >= STRONG_MEMBERSHIP);

  for (let i = 0; i < included.length; i += 1) {
    if (!included[i]) continue;
    for (let left = i - 1; left >= 0 && probabilities[left] >= WEAK_MEMBERSHIP; left -= 1) {
      included[left] = true;
    }
    for (let right = i + 1; right < included.length && probabilities[right] >= WEAK_MEMBERSHIP; right += 1) {
      included[right] = true;
    }
  }

  for (let i = 0; i < included.length; i += 1) {
    if (included[i]) continue;
    let end = i;
    while (end + 1 < included.length && !included[end + 1]) end += 1;
    const gapLength = end - i + 1;
    const bridged = i > 0 && end + 1 < included.length && included[i - 1] && included[end + 1];
    if (bridged && gapLength <= 2 && probabilities.slice(i, end + 1).every((value) => value >= 0.25)) {
      for (let cursor = i; cursor <= end; cursor += 1) included[cursor] = true;
    }
    i = end;
  }

  const ranges: IndexRange[] = [];
  for (let i = 0; i < included.length; i += 1) {
    if (!included[i]) continue;
    let end = i;
    while (end + 1 < included.length && included[end + 1]) end += 1;
    const peak = Math.max(...probabilities.slice(i, end + 1));
    if (end > i || peak >= 0.83) {
      ranges.push({ start: captions[i].index, end: captions[end].index });
    }
    i = end;
  }
  return ranges;
}

async function refineRegion(
  videoInfo: JevVideoInfo,
  productCandidates: string[],
  range: IndexRange,
  modelHint: string
): Promise<{
  ranges: IndexRange[];
  probabilities: Map<number, number>;
  regionProbability: number;
  productName: string | null;
  model: string;
}> {
  const regionCaptions: Array<{ index: number; text: string }> = [];
  for (let index = range.start; index <= range.end; index += 1) {
    const text = videoInfo.captions[index];
    if (typeof text === 'string' && text.trim()) regionCaptions.push({ index, text: text.trim() });
  }
  if (!regionCaptions.length) {
    return { ranges: [], probabilities: new Map(), regionProbability: 0, productName: null, model: modelHint };
  }

  const questions: Record<string, TypeSafeQuestion> = {
    region_ad: makeNoul(
      'Does `region.captions` contain a creator-inserted commercial advertisement or paid sponsorship under `video.detection_policy`, rather than only ordinary editorial content?',
      'The region contains a commercial promotion or sponsorship intended to cause a conversion.',
      'The region is ordinary content, an independent review, or an incidental mention.'
    ),
  };

  regionCaptions.forEach((caption, localIndex) => {
    questions[`caption_${caption.index}`] = makeNoul(
      `Is the caption at \`region.captions[${localIndex}].text\` part of the creator-inserted advertisement within \`region.captions\`? Include an advertisement's transition or lead-in, product pitch, benefits, price, purchase guidance, and closing transition. Exclude neighboring regular video content.`,
      'This caption belongs to the complete advertisement segment.',
      'This caption belongs to surrounding ordinary video content.'
    );
  });

  const productOptionMap = new Map<string, string>();
  if (productCandidates.length) {
    const criteria: Record<string, string | null> = { none: 'No listed candidate is commercially promoted in this region.' };
    productCandidates.forEach((candidate, index) => {
      const id = `product_${index}`;
      productOptionMap.set(id, candidate);
      criteria[id] = candidate;
    });
    questions.promoted_product = {
      type: 'choice',
      instructions: 'Which candidate in `video.linked_product_titles` is the main product or service commercially promoted in `region.captions`? Select `none` when the region does not promote one of the listed candidates.',
      criteria,
    };
  }

  const state: TypeSafeValue = {
    video: videoState(videoInfo, productCandidates),
    region: {
      start_caption_index: range.start,
      end_caption_index: range.end,
      captions: regionCaptions,
    },
  };
  const result = await invokeSystemOne({ state, questions, model: modelHint || undefined });
  const regionProbability = requireNoul(result.answers, 'region_ad');
  const membership = regionCaptions.map((caption) => requireNoul(result.answers, `caption_${caption.index}`));
  const strongPeak = Math.max(...membership);
  const ranges = regionProbability >= 0.5 || strongPeak >= 0.78
    ? extractMembershipRanges(regionCaptions, membership)
    : [];
  const probabilities = new Map<number, number>();
  regionCaptions.forEach((caption, index) => probabilities.set(caption.index, membership[index]));

  const productChoice = optionalChoice(result.answers, 'promoted_product');
  const productName = productChoice && productChoice.confidence >= 0.35
    ? productOptionMap.get(productChoice.choice) || null
    : null;

  return {
    ranges,
    probabilities,
    regionProbability,
    productName,
    model: result.model,
  };
}

function computeConfidence(
  ranges: IndexRange[],
  probabilityByCaption: Map<number, number>,
  regionProbabilities: number[],
  coarseProbabilities: number[]
): number {
  const inside: number[] = [];
  const outside: number[] = [];
  ranges.forEach((range) => {
    for (let index = range.start; index <= range.end; index += 1) {
      const value = probabilityByCaption.get(index);
      if (value !== undefined) inside.push(value);
    }
    const before = probabilityByCaption.get(range.start - 1);
    const after = probabilityByCaption.get(range.end + 1);
    if (before !== undefined) outside.push(1 - before);
    if (after !== undefined) outside.push(1 - after);
  });

  return clampProbability(
    average(inside, 0.5) * 0.45 +
    average(regionProbabilities, 0.5) * 0.30 +
    Math.max(...coarseProbabilities, 0.5) * 0.15 +
    average(outside, 0.5) * 0.10
  );
}

export class JevAdDetector {
  public static async detectAd(videoInfo: JevVideoInfo, captionTimeline: JevCaption[]): Promise<JevDetectionResult> {
    const windows = buildCaptionWindows(videoInfo.captions);
    if (!windows.length) throw new Error('没有可供 Jev 分析的字幕');

    const productCandidates = collectProductCandidates(videoInfo);
    const evidence: WindowEvidence[] = [];
    let resolvedModel = 'jev-latest';

    for (let offset = 0; offset < windows.length; offset += WINDOWS_PER_REQUEST) {
      const batch = windows.slice(offset, offset + WINDOWS_PER_REQUEST);
      const batchResult = await classifyWindowBatch(videoInfo, productCandidates, batch);
      evidence.push(...batchResult.evidence);
      resolvedModel = batchResult.model;
    }

    const candidateWindows = evidence.filter((window) => isCandidateWindow(window, productCandidates.length > 0));
    if (!candidateWindows.length) {
      return {
        text: JSON.stringify({ exist: false, good_name: [], index_lists: [] }),
        provider: 'typesafe',
        model: resolvedModel,
        confidenceScore: clampProbability(1 - Math.max(...evidence.map((item) => item.adProbability), 0)),
        isDetectionConfident: false,
      };
    }

    const mergedCandidates = mergeRanges(
      candidateWindows.map((window) => ({ start: window.start, end: window.end })),
      WINDOW_OVERLAP
    );
    const regions = mergedCandidates.flatMap((range) => splitRegion(range, captionTimeline.length));
    const refinedRanges: IndexRange[] = [];
    const probabilityByCaption = new Map<number, number>();
    const regionProbabilities: number[] = [];
    const productNames = new Set<string>();

    for (const region of regions) {
      const refined = await refineRegion(videoInfo, productCandidates, region, resolvedModel);
      refinedRanges.push(...refined.ranges);
      regionProbabilities.push(refined.regionProbability);
      resolvedModel = refined.model;
      if (refined.productName) productNames.add(refined.productName);
      for (const [index, probability] of refined.probabilities) {
        probabilityByCaption.set(index, Math.max(probabilityByCaption.get(index) || 0, probability));
      }
    }

    const mergedRanges = mergeRanges(refinedRanges, 2)
      .filter((range) => range.start >= 0 && range.end < captionTimeline.length && range.end >= range.start);
    const confidenceScore = mergedRanges.length
      ? computeConfidence(
          mergedRanges,
          probabilityByCaption,
          regionProbabilities,
          candidateWindows.map((window) => window.adProbability)
        )
      : 0;
    const isDetectionConfident = mergedRanges.length > 0 && mergedRanges.length <= 3 && confidenceScore >= 0.76;

    return {
      text: JSON.stringify({
        exist: mergedRanges.length > 0,
        good_name: Array.from(productNames),
        index_lists: mergedRanges.map((range) => [range.start, range.end]),
      }),
      provider: 'typesafe',
      model: resolvedModel,
      confidenceScore,
      isDetectionConfident,
    };
  }
}

