// Mock 图片 Provider。
//
// 与 MockVideoProvider 同一个理由：缺配置不该让整条管线起不来。
// 没配图片模型时关键帧走它，产出一张带镜号的占位图——
// 管线能跑通、进度页能看、费用是 0，用户一眼就知道这不是真图。
//
// 它产出的是真实可显示的 PNG（不是几个字节的假数据），
// 因为进度页和后续的首帧输入都会真的去加载这张图，给个坏文件等于把问题推到下游。

import type { ImageGenerateInput, ImageProvider, ImageResult, ProviderCredentials } from './types';

/**
 * 一张 8×8 的深绿色 PNG，base64 硬编码。
 * 不在运行时拼 PNG 字节：那需要 CRC32，写错了就是一个看起来没问题、
 * 但浏览器拒绝渲染的文件——排查这种问题的成本远高于硬编码一个常量。
 */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAJUlEQVR4nGP8//8/AymAiSTVoxpG'
  + 'NYxqGNUwqmFUw6iGUQ1DQQMAy2sD/1j0ZiUAAAAASUVORK5CYII=';

export class MockImageProvider implements ImageProvider {
  readonly name = 'mock-image';

  estimateCents(): number { return 0; }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Mock 不用凭据，但签名要与接口一致
  async generate(input: ImageGenerateInput, _creds?: ProviderCredentials): Promise<ImageResult> {
    if (!input.prompt?.trim()) {
      throw new Error('提示词为空');
    }
    return {
      images: Array.from({ length: input.n ?? 1 }, () => ({
        dataUri: `data:image/png;base64,${PLACEHOLDER_PNG}`,
      })),
      costCents: 0,
      raw: { mock: true, promptChars: input.prompt.length },
    };
  }
}
