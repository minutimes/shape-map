import { JSDOM } from 'jsdom';

let mermaidPromise;

async function getMermaid() {
  if (!mermaidPromise) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>');
    globalThis.window ??= dom.window;
    globalThis.document ??= dom.window.document;
    globalThis.Element ??= dom.window.Element;
    globalThis.SVGElement ??= dom.window.SVGElement;
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => mermaid);
  }
  return mermaidPromise;
}

/** Mermaid reports "Parse error on line N"; keep that line for people fixing the file. */
export function mermaidErrorLine(message) {
  const match = String(message || '').match(/on line (\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Mermaid removes `%%` comment lines (and leading blank lines) before parsing,
 * so its line numbers count only the remaining lines. Map them back.
 */
export function sourceLineForMermaidLine(source, mermaidLine) {
  if (!Number.isInteger(mermaidLine)) return undefined;
  const kept = [];
  String(source).replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
    if (/^\s*%%(?!{)./.test(line)) return;
    if (!kept.length && !line.trim()) return;
    kept.push(index + 1);
  });
  return kept[mermaidLine - 1];
}

export async function validateMermaid(source) {
  const mermaid = await getMermaid();
  let result;
  try {
    result = await mermaid.parse(source);
  } catch (error) {
    const detail = error?.str || error?.message || String(error);
    const failure = new Error(`Mermaid syntax error: ${detail}`);
    const line = error?.hash?.loc?.first_line ?? error?.hash?.line + 1;
    failure.line = sourceLineForMermaidLine(source, Number.isInteger(line) ? line : mermaidErrorLine(detail));
    throw failure;
  }
  if (result?.diagramType !== 'flowchart-v2') {
    throw new Error(`Mermaid syntax error: expected flowchart-v2, received ${result?.diagramType}`);
  }
}
