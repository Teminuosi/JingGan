export const DIALOGUE_LANGUAGES = [
  { value: 'English', label: '英语' },
  { value: '简体中文', label: '中文（简体）' },
  { value: '繁體中文', label: '中文（繁体）' },
  { value: 'Cantonese', label: '粤语' },
  { value: 'Japanese', label: '日语' },
  { value: 'Korean', label: '韩语' },
  { value: 'Spanish', label: '西班牙语' },
  { value: 'French', label: '法语' },
  { value: 'German', label: '德语' },
  { value: 'Portuguese (Brazil)', label: '葡萄牙语（巴西）' },
  { value: 'Portuguese (Portugal)', label: '葡萄牙语（葡萄牙）' },
  { value: 'Italian', label: '意大利语' },
  { value: 'Russian', label: '俄语' },
  { value: 'Arabic', label: '阿拉伯语' },
  { value: 'Hindi', label: '印地语' },
  { value: 'Bengali', label: '孟加拉语' },
  { value: 'Indonesian', label: '印度尼西亚语' },
  { value: 'Malay', label: '马来语' },
  { value: 'Thai', label: '泰语' },
  { value: 'Vietnamese', label: '越南语' },
  { value: 'Filipino', label: '菲律宾语' },
  { value: 'Turkish', label: '土耳其语' },
  { value: 'Dutch', label: '荷兰语' },
  { value: 'Polish', label: '波兰语' },
] as const;

const LANGUAGE_CODES: Record<string, string> = { en: 'English', zh: '简体中文', 'zh-cn': '简体中文', 'zh-hans': '简体中文', 'zh-tw': '繁體中文', 'zh-hant': '繁體中文', yue: 'Cantonese', ja: 'Japanese', ko: 'Korean', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', ru: 'Russian', pt: 'Portuguese (Brazil)', ar: 'Arabic', hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian' };

/** 分析里的 source.language 写法不一（en / zh / 中文 / English），统一成下拉里的 value；认不出就原样返回。 */
export function normalizeLanguage(value: string): string {
  const raw = value.trim();
  const lower = raw.toLowerCase();
  if (LANGUAGE_CODES[lower]) return LANGUAGE_CODES[lower];
  if (/^(中文|汉语|普通话|chinese|mandarin)$/i.test(raw)) return '简体中文';
  return DIALOGUE_LANGUAGES.find(item => item.value.toLowerCase() === lower || item.label === raw)?.value ?? raw;
}

export const isChineseDialogue = (language: string) => /中文|中国|汉语|普通话|粤语|chinese|mandarin|cantonese|^zh(?:-|$)/i.test(language);

// 这里只检查明显的文字系统冲突，不把汉字误当成日语、韩语中的中文混入。
export function dialogueScriptMatches(line: string, language: string): boolean {
  const hasHan = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(line);
  if (isChineseDialogue(language)) return hasHan;
  if (/日语|日本語|japanese|^ja(?:-|$)|韩语|韓語|korean|^ko(?:-|$)/i.test(language)) return true;
  return !hasHan;
}
