import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.SVGElement = dom.window.SVGElement;

const { default: mermaid } = await import('mermaid');

const fixtures = [
  ['demo', new URL('../maps/demo.mmd', import.meta.url)],
  ['synthetic', new URL('../maps/synthetic.mmd', import.meta.url)],
];

for (const [name, url] of fixtures) {
  const source = await fs.readFile(url, 'utf8');
  const result = await mermaid.parse(source, { suppressErrors: false });

  if (result.diagramType !== 'flowchart-v2') {
    throw new Error(`Expected flowchart-v2, received ${result.diagramType}`);
  }

  const ids = [...source.matchAll(/^\s*([A-Za-z][\w-]*)\s*(?:\(\[|\[)/gm)].map((match) => match[1]);
  const labels = [...source.matchAll(/^\s*[A-Za-z][\w-]*\s*(?:\(\[|\[)"((?:\\.|[^"\\])*)"/gm)]
    .map((match) => JSON.parse(`"${match[1]}"`));

  if (labels.length === 0 || !labels.some((label) => /[가-힣]/.test(label))) {
    throw new Error(`${name}: stable Korean labels did not survive the source read.`);
  }

  console.log(JSON.stringify({ name, diagramType: result.diagramType, nodeCount: ids.length, koreanLabel: labels[0] }));
}
