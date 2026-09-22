import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCaptionWindows, extractMembershipRanges, JevAdDetector } from './ad-detector';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildCaptionWindows', () => {
  it('creates overlapping, ordered windows', () => {
    const captions = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [index, `caption ${index}`])
    );

    const windows = buildCaptionWindows(captions);

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ id: 0, start: 0, end: 17 });
    expect(windows[1]).toMatchObject({ id: 1, start: 14, end: 29 });
  });

  it('ignores empty captions without changing original indexes', () => {
    const windows = buildCaptionWindows({ 0: 'first', 1: ' ', 2: 'third' });
    expect(windows[0].captions.map((caption) => caption.index)).toEqual([0, 2]);
  });
});

describe('extractMembershipRanges', () => {
  const captions = Array.from({ length: 6 }, (_, index) => ({ index: index + 10, text: `c${index}` }));

  it('expands strong evidence through weak boundary captions', () => {
    expect(extractMembershipRanges(captions, [0.1, 0.4, 0.7, 0.8, 0.4, 0.1]))
      .toEqual([{ start: 11, end: 14 }]);
  });

  it('bridges a short ambiguous gap between strong captions', () => {
    const shortCaptions = captions.slice(0, 4);
    expect(extractMembershipRanges(shortCaptions, [0.7, 0.3, 0.32, 0.75]))
      .toEqual([{ start: 10, end: 13 }]);
  });

  it('keeps a single caption only when evidence is very strong', () => {
    expect(extractMembershipRanges(captions.slice(0, 3), [0.1, 0.9, 0.1]))
      .toEqual([{ start: 11, end: 11 }]);
    expect(extractMembershipRanges(captions.slice(0, 3), [0.1, 0.7, 0.1]))
      .toEqual([]);
  });
});

describe('JevAdDetector', () => {
  it('turns typed coarse and caption judgments into an ad interval', async () => {
    const sendMessage = vi.fn().mockImplementation(async ({ payload }) => {
      const questionIds = Object.keys(payload.questions);
      if (questionIds.includes('region_ad')) {
        const answers: Record<string, unknown> = {
          region_ad: { type: 'noul', noul: 0.9 },
          promoted_product: {
            type: 'choice',
            choice: 'product_0',
            probabilities: { product_0: 0.9, none: 0.1 },
            confidence: 0.8,
          },
        };
        [0.1, 0.72, 0.82, 0.7, 0.1].forEach((probability, index) => {
          answers[`caption_${index}`] = { type: 'noul', noul: probability };
        });
        return { success: true, data: { model: 'jev-1.13.0', answers } };
      }

      return {
        success: true,
        data: {
          model: 'jev-1.13.0',
          answers: {
            w0_ad: { type: 'noul', noul: 0.9 },
            w0_purchase: { type: 'noul', noul: 0.8 },
            w0_ordinary: { type: 'noul', noul: 0.1 },
            w0_linked: { type: 'noul', noul: 0.9 },
          },
        },
      };
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    const captions = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [index, `caption ${index}`])
    );
    const result = await JevAdDetector.detectAd({
      title: 'test video',
      topComment: '商品链接',
      additionalMessages: {
        link: { '链接标题': '商品A' },
      },
      captions,
    }, Array.from({ length: 5 }, (_, index) => ({
      content: `caption ${index}`,
      from: index * 2,
      to: index * 2 + 2,
    })));

    expect(JSON.parse(result.text)).toEqual({
      exist: true,
      good_name: ['商品A'],
      index_lists: [[1, 3]],
    });
    expect(result.model).toBe('jev-1.13.0');
    expect(result.isDetectionConfident).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
