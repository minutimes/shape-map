// Pure flow map layout. Steps are ordered along a main axis by their arrows and
// stacked along a cross axis by band (lane) and branch row. Arrow routes are
// orthogonal and stay in the empty gaps between ranks and rows, so they never
// cross a card. The same graph always produces the same layout.
//
// Orientation 'rows' puts lanes in horizontal bands and reads left to right.
// Orientation 'columns' reads top to bottom; it is used for a map without lanes
// that its author wrote top to bottom, so it looks like a plain flowchart.
import { SHARED_BAND_ID } from './flowConstants.js';
import { textWidth, truncateText, wrapText } from './flowText.js';

export const FLOW_METRICS = Object.freeze({
  cardWidth: 164,
  cardPadX: 14,
  cardPadY: 12,
  labelFont: 12.5,
  labelLine: 18,
  maxLines: 3,
  noteFont: 11,
  noteLine: 15,
  noteLines: 2,
  tagRow: 24,
  minCardHeight: 56,
  decisionPoint: 13,
  arrowFont: 11,
  arrowLabelHeight: 20,
  arrowLabelPadX: 9,
  arrowLabelMaxText: 124,
  trackSpacing: 8,
  rows: Object.freeze({ rowGap: 28, bandPad: 30, emptyBand: 104, gapMin: 64, gapMax: 248, gapPad: 16, margin: 40, portSpacing: 10, rowMin: 56 }),
  columns: Object.freeze({ rowGap: 56, bandPad: 36, emptyBand: 220, gapMin: 48, gapMax: 220, gapPad: 12, margin: 32, portSpacing: 16, rowMin: 164 }),
});

const STYLE_PRIORITY = { next: 0, exchange: 1, alternative: 2 };

export const arrowKey = (arrow) => `${arrow.source}->${arrow.target}`;
export const bandIdOf = (step) => step.lane ?? SHARED_BAND_ID;

export function flowOrientation(graph) {
  return !(graph.lanes || []).length && ['TB', 'TD'].includes(graph.direction) ? 'columns' : 'rows';
}

export function firstLine(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

/** Card size from the label, the shape, tag chips, and an optional note line. */
export function cardSize(step, { notes = false } = {}, metrics = FLOW_METRICS) {
  const inset = step.shape === 'decision' ? metrics.decisionPoint * 2 : step.shape === 'milestone' ? 12 : 0;
  const limit = metrics.cardWidth - metrics.cardPadX * 2 - inset;
  const lines = Math.min(metrics.maxLines, wrapText(step.label, limit, metrics.labelFont).length);
  const note = notes && step.summary ? Math.min(metrics.noteLines, wrapText(firstLine(step.summary), limit, metrics.noteFont).length) : 0;
  const tags = step.tags?.length ? metrics.tagRow : 0;
  const height = Math.max(metrics.minCardHeight, metrics.cardPadY * 2 + lines * metrics.labelLine + (note ? note * metrics.noteLine + 6 : 0) + tags);
  return { width: metrics.cardWidth, height: Math.round(height), lines, noteLines: note };
}

/**
 * Orders steps into ranks. Arrows that close a loop (found by a depth-first
 * walk from steps in declaration order) are returns; every other arrow points forward.
 * A step without arrows follows the previous step in its band.
 */
export function rankFlow(graph) {
  const steps = graph.steps || [];
  const index = new Map(steps.map((step, position) => [step.id, position]));
  const arrows = (graph.arrows || []).filter((arrow) => index.has(arrow.source) && index.has(arrow.target) && arrow.source !== arrow.target);
  const out = new Map(steps.map((step) => [step.id, []]));
  const incoming = new Map(steps.map((step) => [step.id, 0]));
  for (const arrow of arrows) { out.get(arrow.source).push({ to: arrow.target, arrow }); incoming.set(arrow.target, incoming.get(arrow.target) + 1); }
  const connected = new Set(arrows.flatMap((arrow) => [arrow.source, arrow.target]));
  const previousInBand = new Map();
  for (const step of steps) {
    const band = bandIdOf(step);
    const previous = previousInBand.get(band);
    if (previous && (!connected.has(previous) || !connected.has(step.id))) {
      out.get(previous).push({ to: step.id, arrow: null });
      incoming.set(step.id, incoming.get(step.id) + 1);
    }
    previousInBand.set(band, step.id);
  }

  const state = new Map();
  const back = new Set();
  // Walk from steps in declaration order: the author's first step is the start
  // even when a later step loops back to it.
  for (const root of steps) {
    if (state.has(root.id)) continue;
    const stack = [{ id: root.id, next: 0 }];
    state.set(root.id, 1);
    while (stack.length) {
      const frame = stack.at(-1);
      const edges = out.get(frame.id);
      if (frame.next >= edges.length) { state.set(frame.id, 2); stack.pop(); continue; }
      const edge = edges[frame.next++];
      const seen = state.get(edge.to);
      if (seen === 1) back.add(edge);
      else if (!seen) { state.set(edge.to, 1); stack.push({ id: edge.to, next: 0 }); }
    }
  }

  const predecessors = new Map(steps.map((step) => [step.id, []]));
  const successors = new Map(steps.map((step) => [step.id, []]));
  for (const [from, edges] of out) for (const edge of edges) {
    if (back.has(edge)) continue;
    successors.get(from).push(edge.to);
    predecessors.get(edge.to).push({ from, arrow: edge.arrow });
  }
  const remaining = new Map(steps.map((step) => [step.id, predecessors.get(step.id).length]));
  const order = [];
  const ready = steps.filter((step) => remaining.get(step.id) === 0).map((step) => step.id);
  for (let head = 0; head < ready.length; head += 1) {
    const id = ready[head];
    order.push(id);
    for (const to of successors.get(id)) {
      remaining.set(to, remaining.get(to) - 1);
      if (remaining.get(to) === 0) ready.push(to);
    }
  }
  const rank = new Map(steps.map((step) => [step.id, 0]));
  for (const id of order) for (const to of successors.get(id)) rank.set(to, Math.max(rank.get(to), rank.get(id) + 1));
  // A starting step sits just before its first follower instead of far back.
  for (const id of [...order].reverse()) {
    if (predecessors.get(id).length || !successors.get(id).length) continue;
    rank.set(id, Math.min(...successors.get(id).map((to) => rank.get(to))) - 1);
  }
  const minimum = steps.length ? Math.min(...rank.values()) : 0;
  if (minimum !== 0) for (const [id, value] of rank) rank.set(id, value - minimum);
  const returns = new Set([...back].filter((edge) => edge.arrow).map((edge) => arrowKey(edge.arrow)));
  return { rank, returns, predecessors, arrows, rankCount: steps.length ? Math.max(...rank.values()) + 1 : 0 };
}

/** Puts branches of a band on separate rows; the main path keeps the first row. */
function assignRows(steps, ranking, bandIndex) {
  const row = new Map();
  const declaration = new Map(steps.map((step, position) => [step.id, position]));
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const occupied = new Map();
  const groups = new Map();
  for (const step of [...steps].sort((a, b) => ranking.rank.get(a.id) - ranking.rank.get(b.id) || declaration.get(a.id) - declaration.get(b.id))) {
    const rank = ranking.rank.get(step.id);
    if (!groups.has(rank)) groups.set(rank, []);
    groups.get(rank).push(step);
  }
  for (const [rank, group] of groups) {
    const preferences = group.map((step) => {
      const band = bandIdOf(step);
      const sameBand = ranking.predecessors.get(step.id)
        .filter(({ from }) => bandIdOf(stepById.get(from)) === band && row.has(from))
        .map(({ from, arrow }) => ({ row: row.get(from), style: arrow ? STYLE_PRIORITY[arrow.style] ?? 1 : 1 }))
        .sort((a, b) => a.style - b.style || a.row - b.row);
      return { step, band, preferred: sameBand[0]?.row ?? 0, style: sameBand[0]?.style ?? 1 };
    }).sort((a, b) => bandIndex.get(a.band) - bandIndex.get(b.band) || a.preferred - b.preferred
      || a.style - b.style || declaration.get(a.step.id) - declaration.get(b.step.id));
    for (const { step, band, preferred } of preferences) {
      const taken = (candidate) => occupied.has(`${band}|${rank}|${candidate}`);
      let chosen = preferred;
      if (taken(chosen)) { chosen = 0; while (taken(chosen)) chosen += 1; }
      occupied.set(`${band}|${rank}|${chosen}`, step.id);
      row.set(step.id, chosen);
    }
  }
  return { row, occupied };
}

/** How far a port sits inside the card's box because of the card's outline. */
function portInset(shape, card, offset, orientation, metrics) {
  const distance = Math.abs(offset);
  if (orientation === 'rows') {
    const half = card.height / 2;
    if (shape === 'decision') return metrics.decisionPoint * Math.min(1, distance / half);
    if (shape === 'milestone') return half - Math.sqrt(Math.max(0, half * half - distance * distance));
    return 0;
  }
  const half = card.width / 2;
  if (shape === 'decision') {
    const beyond = distance - (half - metrics.decisionPoint);
    return beyond > 0 ? (card.height / 2) * Math.min(1, beyond / metrics.decisionPoint) : 0;
  }
  if (shape === 'milestone') {
    const radius = card.height / 2;
    const beyond = distance - (half - radius);
    return beyond > 0 ? radius - Math.sqrt(Math.max(0, radius * radius - beyond * beyond)) : 0;
  }
  return 0;
}

function simplify(points) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.m - point.m) < .01 && Math.abs(last.c - point.c) < .01) continue;
    const before = result.at(-2);
    if (before && last && ((Math.abs(before.m - last.m) < .01 && Math.abs(last.m - point.m) < .01)
      || (Math.abs(before.c - last.c) < .01 && Math.abs(last.c - point.c) < .01))) result.pop();
    result.push(point);
  }
  return result;
}

// Cost of putting cross-direction run p before q inside one gap. Stubs attach a
// run to the gap's 'start' side (toward earlier ranks) or 'end' side.
function runCost(p, q) {
  let cost = 0;
  const within = (value, run) => value > Math.min(run.c1, run.c2) + .5 && value < Math.max(run.c1, run.c2) - .5;
  for (const attach of q.attachments) if (attach.side === 'start' && within(attach.c, p)) cost += 1;
  for (const attach of p.attachments) if (attach.side === 'end' && within(attach.c, q)) cost += 1;
  for (const a of p.attachments) for (const b of q.attachments) {
    if (a.side === 'end' && b.side === 'start' && Math.abs(a.c - b.c) < 1) cost += 1000;
  }
  return cost;
}

function orderRuns(runs) {
  const order = [...runs].sort((a, b) => Math.min(a.c1, a.c2) - Math.min(b.c1, b.c2) || a.order - b.order);
  for (let pass = 0; pass < order.length; pass += 1) {
    let swapped = false;
    for (let i = 0; i < order.length - 1; i += 1) {
      if (runCost(order[i + 1], order[i]) < runCost(order[i], order[i + 1])) {
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return order;
}

/**
 * Lays out a flow map graph ({ lanes, steps, arrows, direction }).
 * @returns {{ orientation, bands, cards, arrows, ranks, gaps, bounds }} in canvas x/y.
 */
export function layoutFlow(graph, options = {}, metrics = FLOW_METRICS) {
  const orientation = options.orientation || flowOrientation(graph);
  const rowsMode = orientation === 'rows';
  const axis = rowsMode ? metrics.rows : metrics.columns;
  const lanes = graph.lanes || [];
  const laneIds = new Set(lanes.map((lane) => lane.id));
  const steps = (graph.steps || []).map((step) => (step.lane != null && !laneIds.has(step.lane) ? { ...step, lane: null } : step));
  const bandList = lanes.map((lane) => ({ id: lane.id, laneId: lane.id, title: lane.title }));
  if (steps.some((step) => step.lane == null) || !bandList.length) bandList.push({ id: SHARED_BAND_ID, laneId: null, title: null });
  const bandIndex = new Map(bandList.map((band, position) => [band.id, position]));
  const ranking = rankFlow({ ...graph, steps });
  const { row, occupied } = assignRows(steps, ranking, bandIndex);
  const rankCount = ranking.rankCount;
  const size = new Map(steps.map((step) => [step.id, cardSize(step, options, metrics)]));
  const mainSize = (card) => (rowsMode ? card.width : card.height);
  const crossSize = (card) => (rowsMode ? card.height : card.width);

  // Cross axis: bands, rows inside bands, and the free corridors between them.
  let cursor = 0;
  const bands = []; const corridors = []; const rowBounds = new Map();
  for (const band of bandList) {
    const members = steps.filter((step) => bandIdOf(step) === band.id);
    const rowCount = members.length ? Math.max(...members.map((step) => row.get(step.id))) + 1 : 0;
    const sizes = Array.from({ length: rowCount }, (_, r) => Math.max(axis.rowMin,
      ...members.filter((step) => row.get(step.id) === r).map((step) => crossSize(size.get(step.id)))));
    const start = cursor;
    const rows = [];
    let c = start + axis.bandPad;
    for (let r = 0; r < rowCount; r += 1) { rows.push({ start: c, end: c + sizes[r] }); c += sizes[r] + axis.rowGap; }
    const extent = rowCount ? c - axis.rowGap + axis.bandPad - start : axis.emptyBand;
    const end = start + extent;
    bands.push({ ...band, index: bands.length, start, size: extent, rows, stepCount: members.length });
    rows.forEach((bounds, r) => rowBounds.set(`${band.id}|${r}`, bounds));
    if (!rowCount) corridors.push({ band: band.id, c0: start + 8, c1: end - 8 });
    else {
      corridors.push({ band: band.id, c0: start + 3, c1: rows[0].start - 4 });
      for (let r = 0; r < rowCount - 1; r += 1) corridors.push({ band: band.id, c0: rows[r].end + 4, c1: rows[r + 1].start - 4 });
      corridors.push({ band: band.id, c0: rows.at(-1).end + 4, c1: end - 3 });
    }
    cursor = end;
  }
  const crossTotal = cursor;

  // Main axis rank thickness (every card in one rank shares a slot).
  const rankSize = Array.from({ length: rankCount }, () => 0);
  for (const step of steps) rankSize[ranking.rank.get(step.id)] = Math.max(rankSize[ranking.rank.get(step.id)], mainSize(size.get(step.id)));

  const cards = steps.map((step) => {
    const bounds = rowBounds.get(`${bandIdOf(step)}|${row.get(step.id)}`);
    const { width, height, lines, noteLines } = size.get(step.id);
    const card = { id: step.id, step, band: bandIdOf(step), rank: ranking.rank.get(step.id), row: row.get(step.id), width, height, lines, noteLines };
    card.c = bounds.start + (bounds.end - bounds.start - crossSize(card)) / 2;
    return card;
  });
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const centerC = (card) => card.c + crossSize(card) / 2;
  const rowClear = (card, from, to) => {
    for (let r = from + 1; r < to; r += 1) if (occupied.has(`${card.band}|${r}|${card.row}`)) return false;
    return true;
  };

  // Route topology: which gaps hold cross-direction runs and which corridor, if any.
  const routes = ranking.arrows.map((arrow, order) => {
    const source = cardById.get(arrow.source); const target = cardById.get(arrow.target);
    const route = { arrow, key: arrowKey(arrow), order, source, target, isReturn: ranking.returns.has(arrowKey(arrow)) };
    const rs = source.rank; const rt = target.rank;
    if (!route.isReturn && rt === rs + 1) route.kind = 'adjacent';
    else if (!route.isReturn && rt > rs && rowClear(source, rs, rt)) route.kind = 'source-row';
    else if (!route.isReturn && rt > rs && rowClear(target, rs, rt)) route.kind = 'target-row';
    else {
      route.kind = 'corridor';
      const a = centerC(source); const b = centerC(target);
      let best = null;
      for (const corridor of corridors) {
        const middle = (corridor.c0 + corridor.c1) / 2;
        const cost = Math.abs(a - middle) + Math.abs(b - middle) - middle * 1e-6;
        if (!best || cost < best.cost) best = { corridor, cost };
      }
      route.corridor = best.corridor;
      route.span = rt <= rs ? [rt - 1, rs] : [rs, rt - 1];
    }
    return route;
  });

  for (const corridor of corridors) {
    const runs = routes.filter((route) => route.corridor === corridor)
      .sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1] || a.order - b.order);
    const trackEnds = [];
    for (const run of runs) {
      let track = trackEnds.findIndex((end) => end < run.span[0]);
      if (track < 0) { track = trackEnds.length; trackEnds.push(run.span[1]); } else trackEnds[track] = run.span[1];
      run.track = track;
    }
    const count = trackEnds.length;
    const spacing = count > 1 ? Math.min(metrics.trackSpacing - 2, (corridor.c1 - corridor.c0) / count) : 0;
    const middle = (corridor.c0 + corridor.c1) / 2;
    for (const run of runs) run.cc = middle + (run.track - (count - 1) / 2) * spacing;
  }

  // Ports: arrows leave from the far side of a card and arrive on the near side.
  const outgoing = new Map(cards.map((card) => [card.id, []]));
  const incoming = new Map(cards.map((card) => [card.id, []]));
  for (const route of routes) { outgoing.get(route.source.id).push(route); incoming.get(route.target.id).push(route); }
  const departure = (route) => (route.kind === 'corridor' ? route.cc : centerC(route.target));
  const approach = (route) => (route.kind === 'corridor' ? route.cc : centerC(route.source));
  const margin = rowsMode ? 9 : 22;
  const place = (card, route, side, c) => { route[side] = { c, inset: portInset(card.step.shape, card, c - centerC(card), orientation, metrics) }; };
  const spread = (card, list, key, side) => {
    list.sort((a, b) => key(a) - key(b) || a.order - b.order);
    const step = list.length > 1 ? Math.min(axis.portSpacing, (crossSize(card) - margin * 2) / (list.length - 1)) : 0;
    list.forEach((route, position) => place(card, route, side, centerC(card) + (position - (list.length - 1) / 2) * step));
  };
  // Keep the main arrow of a row straight: put it at `target` and fan the others out.
  const anchorPorts = (card, list, side, anchor, target) => {
    if (!anchor) return;
    const low = card.c + margin; const high = card.c + crossSize(card) - margin;
    if (target < low || target > high || Math.abs(target - anchor[side].c) < .01) return;
    const position = list.indexOf(anchor);
    const before = position; const after = list.length - 1 - position;
    const step = Math.min(axis.portSpacing, before ? (target - low) / before : Infinity, after ? (high - target) / after : Infinity);
    if (list.length > 1 && step < 4) return;
    list.forEach((route, index) => place(card, route, side, target + (index - position) * (list.length > 1 ? step : 0)));
  };
  const mainOf = (list, other) => list.filter((route) => route.kind !== 'corridor' && route[other].band === route[other === 'target' ? 'source' : 'target'].band
    && route.source.row === route.target.row)
    .sort((a, b) => (STYLE_PRIORITY[a.arrow.style] ?? 1) - (STYLE_PRIORITY[b.arrow.style] ?? 1) || a.order - b.order)[0];
  for (const card of cards) {
    const exits = outgoing.get(card.id);
    spread(card, exits, departure, 'exit');
    anchorPorts(card, exits, 'exit', mainOf(exits, 'target'), centerC(card));
  }
  for (const card of cards) {
    const entries = incoming.get(card.id);
    spread(card, entries, approach, 'entry');
    const anchor = mainOf(entries, 'source');
    anchorPorts(card, entries, 'entry', anchor, anchor?.exit.c);
  }

  // Cross-direction runs per gap. Gap g follows rank g; gap -1 is the leading margin.
  const gaps = new Map();
  const gapOf = (index) => { if (!gaps.has(index)) gaps.set(index, { index, runs: [], labels: [] }); return gaps.get(index); };
  for (let index = -1; index < rankCount; index += 1) gapOf(index);
  for (const route of routes) {
    const a = route.exit.c; const b = route.entry.c;
    const rs = route.source.rank; const rt = route.target.rank;
    route.runs = [];
    const add = (gap, c1, side1, c2, side2) => {
      const run = { route, c1, c2, order: route.order, attachments: [{ c: c1, side: side1 }, { c: c2, side: side2 }] };
      gapOf(gap).runs.push(run);
      route.runs.push({ gap, run });
    };
    if (route.kind === 'adjacent' || route.kind === 'target-row') { if (Math.abs(a - b) > .5) add(rs, a, 'start', b, 'end'); }
    else if (route.kind === 'source-row') { if (Math.abs(a - b) > .5) add(rt - 1, a, 'start', b, 'end'); }
    else if (rt <= rs) { add(rs, a, 'start', route.cc, 'start'); add(rt - 1, route.cc, 'end', b, 'end'); }
    else { add(rs, a, 'start', route.cc, 'end'); add(rt - 1, route.cc, 'start', b, 'end'); }
    if (route.arrow.label) gapOf(rs).labels.push(route);
  }

  for (const gap of gaps.values()) {
    gap.order = orderRuns(gap.runs);
    gap.order.forEach((run, track) => { run.track = track; });
    for (const route of gap.labels) {
      const cut = truncateText(route.arrow.label, metrics.arrowLabelMaxText, metrics.arrowFont);
      const width = Math.ceil(textWidth(cut.text, metrics.arrowFont) + metrics.arrowLabelPadX * 2 + 4);
      route.labelBox = { ...cut, width, height: metrics.arrowLabelHeight, main: rowsMode ? width : metrics.arrowLabelHeight, cross: rowsMode ? metrics.arrowLabelHeight : width };
    }
    const tracks = gap.order.length * metrics.trackSpacing + axis.gapPad * 2;
    const labels = Math.max(0, ...gap.labels.map((route) => route.labelBox.main + 14));
    const minimum = gap.index === -1 || gap.index === rankCount - 1 ? axis.margin : axis.gapMin;
    gap.size = Math.min(axis.gapMax, Math.max(minimum, tracks, labels));
    gap.spacing = gap.order.length > 1 ? Math.min(metrics.trackSpacing, (gap.size - axis.gapPad * 2) / (gap.order.length - 1)) : 0;
  }

  // Main axis positions.
  const ranks = [];
  let m = gaps.get(-1).size;
  gaps.get(-1).start = 0;
  for (let r = 0; r < rankCount; r += 1) {
    ranks.push({ index: r, start: m, size: rankSize[r] });
    gaps.get(r).start = m + rankSize[r];
    m += rankSize[r] + gaps.get(r).size;
  }
  const mainTotal = Math.max(m, gaps.get(-1).size + metrics.cardWidth + axis.margin);
  for (const card of cards) card.m = ranks[card.rank].start + (ranks[card.rank].size - mainSize(card)) / 2;
  const trackAt = (gapIndex, run) => {
    const gap = gaps.get(gapIndex);
    return gap.start + gap.size / 2 + (run.track - (gap.order.length - 1) / 2) * gap.spacing;
  };
  const toXY = rowsMode ? ({ m: mm, c }) => ({ x: Math.round(mm * 10) / 10, y: Math.round(c * 10) / 10 })
    : ({ m: mm, c }) => ({ x: Math.round(c * 10) / 10, y: Math.round(mm * 10) / 10 });

  const arrows = routes.map((route) => {
    const { source, target } = route;
    const start = { m: source.m + mainSize(source) - route.exit.inset, c: route.exit.c };
    const end = { m: target.m + route.entry.inset, c: route.entry.c };
    let points;
    if (!route.runs.length) points = [start, { m: end.m, c: start.c }];
    else if (route.runs.length === 1) {
      const t = trackAt(route.runs[0].gap, route.runs[0].run);
      points = [start, { m: t, c: start.c }, { m: t, c: end.c }, end];
    } else {
      const t1 = trackAt(route.runs[0].gap, route.runs[0].run);
      const t2 = trackAt(route.runs[1].gap, route.runs[1].run);
      points = [start, { m: t1, c: start.c }, { m: t1, c: route.cc }, { m: t2, c: route.cc }, { m: t2, c: end.c }, end];
    }
    return { key: route.key, source: route.arrow.source, target: route.arrow.target, style: route.arrow.style || 'next',
      label: route.arrow.label, isReturn: route.isReturn, kind: route.kind, points: simplify(points).map(toXY), labelBox: null };
  });

  // Arrow labels sit in the gap after the source, on their arrow, never on a card.
  const byKey = new Map(arrows.map((arrow) => [arrow.key, arrow]));
  for (const gap of gaps.values()) {
    if (!gap.labels.length) continue;
    const placed = gap.labels.map((route) => {
      const own = route.runs.find((entry) => entry.gap === gap.index);
      const span = own ? Math.abs(own.run.c2 - own.run.c1) : 0;
      const desired = own && span >= route.labelBox.cross + 10 ? (own.run.c1 + own.run.c2) / 2 : route.exit.c;
      return { route, desired };
    }).sort((a, b) => a.desired - b.desired || a.route.order - b.route.order);
    let floor = -Infinity;
    for (const { route, desired } of placed) {
      const box = route.labelBox;
      const center = Math.max(desired, floor + box.cross / 2 + 3);
      const mainExtent = Math.min(box.main, gap.size - 8);
      const m0 = gap.start + (gap.size - mainExtent) / 2; const c0 = center - box.cross / 2;
      const rect = rowsMode ? { x: m0, y: c0, width: mainExtent, height: box.cross } : { x: c0, y: m0, width: box.cross, height: mainExtent };
      byKey.get(route.key).labelBox = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
        text: box.text, full: route.arrow.label, truncated: box.truncated };
      floor = center + box.cross / 2;
    }
  }

  const outCards = cards.map((card) => {
    const point = toXY({ m: card.m, c: card.c });
    return { id: card.id, step: card.step, band: card.band, rank: card.rank, row: card.row, x: point.x, y: point.y,
      width: card.width, height: card.height, lines: card.lines, noteLines: card.noteLines };
  });
  const outBands = bands.map((band) => (rowsMode
    ? { id: band.id, laneId: band.laneId, title: band.title, index: band.index, stepCount: band.stepCount, x: 0, y: band.start, width: mainTotal, height: band.size }
    : { id: band.id, laneId: band.laneId, title: band.title, index: band.index, stepCount: band.stepCount, x: band.start, y: 0, width: band.size, height: mainTotal }));
  const bounds = rowsMode ? { x: 0, y: 0, width: mainTotal, height: Math.max(1, crossTotal) } : { x: 0, y: 0, width: Math.max(1, crossTotal), height: mainTotal };
  return { orientation, bands: outBands, cards: outCards, arrows, bounds,
    ranks: ranks.map((rank) => ({ index: rank.index, start: rank.start, size: rank.size })),
    gaps: [...gaps.values()].sort((a, b) => a.index - b.index).map((gap) => ({ index: gap.index, start: gap.start, size: gap.size })) };
}
