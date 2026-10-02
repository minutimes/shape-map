// Orthogonal arrow routing around cards, used for arrows that touch a card
// placed by hand (or are blocked by one). The automatic layout routes every
// other arrow through its own gaps and corridors.
//
// Routes run on a sparse grid built from the cards' padded edges, the channel
// centers between them, and the two ports. A* finds the shortest path with few
// bends; segments already used by earlier routes cost a little more, so
// parallel arrows spread out instead of drawing over each other.

export const ROUTE_PAD = 10;
export const ROUTE_STUB = 14;
const BEND = 26;
const REUSE = 18;
const EDGE_HUG = .12;
const WINDOW = 260;

const NORMAL = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, bottom: { x: 0, y: 1 }, top: { x: 0, y: -1 } };
// Direction indexes: 0 +x, 1 -x, 2 +y, 3 -y.
const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
const dirOf = (vector) => (vector.x > 0 ? 0 : vector.x < 0 ? 1 : vector.y > 0 ? 2 : 3);

export const sideNormal = (side) => NORMAL[side];

/** A point on the side of a card: `offset` runs along the side from its center. */
export function sidePoint(card, side, offset = 0, inset = 0) {
  if (side === 'right') return { x: card.x + card.width - inset, y: card.y + card.height / 2 + offset };
  if (side === 'left') return { x: card.x + inset, y: card.y + card.height / 2 + offset };
  if (side === 'bottom') return { x: card.x + card.width / 2 + offset, y: card.y + card.height - inset };
  return { x: card.x + card.width / 2 + offset, y: card.y + inset };
}

/**
 * Which sides an arrow leaves and enters by. Arrows read along the main axis
 * (left to right in lanes); a target placed clearly below or above its source
 * is reached from the top or the bottom instead of looping around.
 */
export function chooseSides(source, target, orientation) {
  const room = ROUTE_STUB * 2 + 4;
  if (orientation === 'columns') {
    if (target.y - (source.y + source.height) >= room) return { exit: 'bottom', entry: 'top' };
    if (target.x - (source.x + source.width) >= room) return { exit: 'right', entry: 'left' };
    if (source.x - (target.x + target.width) >= room) return { exit: 'left', entry: 'right' };
    return { exit: 'bottom', entry: 'top' };
  }
  if (target.x - (source.x + source.width) >= room) return { exit: 'right', entry: 'left' };
  if (target.y - (source.y + source.height) >= room) return { exit: 'bottom', entry: 'top' };
  if (source.y - (target.y + target.height) >= room) return { exit: 'top', entry: 'bottom' };
  return { exit: 'right', entry: 'left' };
}

class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const items = this.items; items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= item.f) break;
      items[i] = items[parent]; i = parent;
    }
    items[i] = item;
  }
  pop() {
    const items = this.items; const top = items[0]; const last = items.pop();
    if (items.length) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1; const right = left + 1;
        let smallest = i; let value = last.f;
        if (left < items.length && items[left].f < value) { smallest = left; value = items[left].f; }
        if (right < items.length && items[right].f < value) smallest = right;
        if (smallest === i) break;
        items[i] = items[smallest]; i = smallest;
      }
      items[i] = last;
    }
    return top;
  }
}

function sortedUnique(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const result = [];
  for (const value of sorted) if (!result.length || Math.abs(value - result.at(-1)) > .5) result.push(value);
  return result;
}

function indexOf(list, value) {
  let low = 0; let high = list.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (Math.abs(list[middle] - value) <= .5) return middle;
    if (list[middle] < value) low = middle + 1; else high = middle - 1;
  }
  return -1;
}

function searchWindow(start, end, obstacles, margin) {
  const x0 = Math.min(start.x, end.x) - margin; const x1 = Math.max(start.x, end.x) + margin;
  const y0 = Math.min(start.y, end.y) - margin; const y1 = Math.max(start.y, end.y) + margin;
  const inside = obstacles.filter((rect) => rect.x < x1 && rect.x + rect.width > x0 && rect.y < y1 && rect.y + rect.height > y0);
  return { x0, x1, y0, y1, inside };
}

function search(start, startDir, end, endDir, area, used, pad = ROUTE_PAD) {
  const within = (point, box) => point.x > box.x0 + .01 && point.x < box.x1 - .01 && point.y > box.y0 + .01 && point.y < box.y1 - .01;
  // A card close to a port keeps only its own outline as the obstacle, so the port stays reachable.
  const boxes = area.inside.map((rect) => {
    const padded = { x0: rect.x - pad, x1: rect.x + rect.width + pad, y0: rect.y - pad, y1: rect.y + rect.height + pad };
    return within(start, padded) || within(end, padded) ? { x0: rect.x, x1: rect.x + rect.width, y0: rect.y, y1: rect.y + rect.height } : padded;
  });
  const xBoundary = [area.x0, area.x1, start.x, end.x]; const yBoundary = [area.y0, area.y1, start.y, end.y];
  for (const box of boxes) { xBoundary.push(box.x0, box.x1); yBoundary.push(box.y0, box.y1); }
  const withMiddles = (values) => {
    const base = sortedUnique(values.filter(Number.isFinite));
    const result = [...base];
    for (let i = 1; i < base.length; i += 1) if (base[i] - base[i - 1] > 6) result.push((base[i] + base[i - 1]) / 2);
    return { all: sortedUnique(result), edges: new Set(base.map((value) => Math.round(value * 2))) };
  };
  const X = withMiddles(xBoundary); const Y = withMiddles(yBoundary);
  const xs = X.all; const ys = Y.all;
  const nx = xs.length; const ny = ys.length;
  const strictly = (value, low, high) => value > low + .01 && value < high - .01;
  // Rasterize the padded cards onto the grid: blocked nodes and blocked unit segments.
  const nodeBlocked = new Uint8Array(nx * ny);
  const hBlocked = new Uint8Array(nx * ny); // segment from (i, j) to (i + 1, j)
  const vBlocked = new Uint8Array(nx * ny); // segment from (i, j) to (i, j + 1)
  const lower = (list, value) => { let low = 0; let high = list.length; while (low < high) { const mid = (low + high) >> 1; if (list[mid] < value) low = mid + 1; else high = mid; } return low; };
  for (const box of boxes) {
    const i0 = lower(xs, box.x0 - .01); const j0 = lower(ys, box.y0 - .01);
    for (let i = i0; i < nx && xs[i] <= box.x1 + .01; i += 1) {
      for (let j = j0; j < ny && ys[j] <= box.y1 + .01; j += 1) {
        const index = i * ny + j;
        const inX = strictly(xs[i], box.x0, box.x1); const inY = strictly(ys[j], box.y0, box.y1);
        if (inX && inY) nodeBlocked[index] = 1;
        if (inY && i + 1 < nx && xs[i + 1] <= box.x1 + .01) hBlocked[index] = 1;
        if (inX && j + 1 < ny && ys[j + 1] <= box.y1 + .01) vBlocked[index] = 1;
      }
    }
  }
  const si = indexOf(xs, start.x); const sj = indexOf(ys, start.y);
  const ei = indexOf(xs, end.x); const ej = indexOf(ys, end.y);
  if (si < 0 || sj < 0 || ei < 0 || ej < 0) return null;
  const startNode = si * ny + sj; const endNode = ei * ny + ej;
  nodeBlocked[startNode] = 0; nodeBlocked[endNode] = 0;
  const best = new Float64Array(nx * ny * 4).fill(Infinity);
  const previous = new Int32Array(nx * ny * 4).fill(-1);
  const heap = new Heap();
  const h = (i, j) => Math.abs(xs[i] - end.x) + Math.abs(ys[j] - end.y);
  const startState = startNode * 4 + startDir;
  best[startState] = 0;
  heap.push({ state: startState, f: h(si, sj), g: 0 });
  let reached = -1;
  while (heap.size) {
    const { state, g } = heap.pop();
    if (g > best[state]) continue;
    const node = state >> 2; const dir = state & 3;
    if (node === endNode) {
      const finalCost = g + (dir === endDir ? 0 : BEND * 2);
      if (dir === endDir) { reached = state; break; }
      const target = endNode * 4 + endDir;
      if (finalCost < best[target]) { best[target] = finalCost; previous[target] = state; heap.push({ state: target, f: finalCost, g: finalCost }); }
      continue;
    }
    const i = Math.floor(node / ny); const j = node % ny;
    for (let next = 0; next < 4; next += 1) {
      if ((dir ^ 1) === next && (dir >> 1) === (next >> 1)) continue; // no reversing
      const d = DIRS[next];
      const ni = i + d.x; const nj = j + d.y;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nNode = ni * ny + nj;
      if (nodeBlocked[nNode]) continue;
      const horizontal = next < 2;
      const segmentIndex = horizontal ? Math.min(i, ni) * ny + j : i * ny + Math.min(j, nj);
      if (horizontal ? hBlocked[segmentIndex] : vBlocked[segmentIndex]) continue;
      const length = horizontal ? Math.abs(xs[ni] - xs[i]) : Math.abs(ys[nj] - ys[j]);
      let cost = length + (next === dir ? 0 : BEND);
      const hugs = horizontal ? Y.edges.has(Math.round(ys[j] * 2)) : X.edges.has(Math.round(xs[i] * 2));
      if (hugs) cost += length * EDGE_HUG;
      if (used && isUsed(used, horizontal, horizontal ? ys[j] : xs[i], horizontal ? Math.min(xs[i], xs[ni]) : Math.min(ys[j], ys[nj]), horizontal ? Math.max(xs[i], xs[ni]) : Math.max(ys[j], ys[nj]))) cost += REUSE + length * .4;
      const nState = nNode * 4 + next;
      const ng = g + cost;
      if (ng < best[nState] - 1e-9) {
        best[nState] = ng; previous[nState] = state;
        heap.push({ state: nState, f: ng + h(ni, nj), g: ng });
      }
    }
  }
  if (reached < 0) return null;
  const path = [];
  for (let state = reached; state >= 0; state = previous[state]) {
    const node = state >> 2;
    const point = { x: xs[Math.floor(node / ny)], y: ys[node % ny] };
    if (!path.length || path.at(-1).x !== point.x || path.at(-1).y !== point.y) path.push(point);
    if (state === startState) break;
  }
  return path.reverse();
}

const NEAR = 3;

function isUsed(used, horizontal, line, low, high) {
  const base = Math.round(line);
  for (let key = base - NEAR; key <= base + NEAR; key += 1) {
    const runs = used.get(`${horizontal ? 'h' : 'v'}${key}`);
    if (runs) for (const [a, b] of runs) if (a < high - .5 && b > low + .5) return true;
  }
  return false;
}

/** Marks a finished route so later routes avoid drawing on top of it. */
export function markUsed(used, points) {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]; const b = points[i];
    const horizontal = Math.abs(a.y - b.y) < .01;
    const key = `${horizontal ? 'h' : 'v'}${Math.round(horizontal ? a.y : a.x)}`;
    const run = horizontal ? [Math.min(a.x, b.x), Math.max(a.x, b.x)] : [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    if (!used.has(key)) used.set(key, []);
    used.get(key).push(run);
  }
}

export function simplifyPoints(points) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (last && Math.abs(last.x - point.x) < .01 && Math.abs(last.y - point.y) < .01) continue;
    const before = result.at(-2);
    if (before && last && ((Math.abs(before.x - last.x) < .01 && Math.abs(last.x - point.x) < .01)
      || (Math.abs(before.y - last.y) < .01 && Math.abs(last.y - point.y) < .01))) result.pop();
    result.push(point);
  }
  return result;
}

/**
 * Routes one arrow from `start` (a port on the source's `exitSide`) to `end`
 * (a port on the target's `entrySide`) around `obstacles` (card rectangles).
 * Returns orthogonal points from port to port.
 */
export function routeAround({ start, exitSide, end, entrySide, obstacles, used = null }) {
  const out = NORMAL[exitSide]; const back = NORMAL[entrySide];
  const s = { x: start.x + out.x * ROUTE_STUB, y: start.y + out.y * ROUTE_STUB };
  const t = { x: end.x + back.x * ROUTE_STUB, y: end.y + back.y * ROUTE_STUB };
  const startDir = dirOf(out); const endDir = dirOf({ x: -back.x, y: -back.y });
  let path = null;
  // Widen the search step by step; tight spots finally allow arrows closer to cards.
  for (const [margin, pad] of [[WINDOW, ROUTE_PAD], [WINDOW * 3, ROUTE_PAD], [Infinity, ROUTE_PAD], [Infinity, 3]]) {
    const area = Number.isFinite(margin) ? searchWindow(s, t, obstacles, margin) : (() => {
      const all = searchWindow(s, t, obstacles, 0);
      const xs = obstacles.flatMap((rect) => [rect.x, rect.x + rect.width]); const ys = obstacles.flatMap((rect) => [rect.y, rect.y + rect.height]);
      return { x0: Math.min(all.x0, ...xs) - WINDOW, x1: Math.max(all.x1, ...xs) + WINDOW, y0: Math.min(all.y0, ...ys) - WINDOW, y1: Math.max(all.y1, ...ys) + WINDOW, inside: obstacles };
    })();
    path = search(s, startDir, t, endDir, area, used, pad);
    if (path) break;
  }
  if (!path) {
    // Nothing found (cards packed around a port): a plain elbow keeps the arrow readable.
    const middle = exitSide === 'right' || exitSide === 'left' ? [{ x: (s.x + t.x) / 2, y: s.y }, { x: (s.x + t.x) / 2, y: t.y }] : [{ x: s.x, y: (s.y + t.y) / 2 }, { x: t.x, y: (s.y + t.y) / 2 }];
    path = [s, ...middle, t];
  }
  return simplifyPoints([start, ...path, end]);
}
