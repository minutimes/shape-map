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

export async function validateMermaid(source) {
  const mermaid = await getMermaid();
  try {
    const result = await mermaid.parse(source, { suppressErrors: true });
    if (result.diagramType !== 'flowchart-v2') {
      throw new Error(`expected flowchart-v2, received ${result.diagramType}`);
    }
  } catch (error) {
    const detail = error?.str || error?.message || String(error);
    throw new Error(`Mermaid syntax error: ${detail}`);
  }
}
