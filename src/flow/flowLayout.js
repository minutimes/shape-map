// Pure flow map layout. Steps are ordered along a main axis by their arrows and
// stacked along a cross axis by band (lane) and branch row. Arrow routes are
// orthogonal and stay in the empty gaps between ranks and rows, so they never
// cross a card. The same graph always produces the same layout.
//
// Orientation 'rows' puts lanes in horizontal bands and reads left to right.
// Orientation 'columns' reads top to bottom; it is used for a map without lanes
// that its author wrote top to bottom, so it looks like a plain flowchart.
//
// Cards placed by hand keep their spot inside their lane band. The automatic
// grid stays where it was, cards under a placed card move out of the way, the
// band grows, and arrows that touch or cross a placed card are routed around
// every card (see flowRouting.js).
import { SHARED_BAND_ID } from './flowConstants.js';
import { textWidth, truncateText, wrapText } from './flowText.js';
import { chooseSides, markUsed, routeAround, sidePoint } from './flowRouting.js';

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

/** Rows of a band that hold only free cards are dropped so the band closes up. */
function compactRows(steps, row, free) {
  const used = new Map();
  for (const step of steps) {
    if (free.has(step.id)) continue;
    const band = bandIdOf(step);
    if (!used.has(band)) used.set(band, new Set());
    used.get(band).add(row.get(step.id));
  }
  const renumber = new Map([...used].map(([band, rows]) => [band, new Map([...rows].sort((a, b) => a - b).map((value, index) => [value, index]))]));
  const next = new Map();
  for (const step of steps) next.set(step.id, free.has(step.id) ? -1 : renumber.get(bandIdOf(step)).get(row.get(step.id)));
  return next;
}

/**
 * One pass of the grid layout. `free` maps step IDs to spots that are not on
 * the grid ({ m, rc, kind }: main-axis position and cross position inside the
 * band); those cards and their arrows stay out of the grid. `minGaps` keeps the
 * gaps of the automatic layout, so placing a card never shifts other columns.
 */
function gridPass(graph, options, metrics, free = new Map(), minGaps = null) {
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
  const assigned = assignRows(steps, ranking, bandIndex);
  const row = free.size ? compactRows(steps, assigned.row, free) : assigned.row;
  const occupied = free.size
    ? new Map(steps.filter((step) => !free.has(step.id)).map((step) => [`${bandIdOf(step)}|${ranking.rank.get(step.id)}|${row.get(step.id)}`, step.id]))
    : assigned.occupied;
  const rankCount = ranking.rankCount;
  const size = new Map(steps.map((step) => [step.id, cardSize(step, options, metrics)]));
  const mainSize = (card) => (rowsMode ? card.width : card.height);
  const crossSize = (card) => (rowsMode ? card.height : card.width);

  // Cross axis: bands, rows inside bands, and the free corridors between them.
  let cursor = 0;
  const bands = []; const corridors = []; const rowBounds = new Map(); const bandStart = new Map();
  for (const band of bandList) {
    const members = steps.filter((step) => bandIdOf(step) === band.id);
    const gridMembers = free.size ? members.filter((step) => !free.has(step.id)) : members;
    const rowCount = gridMembers.length ? Math.max(...gridMembers.map((step) => row.get(step.id))) + 1 : 0;
    const sizes = Array.from({ length: rowCount }, (_, r) => Math.max(axis.rowMin,
      ...gridMembers.filter((step) => row.get(step.id) === r).map((step) => crossSize(size.get(step.id)))));
    const start = cursor;
    const rows = [];
    let c = start + axis.bandPad;
    for (let r = 0; r < rowCount; r += 1) { rows.push({ start: c, end: c + sizes[r] }); c += sizes[r] + axis.rowGap; }
    const gridExtent = rowCount ? c - axis.rowGap + axis.bandPad - start : axis.emptyBand;
    // A band grows to hold the cards placed in it.
    const freeExtent = Math.max(0, ...members.filter((step) => free.has(step.id))
      .map((step) => free.get(step.id).rc + crossSize(size.get(step.id)) + axis.bandPad));
    const extent = Math.max(gridExtent, freeExtent);
    const end = start + extent; const gridEnd = start + gridExtent;
    bands.push({ ...band, index: bands.length, start, size: extent, rows, stepCount: members.length });
    bandStart.set(band.id, start);
    rows.forEach((bounds, r) => rowBounds.set(`${band.id}|${r}`, bounds));
    if (!rowCount) corridors.push({ band: band.id, c0: start + 8, c1: gridEnd - 8 });
    else {
      corridors.push({ band: band.id, c0: start + 3, c1: rows[0].start - 4 });
      for (let r = 0; r < rowCount - 1; r += 1) corridors.push({ band: band.id, c0: rows[r].end + 4, c1: rows[r + 1].start - 4 });
      corridors.push({ band: band.id, c0: rows.at(-1).end + 4, c1: gridEnd - 3 });
    }
    cursor = end;
  }
  const crossTotal = cursor;

  // Main axis rank thickness (every card in one rank shares a slot).
  const rankSize = Array.from({ length: rankCount }, () => 0);
  for (const step of steps) rankSize[ranking.rank.get(step.id)] = Math.max(rankSize[ranking.rank.get(step.id)], mainSize(size.get(step.id)));

  const cards = steps.map((step) => {
    const { width, height, lines, noteLines } = size.get(step.id);
    const card = { id: step.id, step, band: bandIdOf(step), rank: ranking.rank.get(step.id), row: row.get(step.id), width, height, lines, noteLines };
    const spot = free.get(step.id);
    if (spot) {
      card.free = spot.kind || 'placed';
      card.c = bandStart.get(card.band) + spot.rc;
      card.fixedM = spot.m;
      return card;
    }
    const bounds = rowBounds.get(`${bandIdOf(step)}|${row.get(step.id)}`);
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
  const gridArrows = free.size ? ranking.arrows.filter((arrow) => !free.has(arrow.source) && !free.has(arrow.target)) : ranking.arrows;
  const routes = gridArrows.map((arrow, order) => {
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
    gap.size = Math.min(axis.gapMax, Math.max(minimum, tracks, labels, minGaps?.get(gap.index) ?? 0));
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
  let mainTotal = Math.max(m, gaps.get(-1).size + metrics.cardWidth + axis.margin);
  for (const card of cards) {
    card.m = card.fixedM ?? ranks[card.rank].start + (ranks[card.rank].size - mainSize(card)) / 2;
    if (card.free) mainTotal = Math.max(mainTotal, card.m + mainSize(card) + axis.margin);
  }
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
  const ports = new Map(routes.map((route) => [route.key, { exit: route.exit.c, entry: route.entry.c }]));

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

  return {
    orientation, rowsMode, axis, ranking, cards, arrows, ports, bands, gaps, ranks, mainTotal, crossTotal, bandStart, toXY, mainSize, crossSize,
    freeArrows: free.size ? ranking.arrows.filter((arrow) => free.has(arrow.source) || free.has(arrow.target)) : [],
  };
}

/** Hand-set placements that apply to this graph, as main/cross spots inside each band. */
function readPlacements(graph, placements, rowsMode) {
  const result = new Map();
  if (!placements || typeof placements !== 'object') return result;
  for (const step of graph.steps || []) {
    const spot = placements[step.id];
    if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.y)) continue;
    const x = Math.max(0, spot.x); const y = Math.max(0, spot.y);
    result.set(step.id, rowsMode ? { m: x, rc: y, kind: 'placed' } : { m: y, rc: x, kind: 'placed' });
  }
  return result;
}

// Clearance between a placed card and its neighbors: room for an arrow to pass.
export const PLACE_GAP = 28;

/** Overlap in main/cross space, keeping a clearance between cards. */
function clash(a, b, gap = PLACE_GAP) {
  return a.m < b.m + b.mainSize + gap && b.m < a.m + a.mainSize + gap && a.rc < b.rc + b.crossSize + gap && b.rc < a.rc + a.crossSize + gap;
}

/**
 * Settles placed cards (a card that would cover an earlier one moves past it
 * along the cross axis) and moves automatic cards out from under placed ones.
 * Saved spots are never rewritten; this spacing is derived on every layout.
 */
function settle(pass, requested) {
  const { axis } = pass;
  const declaration = new Map(pass.cards.map((card, index) => [card.id, index]));
  const boxes = pass.cards.map((card) => {
    const spot = requested.get(card.id);
    return { id: card.id, band: card.band, m: spot ? spot.m : card.m, rc: spot ? spot.rc : card.c - pass.bandStart.get(card.band),
      mainSize: pass.mainSize(card), crossSize: pass.crossSize(card), spot, row: card.row, rank: card.rank };
  });
  const settled = new Map();
  const settleBox = (box) => {
    const list = settled.get(box.band) || [];
    for (let guard = 0; guard < 500; guard += 1) {
      const blocker = list.find((other) => clash(box, other));
      if (!blocker) break;
      box.rc = blocker.rc + blocker.crossSize + PLACE_GAP;
    }
    list.push(box);
    settled.set(box.band, list);
  };
  const next = new Map();
  const placed = boxes.filter((box) => box.spot?.kind === 'placed')
    .sort((a, b) => a.rc - b.rc || a.m - b.m || declaration.get(a.id) - declaration.get(b.id));
  for (const box of placed) { settleBox(box); next.set(box.id, { ...box.spot, rc: box.rc }); }
  const others = boxes.filter((box) => box.spot?.kind !== 'placed')
    .sort((a, b) => a.row - b.row || a.rank - b.rank || declaration.get(a.id) - declaration.get(b.id));
  for (const box of others) {
    const list = settled.get(box.band) || [];
    if (!box.spot && !list.some((other) => clash(box, other))) {
      // A card that stays on the grid still blocks cards moved out of the way later.
      list.push(box); settled.set(box.band, list);
      continue;
    }
    if (box.spot) box.rc = box.spot.rc;
    const blocker = list.find((other) => clash(box, other));
    if (blocker) box.rc = Math.max(box.rc, blocker.rc + blocker.crossSize + axis.rowGap);
    settleBox(box);
    next.set(box.id, { m: box.m, rc: box.rc, kind: 'moved' });
  }
  return next;
}

const sameSpots = (a, b) => a.size === b.size && [...a].every(([id, spot]) => {
  const other = b.get(id);
  return other && other.kind === spot.kind && Math.abs(other.m - spot.m) < .01 && Math.abs(other.rc - spot.rc) < .01;
});

const overlapBox = (a, b, pad = 3) => a.x < b.x + b.width + pad && b.x < a.x + a.width + pad && a.y < b.y + b.height + pad && b.y < a.y + a.height + pad;

function segmentCrosses(a, b, rect, pad = 2) {
  const left = rect.x - pad; const right = rect.x + rect.width + pad; const top = rect.y - pad; const bottom = rect.y + rect.height + pad;
  if (Math.abs(a.y - b.y) < .01) return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

/**
 * Routes the arrows that touch a card off the grid, or that such a card now
 * blocks, around every card, and gives their labels a clear spot.
 */
function routeOffGrid(pass, metrics) {
  const { orientation, rowsMode } = pass;
  const rects = pass.cards.map((card) => { const point = pass.toXY({ m: card.m, c: card.c }); return { id: card.id, x: point.x, y: point.y, width: card.width, height: card.height, card }; });
  const rectById = new Map(rects.map((item) => [item.id, item]));
  const offGrid = rects.filter((item) => item.card.free);
  const kept = []; const jobs = [];
  for (const arrow of pass.arrows) {
    const blocked = offGrid.some((item) => item.id !== arrow.source && item.id !== arrow.target
      && arrow.points.some((point, index) => index > 0 && segmentCrosses(arrow.points[index - 1], point, item)))
      || (arrow.labelBox && offGrid.some((item) => overlapBox(arrow.labelBox, item)));
    if (blocked) jobs.push({ arrow, key: arrow.key, isReturn: arrow.isReturn });
    else kept.push(arrow);
  }
  for (const arrow of pass.freeArrows) jobs.push({ arrow, key: arrowKey(arrow), isReturn: pass.ranking.returns.has(arrowKey(arrow)) });
  if (!jobs.length) return kept;

  // Ports still used by arrows that keep their automatic route.
  const taken = new Map();
  const take = (key, value) => { if (!taken.has(key)) taken.set(key, []); taken.get(key).push(value); };
  for (const arrow of kept) {
    const port = pass.ports.get(arrow.key);
    take(`${arrow.source}|${rowsMode ? 'right' : 'bottom'}`, port.exit);
    take(`${arrow.target}|${rowsMode ? 'left' : 'top'}`, port.entry);
  }
  const groups = new Map();
  const join = (key, entry) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(entry); };
  for (const job of jobs) {
    job.sourceRect = rectById.get(job.arrow.source); job.targetRect = rectById.get(job.arrow.target);
    Object.assign(job, chooseSides(job.sourceRect, job.targetRect, orientation));
    join(`${job.arrow.source}|${job.exit}`, { job, end: 'start', far: job.targetRect });
    join(`${job.arrow.target}|${job.entry}`, { job, end: 'end', far: job.sourceRect });
  }
  // Spread ports along each side by where the other end is, around ports already taken.
  // Exits go first; an entry then lines up with its exit when it can, so the arrow runs straight.
  const spacing = metrics.rows.portSpacing;
  const assign = (key, list, phase) => {
    const cut = key.lastIndexOf('|');
    const item = rectById.get(key.slice(0, cut)); const side = key.slice(cut + 1);
    const vertical = side === 'left' || side === 'right';
    const center = vertical ? item.y + item.height / 2 : item.x + item.width / 2;
    const reach = Math.max(0, (vertical ? item.height : item.width) / 2 - (vertical ? 9 : 22));
    const farCenter = (entry) => (vertical ? entry.far.y + entry.far.height / 2 : entry.far.x + entry.far.width / 2);
    list.sort((a, b) => farCenter(a) - farCenter(b) || a.job.key.localeCompare(b.job.key));
    const shared = (taken.get(key) || []).map((value) => value - center);
    const chosen = [];
    list.forEach((entry, index) => {
      let wanted = list.length === 1 && !shared.length ? 0 : (index - (list.length - 1) / 2) * spacing;
      if (phase === 'end') {
        const exit = entry.job.start; const aligned = (vertical ? exit.y : exit.x) - center;
        if (Math.abs(aligned) <= reach) wanted = aligned;
      }
      let offset = null;
      for (let k = 0; k <= 16 && offset === null; k += 1) {
        for (const candidate of k ? [wanted + k * 4, wanted - k * 4] : [wanted]) {
          if (Math.abs(candidate) > reach + .01) continue;
          if ([...shared, ...chosen].some((value) => Math.abs(value - candidate) < spacing - 2)) continue;
          offset = candidate; break;
        }
      }
      offset ??= Math.max(-reach, Math.min(reach, wanted));
      chosen.push(offset);
      const inset = portInset(item.card.step.shape, item.card, offset, vertical ? 'rows' : 'columns', metrics);
      entry.job[entry.end] = sidePoint(item, side, offset, inset);
    });
  };
  for (const phase of ['start', 'end']) {
    for (const [key, list] of groups) {
      const part = list.filter((entry) => entry.end === phase);
      if (part.length) assign(key, part, phase);
      // Ports chosen for exits are taken for entries on the same side.
      if (phase === 'start') for (const entry of part) { const point = entry.job.start; const vertical = entry.job.exit === 'left' || entry.job.exit === 'right'; take(key, vertical ? point.y : point.x); }
    }
  }
  // Short routes first, so longer detours go around them.
  const distance = (job) => Math.abs(job.start.x - job.end.x) + Math.abs(job.start.y - job.end.y);
  jobs.sort((a, b) => distance(a) - distance(b) || a.key.localeCompare(b.key));
  const used = new Map();
  for (const arrow of kept) markUsed(used, arrow.points);
  const routed = jobs.map((job) => {
    const points = routeAround({ start: job.start, exitSide: job.exit, end: job.end, entrySide: job.entry, obstacles: rects, used })
      .map((point) => ({ x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10 }));
    markUsed(used, points);
    return { key: job.key, source: job.arrow.source, target: job.arrow.target, style: job.arrow.style || 'next', label: job.arrow.label,
      isReturn: job.isReturn, kind: 'free', points, labelBox: null };
  });

  // Labels of rerouted arrows sit on one of their runs, clear of cards and other labels.
  const labels = kept.filter((arrow) => arrow.labelBox).map((arrow) => arrow.labelBox);
  for (const arrow of routed) {
    if (!arrow.label) continue;
    const cut = truncateText(arrow.label, metrics.arrowLabelMaxText, metrics.arrowFont);
    const width = Math.ceil(textWidth(cut.text, metrics.arrowFont) + metrics.arrowLabelPadX * 2 + 4);
    const height = metrics.arrowLabelHeight;
    const clear = (box) => !rects.some((item) => overlapBox(box, item)) && !labels.some((other) => overlapBox(box, other));
    const segments = arrow.points.slice(1).map((point, index) => ({ a: arrow.points[index], b: point, index,
      length: Math.abs(arrow.points[index].x - point.x) + Math.abs(arrow.points[index].y - point.y) }))
      .sort((p, q) => q.length - p.length || p.index - q.index);
    let chosen = null;
    for (const segment of segments) {
      const horizontal = Math.abs(segment.a.y - segment.b.y) < .01;
      const span = horizontal ? width : height;
      if (segment.length < span + 8) continue;
      const low = horizontal ? Math.min(segment.a.x, segment.b.x) : Math.min(segment.a.y, segment.b.y);
      const high = horizontal ? Math.max(segment.a.x, segment.b.x) : Math.max(segment.a.y, segment.b.y);
      const middle = (low + high) / 2;
      for (let shift = 0; !chosen && shift <= (high - low - span) / 2; shift += 8) {
        for (const at of shift ? [middle - shift, middle + shift] : [middle]) {
          const box = horizontal ? { x: at - width / 2, y: segment.a.y - height / 2, width, height } : { x: segment.a.x - width / 2, y: at - height / 2, width, height };
          if (clear(box)) { chosen = box; break; }
        }
      }
      if (chosen) break;
    }
    if (!chosen) {
      // No run is long enough: look along the arrow and beside it for the nearest clear spot.
      const total = segments.reduce((sum, segment) => sum + segment.length, 0);
      const along = (distance) => {
        let rest = distance;
        for (let i = 1; i < arrow.points.length; i += 1) {
          const a = arrow.points[i - 1]; const b = arrow.points[i];
          const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          if (rest <= length) { const t = length ? rest / length : 0; return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }
          rest -= length;
        }
        return arrow.points.at(-1);
      };
      const tries = [];
      for (let step = 0; step <= total; step += 6) {
        const point = along(step);
        for (const [dx, dy] of [[0, 0], [0, -(height / 2 + 4)], [0, height / 2 + 4], [width / 2 + 4, 0], [-(width / 2 + 4), 0], [0, -(height + 8)], [0, height + 8]]) {
          tries.push({ x: point.x + dx - width / 2, y: point.y + dy - height / 2, width, height, rank: Math.abs(step - total / 2) + Math.abs(dx) + Math.abs(dy) * 2 });
        }
      }
      tries.sort((a, b) => a.rank - b.rank);
      chosen = tries.find(clear) || tries[0];
    }
    arrow.labelBox = { x: Math.round(chosen.x), y: Math.round(chosen.y), width, height, text: cut.text, full: arrow.label, truncated: cut.truncated };
    labels.push(arrow.labelBox);
  }
  const order = new Map(pass.ranking.arrows.map((arrow, index) => [arrowKey(arrow), index]));
  return [...kept, ...routed].sort((a, b) => order.get(a.key) - order.get(b.key));
}

/**
 * Lays out a flow map graph ({ lanes, steps, arrows, direction }).
 * `options.placements` maps step IDs to hand-set spots `{x, y}` measured from
 * the top-left corner of the step's lane band. Everything else is automatic.
 * @returns {{ orientation, bands, cards, arrows, ranks, gaps, bounds }} in canvas x/y.
 */
export function layoutFlow(graph, options = {}, metrics = FLOW_METRICS) {
  const base = gridPass(graph, options, metrics);
  const requested = readPlacements(graph, options.placements, base.rowsMode);
  let pass = base;
  if (requested.size) {
    const minGaps = new Map([...base.gaps.values()].map((gap) => [gap.index, gap.size]));
    let free = requested;
    for (let round = 0; round < 8; round += 1) {
      pass = gridPass(graph, options, metrics, free, minGaps);
      const next = settle(pass, free);
      if (sameSpots(next, free)) break;
      free = next;
      if (round === 7) pass = gridPass(graph, options, metrics, free, minGaps);
    }
  }
  const { rowsMode, toXY } = pass;
  const arrows = requested.size ? routeOffGrid(pass, metrics) : pass.arrows;
  const outCards = pass.cards.map((card) => {
    const point = toXY({ m: card.m, c: card.c });
    return { id: card.id, step: card.step, band: card.band, rank: card.rank, row: card.row, x: point.x, y: point.y,
      width: card.width, height: card.height, lines: card.lines, noteLines: card.noteLines, placed: card.free === 'placed' };
  });
  const mainTotal = pass.mainTotal;
  const outBands = pass.bands.map((band) => (rowsMode
    ? { id: band.id, laneId: band.laneId, title: band.title, index: band.index, stepCount: band.stepCount, x: 0, y: band.start, width: mainTotal, height: band.size }
    : { id: band.id, laneId: band.laneId, title: band.title, index: band.index, stepCount: band.stepCount, x: band.start, y: 0, width: band.size, height: mainTotal }));
  let bounds = rowsMode ? { x: 0, y: 0, width: mainTotal, height: Math.max(1, pass.crossTotal) } : { x: 0, y: 0, width: Math.max(1, pass.crossTotal), height: mainTotal };
  if (requested.size) {
    // A detour or a label can reach past the bands; the fit view includes it.
    let right = bounds.width; let bottom = bounds.height;
    for (const arrow of arrows) {
      for (const point of arrow.points) { right = Math.max(right, point.x + 12); bottom = Math.max(bottom, point.y + 12); }
      if (arrow.labelBox) { right = Math.max(right, arrow.labelBox.x + arrow.labelBox.width + 6); bottom = Math.max(bottom, arrow.labelBox.y + arrow.labelBox.height + 6); }
    }
    bounds = { x: 0, y: 0, width: Math.ceil(right), height: Math.ceil(bottom) };
  }
  return { orientation: pass.orientation, bands: outBands, cards: outCards, arrows, bounds,
    ranks: pass.ranks.map((rank) => ({ index: rank.index, start: rank.start, size: rank.size })),
    gaps: [...pass.gaps.values()].sort((a, b) => a.index - b.index).map((gap) => ({ index: gap.index, start: gap.start, size: gap.size })) };
}

/** The lane band under a canvas point; above or below every band, the nearest one. */
export function bandAt(layout, point) {
  const rows = layout.orientation === 'rows';
  const value = rows ? point.y : point.x;
  let nearest = null;
  for (const band of layout.bands) {
    const start = rows ? band.y : band.x; const end = start + (rows ? band.height : band.width);
    if (value >= start && value < end) return band;
    const distance = value < start ? start - value : value - end;
    if (!nearest || distance < nearest.distance) nearest = { band, distance };
  }
  return nearest?.band ?? null;
}

/** A saved placement for a card whose top-left corner is at canvas `point` in `band`. */
export function placementFor(layout, band, point) {
  const x = Math.max(0, Math.round(point.x - band.x)); const y = Math.max(0, Math.round(point.y - band.y));
  return { x, y };
}

/**
 * The nearest spot to `point` (a card's top-left corner) where a card of
 * `size` keeps a clear gap from every other card, staying inside its band's
 * start. Short moves snap to the automatic rows and columns so arrows stay straight.
 */
export function freeSpot(layout, id, size, point, band, gap = PLACE_GAP) {
  const others = layout.cards.filter((card) => card.id !== id);
  const rows = layout.orientation === 'rows';
  const snap = (value, targets, reach = 12) => {
    let best = value; let distance = reach + 1;
    for (const target of targets) if (Math.abs(target - value) < distance) { best = target; distance = Math.abs(target - value); }
    return best;
  };
  const self = layout.cards.find((card) => card.id === id);
  const mainLength = rows ? size.width : size.height;
  const columnStarts = [...new Set([...others.map((card) => (rows ? card.x : card.y)),
    ...layout.ranks.map((rank) => rank.start + (rank.size - mainLength) / 2), ...(self ? [rows ? self.x : self.y] : [])])];
  // Cards in the same band line up by center across the lane.
  const rowCenters = [...new Set(others.filter((card) => card.band === band.id).map((card) => (rows ? card.y + card.height / 2 : card.x + card.width / 2)))];
  const minCross = rows ? band.y + 6 : band.x + 6;
  const tidy = (candidate) => {
    let x = candidate.x; let y = candidate.y;
    if (rows) { x = snap(x, columnStarts); y = snap(y + size.height / 2, rowCenters) - size.height / 2; y = Math.max(minCross, y); x = Math.max(0, x); }
    else { y = snap(y, columnStarts); x = snap(x + size.width / 2, rowCenters) - size.width / 2; x = Math.max(minCross, x); y = Math.max(0, y); }
    return { x: Math.round(x), y: Math.round(y) };
  };
  const fits = (candidate) => others.every((card) => !(candidate.x < card.x + card.width + gap && card.x < candidate.x + size.width + gap
    && candidate.y < card.y + card.height + gap && card.y < candidate.y + size.height + gap));
  const start = tidy(point);
  if (fits(start)) return start;
  const raw = { x: Math.round(Math.max(rows ? 0 : minCross, point.x)), y: Math.round(Math.max(rows ? minCross : 0, point.y)) };
  if (fits(raw)) return raw;
  // Candidates beside each card in the way, then beside those, nearest first.
  let frontier = [raw];
  const seen = new Set();
  let best = null;
  for (let depth = 0; depth < 3 && !best; depth += 1) {
    const next = [];
    for (const from of frontier) {
      for (const card of others) {
        if (!(from.x < card.x + card.width + gap && card.x < from.x + size.width + gap && from.y < card.y + card.height + gap && card.y < from.y + size.height + gap)) continue;
        for (const candidate of [
          { x: card.x - size.width - gap - 1, y: from.y }, { x: card.x + card.width + gap + 1, y: from.y },
          { x: from.x, y: card.y - size.height - gap - 1 }, { x: from.x, y: card.y + card.height + gap + 1 },
        ]) {
          const clamped = { x: Math.round(Math.max(rows ? 0 : minCross, candidate.x)), y: Math.round(Math.max(rows ? minCross : 0, candidate.y)) };
          const key = `${clamped.x},${clamped.y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(clamped);
        }
      }
    }
    const distance = (candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y);
    for (const candidate of next.sort((a, b) => distance(a) - distance(b))) if (fits(candidate)) { best = candidate; break; }
    frontier = next.slice(0, 40);
  }
  return best || raw;
}
