import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphOf, parseFlow } from '../harness/flow/flowModel.js';
import { generatedFlow } from '../harness/flow/fixtures.js';
import { bandAt, freeSpot, layoutFlow, placementFor } from '../src/flow/flowLayout.js';
import { chooseSides, routeAround } from '../src/flow/flowRouting.js';

const read = (name) => graphOf(parseFlow(fs.readFileSync(new URL(`../examples/sample-project/docs/maps/${name}`, import.meta.url), 'utf8')));
const lending = read('02-lending.mmd');
const system = read('03-lending-system.mmd');
const large = graphOf(parseFlow(generatedFlow({ lanes: 20, steps: 200 })));

function flow(lines, kind = 'user-flow', direction = 'LR') {
  return graphOf(parseFlow([`flowchart ${direction}`, `  %% sm-map: {"kind":"${kind}"}`, ...lines].join('\n')));
}

const overlaps = (a, b, gap = 0) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;
function segmentHits([a, b], rect) {
  const left = rect.x + .5; const right = rect.x + rect.width - .5; const top = rect.y + .5; const bottom = rect.y + rect.height - .5;
  if (Math.abs(a.y - b.y) < .01) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

/** No card covers another, every arrow is orthogonal, attached to its cards, and clear of other cards; labels sit off cards. */
function checkClean(layout) {
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
    const onEdge = (point, card) => point.x >= card.x - .5 && point.x <= card.x + card.width + .5 && point.y >= card.y - .5 && point.y <= card.y + card.height + .5;
    expect(onEdge(arrow.points[0], source), `${arrow.key} leaves its source`).toBe(true);
    expect(onEdge(arrow.points.at(-1), target), `${arrow.key} reaches its target`).toBe(true);
    if (arrow.labelBox) for (const card of cards) expect(overlaps(arrow.labelBox, card), `${arrow.key} label covers ${card.id}`).toBe(false);
  }
  for (const card of cards) {
    const band = layout.bands.find((entry) => entry.id === card.band);
    if (layout.orientation === 'rows') {
      expect(card.y, `${card.id} inside its lane`).toBeGreaterThanOrEqual(band.y);
      expect(card.y + card.height, `${card.id} inside its lane`).toBeLessThanOrEqual(band.y + band.height);
    }
  }
}

describe('hand-placed flow cards', () => {
  const auto = layoutFlow(lending);
  const card = (layout, id) => layout.cards.find((item) => item.id === id);
  const band = (layout, id) => layout.bands.find((item) => item.id === id);

  it('keeps a placed card at its spot inside its lane and leaves other columns where they were', () => {
    const before = card(auto, 'owner_check');
    const lane = band(auto, 'owner');
    const spot = { x: before.x + 60, y: before.y - lane.y + 150 };
    const layout = layoutFlow(lending, { placements: { owner_check: spot } });
    const placed = card(layout, 'owner_check');
    expect(placed.placed).toBe(true);
    expect(placed.x).toBe(spot.x);
    expect(placed.y - band(layout, 'owner').y).toBe(spot.y);
    for (const other of layout.cards) if (other.id !== 'owner_check') expect(other.x, other.id).toBe(card(auto, other.id).x);
    expect(band(layout, 'owner').height).toBeGreaterThan(lane.height);
    expect(band(layout, 'catalog').y).toBe(band(layout, 'owner').y + band(layout, 'owner').height);
    checkClean(layout);
  });

  it('is deterministic and ignores spots for steps that do not exist', () => {
    const placements = { owner_check: { x: 900, y: 140 }, gone: { x: 10, y: 10 } };
    expect(layoutFlow(lending, { placements })).toEqual(layoutFlow(lending, { placements }));
    expect(layoutFlow(lending, { placements: { gone: { x: 1, y: 1 } } })).toEqual(auto);
  });

  it('moves automatic cards out from under a placed card instead of covering them', () => {
    const target = card(auto, 'reader_search');
    const lane = band(auto, 'reader');
    const layout = layoutFlow(lending, { placements: { reader_open: { x: target.x + 10, y: target.y - lane.y + 4 } } });
    checkClean(layout);
    expect(card(layout, 'reader_open').x).toBe(target.x + 10);
    expect(card(layout, 'reader_search').y).toBeGreaterThan(card(layout, 'reader_open').y + card(layout, 'reader_open').height);
  });

  it('moves a later placed card past an earlier one it would cover', () => {
    const layout = layoutFlow(lending, { placements: { reader_open: { x: 900, y: 30 }, reader_search: { x: 910, y: 40 } } });
    checkClean(layout);
    const first = card(layout, 'reader_open'); const second = card(layout, 'reader_search');
    expect(first.y - band(layout, 'reader').y).toBe(30);
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
  });

  it('routes arrows of a placed card around cards and keeps labels clear', () => {
    // Put a decision far back and low, so its arrows have to find their way.
    const layout = layoutFlow(lending, { placements: { reader_available: { x: 40, y: 260 }, platform_match: { x: 300, y: 10 } } });
    checkClean(layout);
    const labelled = layout.arrows.filter((arrow) => (arrow.source === 'reader_available' || arrow.target === 'reader_available') && arrow.label);
    expect(labelled.length).toBeGreaterThan(0);
    for (const arrow of labelled) expect(arrow.labelBox).toBeTruthy();
    for (const arrow of layout.arrows) {
      expect(arrow.points.at(-1).x).toBeLessThanOrEqual(layout.bounds.width);
      expect(arrow.points.at(-1).y).toBeLessThanOrEqual(layout.bounds.height);
    }
  });

  it('reaches a card placed straight below its source from the top', () => {
    const graph = flow(['subgraph a["가"]', '  one["하나"]', '  two["둘"]', '  three["셋"]', 'end', 'one --> two', 'two --> three']);
    const base = layoutFlow(graph);
    const one = card(base, 'one');
    const layout = layoutFlow(graph, { placements: { two: { x: one.x, y: one.y - band(base, 'a').y + 140 } } });
    checkClean(layout);
    const down = layout.arrows.find((arrow) => arrow.key === 'one->two');
    expect(down.points[0].y).toBe(one.y + one.height);
    expect(down.points.at(-1).y).toBe(card(layout, 'two').y);
    expect(down.points).toHaveLength(2);
  });

  it('works for a top-to-bottom flowchart without lanes', () => {
    const graph = flow(['a["시작"]', 'b["확인"]', 'c{"괜찮나?"}', 'd["끝"]', 'a --> b', 'b --> c', 'c -->|"네"| d', 'c -.->|"아니요"| b'], 'system-flow', 'TB');
    const base = layoutFlow(graph);
    expect(base.orientation).toBe('columns');
    const layout = layoutFlow(graph, { placements: { d: { x: 420, y: 120 } } });
    checkClean(layout);
    expect(card(layout, 'd')).toMatchObject({ x: 420, y: 120, placed: true });
    expect(layout.bounds.width).toBeGreaterThanOrEqual(420 + card(layout, 'd').width);
  });

  it('keeps the system flow clean with several cards placed', () => {
    const ids = system.steps.map((step) => step.id);
    const placements = { [ids[2]]: { x: 30, y: 400 }, [ids[5]]: { x: 520, y: 20 }, [ids[8]]: { x: 260, y: 900 } };
    checkClean(layoutFlow(system, { placements }));
  });

  it('stays quick on a large map', () => {
    const placements = {};
    large.steps.filter((_, index) => index % 10 === 0).forEach((step, index) => { placements[step.id] = { x: 200 + index * 90, y: 30 + (index % 3) * 60 }; });
    const started = performance.now();
    const layout = layoutFlow(large, { placements });
    expect(performance.now() - started).toBeLessThan(3000);
    checkClean(layout);
  });
});

describe('placing a dragged card', () => {
  const layout = layoutFlow(lending);
  const card = (id) => layout.cards.find((item) => item.id === id);

  it('finds the lane under a point and the nearest lane outside them', () => {
    const owner = layout.bands.find((item) => item.id === 'owner');
    expect(bandAt(layout, { x: 10, y: owner.y + 5 }).id).toBe('owner');
    expect(bandAt(layout, { x: 10, y: -50 }).id).toBe(layout.bands[0].id);
    expect(bandAt(layout, { x: 10, y: 1e6 }).id).toBe(layout.bands.at(-1).id);
    expect(placementFor(layout, owner, { x: 300.4, y: owner.y + 20.6 })).toEqual({ x: 300, y: 21 });
  });

  it('slides a dropped card to the nearest clear spot and snaps short moves to rows and columns', () => {
    const target = card('reader_search');
    const reader = layout.bands.find((item) => item.id === 'reader');
    const spot = freeSpot(layout, 'owner_check', { width: 164, height: 56 }, { x: target.x + 20, y: target.y + 10 }, reader);
    const box = { ...spot, width: 164, height: 56 };
    for (const other of layout.cards.filter((item) => item.id !== 'owner_check')) expect(overlaps(box, other), other.id).toBe(false);
    const near = freeSpot(layout, 'reader_search', { width: target.width, height: target.height }, { x: target.x + 7, y: target.y - 5 }, reader);
    expect(near).toEqual({ x: target.x, y: target.y });
  });
});

describe('orthogonal routing around cards', () => {
  it('goes around a card in the way', () => {
    const block = { x: 100, y: -40, width: 80, height: 80 };
    const points = routeAround({ start: { x: 0, y: 0 }, exitSide: 'right', end: { x: 300, y: 0 }, entrySide: 'left', obstacles: [block] });
    for (let i = 1; i < points.length; i += 1) expect(segmentHits([points[i - 1], points[i]], block)).toBe(false);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 300, y: 0 });
  });

  it('chooses the facing sides', () => {
    const a = { x: 0, y: 0, width: 160, height: 60 };
    expect(chooseSides(a, { x: 300, y: 0, width: 160, height: 60 }, 'rows')).toEqual({ exit: 'right', entry: 'left' });
    expect(chooseSides(a, { x: 20, y: 200, width: 160, height: 60 }, 'rows')).toEqual({ exit: 'bottom', entry: 'top' });
    expect(chooseSides(a, { x: 20, y: -200, width: 160, height: 60 }, 'rows')).toEqual({ exit: 'top', entry: 'bottom' });
    expect(chooseSides(a, { x: 0, y: 200, width: 160, height: 60 }, 'columns')).toEqual({ exit: 'bottom', entry: 'top' });
  });
});
