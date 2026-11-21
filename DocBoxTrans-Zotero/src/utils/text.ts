const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/u;
const WORD = /[A-Za-z0-9]/;

/** 保守修复 PDF 行内断行，保留段落、列表、句末和表格边界。 */
export function preprocessPdfText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trim());
  let out = lines[0] || "";
  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1], current = lines[i];
    const list = /^(?:[•·○●▪◦‣∙■□◆◇]|[-*+]\s|[（(【]?(?:\d+|[A-Za-z]|[一二三四五六七八九十]+)[.．)、）:：])/u;
    const sentence = /[.!?;:。！？；：…．]["'”’\])}）】》」』〕〉]*$/u;
    if (!previous || !current || sentence.test(previous) || list.test(current) ||
      /[a-z]$/.test(previous) && /^[A-Z]/.test(current) ||
      /\t| {2,}/.test(previous) || /\t| {2,}/.test(current)) {
      out += "\n" + current;
      continue;
    }
    const stem = /([A-Za-z]{3,})-$/.exec(previous)?.[1];
    const compound = /^(?:well|state|long|short|high|low|non|anti|pre|post|multi|self|cross|co|re|single|double|two|three|dose|time|cell|peer)$/i;
    const brokenWord = stem && !/^[A-Z]+$/.test(stem) && !compound.test(stem) && /^[a-z]{2,}\b/.test(current) &&
      !/^\S+-/.test(current);
    if (/\u00ad$/.test(previous) || brokenWord) out = out.slice(0, -1) + current;
    else if (/-$/.test(previous)) out += current;
    else out += (CJK.test(previous.slice(-1)) || CJK.test(current[0]) ? "" : " ") + current;
  }
  return out.replace(/\u00ad/g, "").trim();
}

function canonical(text: string): { value: string; ends: number[] } {
  let value = "";
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = /\s/u.test(text[i]) ? " " : text[i];
    if (char === " " && value.endsWith(" ")) { ends[ends.length - 1] = i + 1; continue; }
    value += char; ends.push(i + 1);
  }
  return { value, ends };
}

function atBoundary(text: string, start: number, length: number): boolean {
  return !(start > 0 && WORD.test(text[start - 1]) && WORD.test(text[start])) &&
    !(start + length < text.length && WORD.test(text[start + length - 1]) && WORD.test(text[start + length]));
}

/** KMP：只检查长度不超过右侧片段的左侧尾部，避免长片段的平方扫描。 */
function overlapLength(left: string, right: string): number {
  const prefix = new Array<number>(right.length).fill(0);
  for (let i = 1, j = 0; i < right.length; i++) {
    while (j && right[i] !== right[j]) j = prefix[j - 1];
    if (right[i] === right[j]) j++;
    prefix[i] = j;
  }
  let matched = 0;
  const tail = left.slice(-right.length);
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i];
    while (matched && (matched === right.length || char !== right[matched])) matched = prefix[matched - 1];
    if (char === right[matched]) matched++;
  }
  return matched;
}

/** 去除完整重复片段与足够长的首尾重叠；保留原始片段内部的段落。 */
export function mergeFragments(fragments: readonly string[]): string {
  let out = "";
  for (const fragment of fragments) {
    const next = fragment.trim();
    if (!next) continue;
    if (!out) { out = next; continue; }
    const left = canonical(out), right = canonical(next);
    if (left.value === right.value) continue;
    const enough = (value: string) => value.length >= 12 || CJK.test(value) && value.length >= 6;
    const contained = left.value.indexOf(right.value);
    if (enough(right.value) && contained >= 0 && atBoundary(left.value, contained, right.value.length)) continue;
    const contains = right.value.indexOf(left.value);
    if (enough(left.value) && contains >= 0 && atBoundary(right.value, contains, left.value.length)) {
      out = next; continue;
    }
    const length = overlapLength(left.value, right.value);
    if (length && enough(right.value.slice(0, length)) &&
      atBoundary(left.value, left.value.length - length, length) && atBoundary(right.value, 0, length)) {
      out += next.slice(right.ends[length - 1]);
    } else {
      const space = CJK.test(out.slice(-1)) || CJK.test(next[0]) || /^[,.;:!?，。；：！？]/u.test(next) ? "" : " ";
      out += space + next;
    }
  }
  return out;
}
