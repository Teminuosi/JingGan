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

export const isChineseDialogue = (language: string) => /中文|中国|汉语|普通话|粤语|chinese|mandarin|cantonese|^zh(?:-|$)/i.test(language);

// 这里只检查明显的文字系统冲突，不把汉字误当成日语、韩语中的中文混入。
export function dialogueScriptMatches(line: string, language: string): boolean {
  const hasHan = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(line);
  if (isChineseDialogue(language)) return hasHan;
  if (/日语|日本語|japanese|^ja(?:-|$)|韩语|韓語|korean|^ko(?:-|$)/i.test(language)) return true;
  return !hasHan;
}
