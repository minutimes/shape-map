import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphOf, parseFlow } from '../harness/flow/flowModel.js';
import { generatedFlow } from '../harness/flow/fixtures.js';
import { cardSize, flowOrientation, layoutFlow, rankFlow } from '../src/flow/flowLayout.js';
import { fitViewport, openingViewport } from '../src/flow/FlowCanvas.jsx';

const read = (name) => graphOf(parseFlow(fs.readFileSync(new URL(`../examples/sample-project/docs/maps/${name}`, import.meta.url), 'utf8')));
const lending = read('02-lending.mmd');
const system = read('03-lending-system.mmd');
const large = graphOf(parseFlow(generatedFlow({ lanes: 20, steps: 200 })));

function flow(lines, kind = 'user-flow', direction = 'LR') {
  return graphOf(parseFlow([`flowchart ${direction}`, `  %% sm-map: {"kind":"${kind}"}`, ...lines].join('\n')));
}

const inside = (point, rect, pad = 0) => point.x > rect.x + pad && point.x < rect.x + rect.width - pad && point.y > rect.y + pad && point.y < rect.y + rect.height - pad;
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function segmentHits([a, b], rect) {
  const left = rect.x + .5; const right = rect.x + rect.width - .5; const top = rect.y + .5; const bottom = rect.y + rect.height - .5;
  if (Math.abs(a.y - b.y) < .01) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

function checkGeometry(layout) {
  const cards = layout.cards;
  for (let i = 0; i < cards.length; i += 1) for (let j = i + 1; j < cards.length; j += 1) {
    expect(overlaps(cards[i], cards[j]), `${cards[i].id} overlaps ${cards[j].id}`).toBe(false);
  }
  const byId = new Map(cards.map((card) => [card.id, card]));
  for (const arrow of layout.arrows) {
    const segments = arrow.points.slice(1).map((point, index) => [arrow.points[index], point]);
    for (const segment of segments) {
      expect(Math.abs(segment[0].x - segment[1].x) < .01 || Math.abs(segment[0].y - segment[1].y) < .01, `${arrow.key} is orthogonal`).toBe(true);
    }
    segments.forEach((segment, index) => {
      for (const card of cards) {
        const own = card.id === arrow.source || card.id === arrow.target;
        if (own && (index === 0 || index === segments.length - 1)) continue;
        expect(segmentHits(segment, card), `${arrow.key} crosses ${card.id}`).toBe(false);
      }
    });
    const source = byId.get(arrow.source); const target = byId.get(arrow.target);
    expect(arrow.points[0].y).toBeGreaterThanOrEqual(source.y);
    expect(arrow.points[0].y).toBeLessThanOrEqual(source.y + source.height);
    expect(arrow.points.at(-1).x).toBeGreaterThanOrEqual(target.x - .01);
    if (arrow.labelBox) for (const card of cards) expect(overlaps(arrow.labelBox, card), `${arrow.key} label covers ${card.id}`).toBe(false);
  }
}

describe('flow map ranking', () => {
  it('finds genuine returns and points every other arrow forward', () => {
    const ranking = rankFlow(lending);
    expect([...ranking.returns].sort()).toEqual(['owner_accept->platform_match', 'reader_wait->reader_search']);
    for (const arrow of lending.arrows) {
      if (ranking.returns.has(`${arrow.source}->${arrow.target}`)) continue;
      expect(ranking.rank.get(arrow.target)).toBeGreaterThan(ranking.rank.get(arrow.source));
    }
    expect([...rankFlow(system).returns].sort()).toEqual(['next_owner->stock', 'remind->watch']);
  });

  it('treats the first declared step as the start even when later steps loop back to it', () => {
    const graph = flow(['hub["광장"]', 'make["방 만들기"]', 'play["판"]', 'note["초대 알림"]', 'arrive["도착"]',
      'hub --> make', 'make --> play', 'play --> hub', 'hub --> arrive', 'note --> arrive', 'arrive --> hub'], 'system-flow', 'TB');
    const ranking = rankFlow(graph);
    expect([...ranking.returns].sort()).toEqual(['arrive->hub', 'play->hub']);
    expect(ranking.rank.get('hub')).toBe(0);
  });

  it('keeps declaration order for steps that arrows do not order', () => {
    const graph = flow(['subgraph a["가"]', '  one["하나"]', '  two["둘"]', '  three["셋"]', 'end']);
    const layout = layoutFlow(graph);
    const [one, two, three] = ['one', 'two', 'three'].map((id) => layout.cards.find((card) => card.id === id));
    expect(one.x).toBeLessThan(two.x);
    expect(two.x).toBeLessThan(three.x);
    expect(new Set([one.y, two.y, three.y]).size).toBe(1);
  });
});

describe('flow map layout', () => {
  const layout = layoutFlow(lending);
  const card = (id) => layout.cards.find((item) => item.id === id);

  it('is deterministic', () => {
    expect(layoutFlow(lending)).toEqual(layout);
    expect(layoutFlow(large)).toEqual(layoutFlow(large));
  });

  it('shows participants as rows in declaration order', () => {
    expect(layout.orientation).toBe('rows');
    expect(layout.bands.map((band) => band.laneId)).toEqual(['reader', 'owner', 'catalog', 'platform']);
    for (let i = 1; i < layout.bands.length; i += 1) expect(layout.bands[i].y).toBe(layout.bands[i - 1].y + layout.bands[i - 1].height);
    for (const item of layout.cards) {
      const band = layout.bands.find((entry) => entry.id === item.band);
      expect(item.y).toBeGreaterThan(band.y);
      expect(item.y + item.height).toBeLessThan(band.y + band.height);
    }
  });

  it('stacks branches inside a lane and keeps the main path on the first row', () => {
    expect(card('reader_wait').rank).toBe(card('reader_request').rank);
    expect(card('reader_request').row).toBe(0);
    expect(card('reader_wait').row).toBe(1);
    expect(card('reader_wait').y).toBeGreaterThan(card('reader_request').y + card('reader_request').height);
  });

  it('aligns steps across lanes by arrow order', () => {
    const columns = new Map();
    for (const item of layout.cards) {
      if (!columns.has(item.rank)) columns.set(item.rank, item.x);
      expect(item.x).toBe(columns.get(item.rank));
    }
    expect(card('platform_match').x).toBeGreaterThan(card('reader_request').x);
    expect(card('owner_check').x).toBeGreaterThan(card('platform_match').x);
  });

  it('points arrows rightward except returns, which route around cards', () => {
    for (const arrow of layout.arrows) {
      const start = arrow.points[0]; const end = arrow.points.at(-1);
      if (arrow.isReturn) {
        expect(end.x).toBeLessThan(start.x);
        expect(arrow.points.length).toBeGreaterThanOrEqual(4);
      } else expect(end.x).toBeGreaterThan(start.x);
    }
    checkGeometry(layout);
  });

  it('keeps the main row straight from a decision', () => {
    const main = layout.arrows.find((arrow) => arrow.key === 'reader_available->reader_request');
    expect(main.points).toHaveLength(2);
    const straight = layout.arrows.find((arrow) => arrow.key === 'reader_open->reader_search');
    expect(straight.points).toHaveLength(2);
  });

  it('places truncated arrow labels with the full text kept', () => {
    const graph = flow(['subgraph a["가"]', '  one["하나"]', '  two["둘"]', 'end', 'one -->|"아주 길고 긴 화살표 글자가 여기 있어요 끝까지 다 보이지는 않아요"| two']);
    const result = layoutFlow(graph);
    const box = result.arrows[0].labelBox;
    expect(box.truncated).toBe(true);
    expect(box.text.endsWith('…')).toBe(true);
    expect(box.full).toContain('끝까지');
    checkGeometry(result);
  });

  it('gives shared steps their own band after the lanes', () => {
    const graph = flow(['subgraph a["가"]', '  one["하나"]', 'end', 'shared["함께"]', 'one --> shared']);
    const result = layoutFlow(graph);
    expect(result.bands.map((band) => band.id)).toEqual(['a', '__shared']);
    expect(result.cards.find((item) => item.id === 'shared').band).toBe('__shared');
    expect(result.cards.find((item) => item.id === 'shared').y).toBeGreaterThan(result.bands[1].y);
  });

  it('keeps an empty lane visible', () => {
    const graph = flow(['subgraph a["가"]', 'end', 'subgraph b["나"]', '  one["하나"]', 'end']);
    const result = layoutFlow(graph);
    expect(result.bands[0].stepCount).toBe(0);
    expect(result.bands[0].height).toBeGreaterThan(60);
  });

  it('lays out a lane-free top-to-bottom system flow as a vertical flowchart', () => {
    expect(flowOrientation(system)).toBe('columns');
    const result = layoutFlow(system);
    expect(result.orientation).toBe('columns');
    expect(result.bounds.height).toBeGreaterThan(result.bounds.width);
    for (const arrow of result.arrows) {
      const start = arrow.points[0]; const end = arrow.points.at(-1);
      if (arrow.isReturn) expect(end.y).toBeLessThan(start.y); else expect(end.y).toBeGreaterThan(start.y);
    }
    const main = ['receive', 'stock', 'notify_owner', 'wait_answer', 'charge'].map((id) => result.cards.find((item) => item.id === id));
    expect(new Set(main.map((item) => item.x)).size).toBe(1);
    checkGeometry({ ...result, arrows: result.arrows.map((arrow) => ({ ...arrow, points: arrow.points.map((point) => ({ x: point.y, y: point.x })),
      labelBox: arrow.labelBox && { ...arrow.labelBox, x: arrow.labelBox.y, y: arrow.labelBox.x, width: arrow.labelBox.height, height: arrow.labelBox.width } })),
    cards: result.cards.map((item) => ({ ...item, x: item.y, y: item.x, width: item.height, height: item.width })) });
  });

  it('keeps every layout free of overlaps and card crossings', () => {
    checkGeometry(layoutFlow(large));
    checkGeometry(layoutFlow({ ...system, direction: 'LR' }));
  });

  it('handles 20 lanes and 200 steps quickly', () => {
    const started = performance.now();
    const result = layoutFlow(large);
    const elapsed = performance.now() - started;
    expect(result.cards).toHaveLength(200);
    expect(result.bands).toHaveLength(20);
    expect(elapsed).toBeLessThan(250);
  });

  it('grows cards to show the first line of a description when notes are on', () => {
    const step = lending.steps.find((item) => item.id === 'reader_deposit');
    expect(cardSize(step, { notes: true }).height).toBeGreaterThan(cardSize(step).height);
    const withNotes = layoutFlow(lending, { notes: true });
    expect(withNotes.cards.find((item) => item.id === 'reader_deposit').noteLines).toBeGreaterThan(0);
    checkGeometry(withNotes);
  });

  it('lays out an empty map', () => {
    const result = layoutFlow(flow([]));
    expect(result.cards).toEqual([]);
    expect(result.bands).toHaveLength(1);
    expect(result.bounds.width).toBeGreaterThan(0);
  });

  it('keeps every port on its card', () => {
    const byId = new Map(layout.cards.map((item) => [item.id, item]));
    for (const arrow of layout.arrows) {
      const source = byId.get(arrow.source); const target = byId.get(arrow.target);
      expect(inside({ x: arrow.points[0].x - 1, y: arrow.points[0].y }, { ...source, x: source.x - 1, width: source.width + 2 }, 0)).toBe(true);
      expect(inside({ x: arrow.points.at(-1).x + 1, y: arrow.points.at(-1).y }, { ...target, x: target.x - 1, width: target.width + 2 }, 0)).toBe(true);
    }
  });
});

describe('flow map opening view', () => {
  it('opens a long map at a readable size from its start, and a small map whole', () => {
    const wide = layoutFlow(lending).bounds;
    expect(fitViewport(wide, 1284, 700).zoom).toBeLessThan(.7);
    expect(openingViewport(wide, 1284, 700)).toEqual({ x: 28, y: 28, zoom: .9, whole: false });
    expect(openingViewport(wide, 300, 600).zoom).toBe(.75);
    const tall = layoutFlow(system).bounds;
    const top = openingViewport(tall, 1440, 760);
    expect(top).toMatchObject({ y: 28, zoom: .9, whole: false });
    expect(top.x).toBe(Math.round((1440 - tall.width * .9) / 2));
    const small = layoutFlow(flow(['subgraph a["가"]', '  one["하나"]', '  two["둘"]', 'end', 'one --> two'])).bounds;
    expect(openingViewport(small, 1284, 700)).toMatchObject({ zoom: 1, whole: true });
  });
});
