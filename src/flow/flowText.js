// Deterministic text metrics. Layout must not depend on the DOM, so widths are
// estimated per character class and err on the wide side.

function charWidth(char) {
  const code = char.codePointAt(0);
  if (char === ' ') return .3;
  if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f) || (code >= 0xac00 && code <= 0xd7af)) return 1;
  if (code >= 0x2e80 && code <= 0x9fff) return 1;
  if (code >= 0xff00 && code <= 0xffef) return 1;
  if (/[A-Z]/.test(char)) return .66;
  if (/[a-z]/.test(char)) return .54;
  if (/[0-9]/.test(char)) return .6;
  if (/[.,:;'!|`]/.test(char)) return .3;
  if (/[\-–—_()[\]{}/\\]/.test(char)) return .42;
  if (code > 0x2000) return 1;
  return .6;
}

export function textWidth(text, fontSize = 12) {
  let width = 0;
  for (const char of String(text ?? '')) width += charWidth(char);
  return width * fontSize;
}

/** Wraps text to the given width, breaking at spaces first and anywhere if needed. */
export function wrapText(text, maxWidth, fontSize = 12) {
  const lines = [];
  const words = String(text ?? '').split(/(\s+)/).filter((part) => part.length);
  let line = '';
  const push = () => { if (line.trim()) lines.push(line.trim()); line = ''; };
  for (const word of words) {
    if (textWidth(line + word, fontSize) <= maxWidth) { line += word; continue; }
    if (/^\s+$/.test(word)) { push(); continue; }
    if (line.trim()) push();
    if (textWidth(word, fontSize) <= maxWidth) { line = word; continue; }
    for (const char of word) {
      if (textWidth(line + char, fontSize) > maxWidth && line) push();
      line += char;
    }
  }
  push();
  return lines.length ? lines : [''];
}

/** Cuts text to fit maxWidth and marks whether anything was removed. */
export function truncateText(text, maxWidth, fontSize = 11) {
  const value = String(text ?? '');
  if (textWidth(value, fontSize) <= maxWidth) return { text: value, truncated: false };
  const ellipsis = '…';
  let result = '';
  for (const char of value) {
    if (textWidth(result + char + ellipsis, fontSize) > maxWidth) break;
    result += char;
  }
  return { text: `${result.trimEnd()}${ellipsis}`, truncated: true };
}
