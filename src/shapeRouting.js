const SIDES = { in: 'left', out: 'right', 'left-source': 'left', 'right-target': 'right',
  top: 'top', bottom: 'bottom', 'top-source': 'top', 'bottom-target': 'bottom' };
const NORMALS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
const same = (a, b) => a.x === b.x && a.y === b.y;
const distance = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const routeCache = new Map();

export function routeSegments(points) {
  return points.slice(1).map((point, index) => [points[index], point]);
}

export function segmentHitsRect([a, b], rect, padding = 0) {
  const left = rect.x - padding; const right = rect.x + rect.width + padding;
  const top = rect.y - padding; const bottom = rect.y + rect.height + padding;
  return a.y === b.y ? a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right
    : a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

function segmentConflict([a, b], [c, d]) {
  const horizontal = a.y === b.y; const otherHorizontal = c.y === d.y;
  if (horizontal === otherHorizontal) {
    const separation = Math.abs(horizontal ? a.y - c.y : a.x - c.x);
    const overlap = Math.min(horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y), horizontal ? Math.max(c.x, d.x) : Math.max(c.y, d.y))
      - Math.max(horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y), horizontal ? Math.min(c.x, d.x) : Math.min(c.y, d.y));
    return overlap > 0 && separation < 8 ? (separation < .5 ? 10000 + overlap * 100 : overlap * 8) : 0;
  }
  const h = horizontal ? [a, b] : [c, d]; const v = horizontal ? [c, d] : [a, b];
  return v[0].x > Math.min(h[0].x, h[1].x) && v[0].x < Math.max(h[0].x, h[1].x)
    && h[0].y > Math.min(v[0].y, v[1].y) && h[0].y < Math.max(v[0].y, v[1].y) ? 90 : 0;
}

function simplify(points, allowRetrace = false) {
  const result = [];
  for (const point of points) {
    if (result.length && same(result.at(-1), point)) continue;
    const a = result.at(-2); const b = result.at(-1);
    if (a && ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y))) {
      // A route must not double back on itself to reach a lane behind its port.
      if (!allowRetrace && (b.x - a.x) * (point.x - b.x) + (b.y - a.y) * (point.y - b.y) < 0) return null;
      result.pop();
    }
    result.push(point);
  }
  return result;
}

function boxesFor(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return new Map(nodes.map((node) => {
    let parent = byId.get(node.parentId); const ancestors = new Set();
    let x = node.position.x; let y = node.position.y;
    while (parent && !ancestors.has(parent.id)) {
      ancestors.add(parent.id); x += parent.position.x; y += parent.position.y; parent = byId.get(parent.parentId);
    }
    return [node.id, { x, y, width: node.measured?.width || node.style.width, height: node.measured?.height || node.style.height,
      headerHeight: node.type === 'shapeGroup' && !node.data?.collapsed ? node.data?.headerHeight || 0 : 0, ancestors }];
  }));
}

function assignPorts(edges, boxes) {
  const groups = new Map(); const ports = new Map();
  for (const edge of edges) for (const role of ['source', 'target']) {
    const side = SIDES[edge[`${role}Handle`]];
    const other = boxes.get(edge[role === 'source' ? 'target' : 'source']);
    const key = `${edge[role]}:${side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ edge, role, side, coordinate: side === 'top' || side === 'bottom' ? other.x + other.width / 2 : other.y + other.height / 2 });
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.coordinate - b.coordinate || a.edge.id.localeCompare(b.edge.id) || a.role.localeCompare(b.role));
    const box = boxes.get(group[0].edge[group[0].role]); const side = group[0].side;
    const horizontal = side === 'top' || side === 'bottom';
    const length = horizontal ? box.width : box.height;
    const center = (horizontal ? box.x : box.y) + length / 2;
    const before = group.filter((port) => port.coordinate < center - 8);
    const aligned = group.filter((port) => Math.abs(port.coordinate - center) <= 8);
    const after = group.filter((port) => port.coordinate > center + 8);
    const half = Math.max(0, (aligned.length - 1) / 2);
    const step = Math.min(24, (length / 2 - 16) / Math.max(1, before.length + half, after.length + half));
    group.forEach((port) => {
      const { edge, role } = port;
      // Keep an aligned handoff straight; other lines use separate side ports.
      const shift = group.length === 1 ? 0 : before.includes(port) ? -(before.length - before.indexOf(port) + half) * step
        : after.includes(port) ? (after.indexOf(port) + 1 + half) * step : (aligned.indexOf(port) - half) * step;
      const offset = length / 2 + shift;
      const point = horizontal ? { x: box.x + offset, y: side === 'top' ? box.y - 3 : box.y + box.height + 3 }
        : { x: side === 'left' ? box.x - 3 : box.x + box.width + 3, y: box.y + offset };
      ports.set(`${edge.id}:${role}`, { ...point, side });
    });
  }
  return ports;
}

function channels(boxes, axis, center, start, end) {
  const size = axis === 'x' ? 'width' : 'height';
  const bounds = [...new Set(boxes.flatMap((box) => [box[axis], box[axis] + box[size]]))].sort((a, b) => a - b);
  const candidates = new Set([center, start, end]);
  if (!bounds.length) return [...candidates];
  for (const bound of bounds) { candidates.add(bound - 20); candidates.add(bound + 20); }
  bounds.slice(1).forEach((bound, index) => {
    const previous = bounds[index]; const gap = bound - previous;
    if (gap < 24) return;
    const count = Math.min(7, Math.floor(gap / 24));
    for (let lane = 1; lane <= count; lane += 1) candidates.add(previous + gap * lane / (count + 1));
  });
  const outside = [bounds[0] - 28, bounds.at(-1) + 28];
  for (let lane = 1; lane <= 4; lane += 1) outside.push(bounds[0] - 28 - lane * 28, bounds.at(-1) + 28 + lane * 28);
  return [...new Set([...candidates].sort((a, b) => Math.abs(a - center) - Math.abs(b - center)).slice(0, 26).concat(outside))];
}

function textSize(text) {
  const lines = []; let line = ''; let width = 0;
  const characterWidth = (character) => /[^\u0000-\u00ff]|[MW]/.test(character) ? 11 : /[mw]/.test(character) ? 9 : 7;
  for (const character of Array.from(text)) {
    const next = characterWidth(character);
    if (width + next > 216 && line) { lines.push(line); line = ''; width = 0; }
    line += character; width += next;
  }
  if (line) lines.push(line);
  return { lines, width: Math.max(...lines.map((value) => Array.from(value).reduce((sum, character) => sum + characterWidth(character), 0))) + 16,
    height: lines.length * 15 + 6 };
}

// Uneven grids need independent exit and entry lanes. Keep the search bounded:
// ordinary handoffs use the short paths above, with this detour only as a fallback.
function freeLanePath(a, b, obstacles) {
  const gaps = (axis) => {
    const size = axis === 'x' ? 'width' : 'height';
    const bounds = [...new Set(obstacles.flatMap((box) => [box[axis], box[axis] + box[size]]))].sort((x, y) => x - y);
    return bounds.slice(1).flatMap((value, index) => value - bounds[index] >= 6 ? [(value + bounds[index]) / 2] : []);
  };
  const ys = gaps('y').concat(obstacles.flatMap((box) => [box.y - 3, box.y + box.height + 3]));
  const exits = (point) => {
    const values = [...new Set([point.y, ...ys])].filter((y) => !obstacles.some((box) => segmentHitsRect([point, { x: point.x, y }], box, 1))).sort((x, y) => x - y);
    const near = [...values].sort((x, y) => Math.abs(x - point.y) - Math.abs(y - point.y)).slice(0, 16);
    return [...new Set([...near, ...values.slice(0, 6), ...values.slice(-6)])];
  };
  const sourceYs = exits(a); const targetYs = exits(b);
  const outerXs = obstacles.filter((box) => box.height === box.headerHeight).flatMap((box) => [box.x - 3, box.x + box.width + 3]);
  const xs = [...new Set([...channels(obstacles, 'x', (a.x + b.x) / 2, a.x, b.x), ...outerXs])];
  let best; let bestLength = Infinity;
  const clear = (from, to) => !obstacles.some((box) => segmentHitsRect([from, to], box, 1));
  for (const y of sourceYs) {
    const from = { x: a.x, y }; if (!clear(a, from)) continue;
    for (const endY of targetYs) {
      const to = { x: b.x, y: endY }; if (!clear(to, b)) continue;
      for (const x of xs) {
        const first = { x, y }; const last = { x, y: endY };
        const length = distance(a, from) + distance(from, first) + distance(first, last) + distance(last, to) + distance(to, b);
        if (length >= bestLength || !clear(from, first) || !clear(first, last) || !clear(last, to)) continue;
        bestLength = length; best = [a, from, first, last, to, b];
      }
    }
  }
  return best || null;
}

const rectsOverlap = (a, b) => a.x < b.x + b.width + 6 && a.x + a.width + 6 > b.x && a.y < b.y + b.height + 6 && a.y + a.height + 6 > b.y;

function placeLabel(text, segments, obstacles, occupiedSegments, occupiedLabels) {
  if (!text) return { cost: 0, label: null };
  const size = textSize(text); const candidates = [];
  segments.forEach(([a, b], index) => {
    if (distance(a, b) < 12) return;
    for (const fraction of [.5, .3, .7]) {
      const x = a.x + (b.x - a.x) * fraction; const y = a.y + (b.y - a.y) * fraction;
      if (a.y === b.y) {
        candidates.push({ x, y, index, preference: Math.max(0, size.width + 12 - distance(a, b)) });
        for (const sign of [-1, 1]) candidates.push({ x, y: y + sign * (size.height / 2 + 8), index, preference: 60 });
      } else {
        for (const sign of [-1, 1]) candidates.push({ x: x + sign * (size.width / 2 + 10), y, index, preference: 40 });
      }
    }
  });
  let best;
  for (const candidate of candidates) {
    const rect = { x: candidate.x - size.width / 2, y: candidate.y - size.height / 2, width: size.width, height: size.height };
    const cost = candidate.preference + obstacles.filter((box) => rectsOverlap(rect, box)).length * 1000000
      + occupiedLabels.filter((box) => rectsOverlap(rect, box)).length * 1000000
      + occupiedSegments.filter((segment) => segmentHitsRect(segment, rect, 4)).length * 100000
      + segments.filter((segment, index) => index !== candidate.index && segmentHitsRect(segment, rect, 2)).length * 100000;
    if (!best || cost < best.cost) best = { cost, label: { ...size, x: candidate.x, y: candidate.y, rect } };
  }
  return best || { cost: 1000000, label: null };
}

/** Canvas geometry only: ports, free lanes, and label space never alter saved links. */
export function routeShapeEdges(nodes, edges) {
  const routed = edges.filter((edge) => edge.type === 'shapeConnection');
  if (!routed.length || !nodes.length) return edges;
  const cacheKey = JSON.stringify([nodes.map((node) => [node.id, node.parentId, node.position.x, node.position.y,
    node.measured?.width || node.style.width, node.measured?.height || node.style.height, node.data?.headerHeight, node.data?.collapsed]),
  routed.map((edge) => [edge.id, edge.source, edge.target, edge.sourceHandle, edge.targetHandle, edge.label])]);
  const cached = routeCache.get(cacheKey);
  if (cached) return edges.map((edge) => cached.has(edge.id) ? { ...edge, data: { ...edge.data, route: cached.get(edge.id) } } : edge);
  const boxes = boxesFor(nodes);
  const eligible = routed.filter((edge) => boxes.has(edge.source) && boxes.has(edge.target));
  const ports = assignPorts(eligible, boxes);
  const occupiedSegments = []; const occupiedLabels = []; const routes = new Map();
  // Reserve text first. Stable ordering avoids lanes flickering on a selection.
  const order = [...eligible].sort((a, b) => Number(Boolean(b.label)) - Number(Boolean(a.label))
    || Math.abs(boxes.get(b.source).x - boxes.get(b.target).x) - Math.abs(boxes.get(a.source).x - boxes.get(a.target).x)
    || a.id.localeCompare(b.id));
  for (const edge of order) {
    const source = ports.get(`${edge.id}:source`); const target = ports.get(`${edge.id}:target`);
    const from = boxes.get(edge.source); const to = boxes.get(edge.target);
    const withinSource = to.ancestors.has(edge.source); const withinTarget = from.ancestors.has(edge.target);
    const obstacles = [...boxes].flatMap(([id, box]) => {
      if (from.ancestors.has(id) || to.ancestors.has(id)) {
        // Connections may travel within a shared container, leaving its title
        // and controls readable above the children.
        return box.headerHeight && id !== edge.source && id !== edge.target ? [{ ...box, height: box.headerHeight }] : [];
      }
      return (!box.ancestors.has(edge.source) || withinSource) && (!box.ancestors.has(edge.target) || withinTarget) ? [box] : [];
    });
    const stub = from.ancestors.size || to.ancestors.size ? Math.min(7, Math.max(1, distance(source, target) / 3)) : 12;
    const extend = (point) => ({ x: point.x + NORMALS[point.side][0] * stub, y: point.y + NORMALS[point.side][1] * stub });
    const a = extend(source); const b = extend(target);
    const candidates = [[source, a, { x: b.x, y: a.y }, b, target], [source, a, { x: a.x, y: b.y }, b, target]];
    for (const y of channels(obstacles, 'y', (a.y + b.y) / 2, a.y, b.y)) candidates.push([source, a, { x: a.x, y }, { x: b.x, y }, b, target]);
    for (const x of channels(obstacles, 'x', (a.x + b.x) / 2, a.x, b.x)) candidates.push([source, a, { x, y: a.y }, { x, y: b.y }, b, target]);
    let best;
    for (const candidate of candidates) {
      const points = simplify(candidate); if (!points) continue;
      const segments = routeSegments(points);
      let cost = segments.reduce((sum, segment) => sum + distance(...segment)
        + obstacles.filter((box) => segmentHitsRect(segment, box, 1)).length * 10000000000
        + occupiedSegments.reduce((total, other) => total + segmentConflict(segment, other), 0)
        + occupiedLabels.filter((box) => segmentHitsRect(segment, box, 5)).length * 100000, 0) + segments.length * 12;
      if (best && cost >= best.cost) continue;
      const placement = placeLabel(edge.label, segments, obstacles, occupiedSegments, occupiedLabels);
      cost += placement.cost;
      if (!best || cost < best.cost) best = { points, label: placement.cost < 100000 ? placement.label : null, cost };
    }
    if (best?.cost >= 10000000000) {
      let free = freeLanePath(a, b, obstacles);
      if (!free) {
        const rotate = (point) => ({ x: point.y, y: point.x });
        const rotated = obstacles.map((box) => ({ ...box, x: box.y, y: box.x, width: box.height, height: box.width,
          headerHeight: box.height === box.headerHeight ? box.width : 0 }));
        free = freeLanePath(rotate(a), rotate(b), rotated)?.map(rotate);
      }
      const points = free && simplify([source, ...free, target], true);
      if (points && !routeSegments(points).some((segment) => obstacles.some((box) => segmentHitsRect(segment, box, 1)))) {
        const segments = routeSegments(points);
        const placement = placeLabel(edge.label, segments, obstacles, occupiedSegments, occupiedLabels);
        best = { points, label: placement.cost < 100000 ? placement.label : null };
      }
    }
    if (!best) continue;
    occupiedSegments.push(...routeSegments(best.points));
    if (best.label) occupiedLabels.push(best.label.rect);
    routes.set(edge.id, { points: best.points, label: best.label });
  }
  // Dense graphs can have no free space for every explanation. Keep the saved
  // label on its edge (and in the inspector) instead of covering another line.
  for (const [id, route] of routes) if (route.label && [...routes].some(([otherId, other]) => otherId !== id
    && routeSegments(other.points).some((segment) => segmentHitsRect(segment, route.label.rect, 2)))) {
    route.label = null; route.labelDeferred = true;
  }
  if (routeCache.size >= 4) routeCache.delete(routeCache.keys().next().value);
  routeCache.set(cacheKey, routes);
  return edges.map((edge) => routes.has(edge.id) ? { ...edge, data: { ...edge.data, route: routes.get(edge.id) } } : edge);
}

export function roundedShapePath(points, radius = 6) {
  let path = `M ${points[0].x},${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]; const point = points[index]; const next = points[index + 1];
    const bend = Math.min(radius, distance(previous, point) / 2, distance(point, next) / 2);
    const toward = (other) => ({ x: point.x + Math.sign(other.x - point.x) * bend, y: point.y + Math.sign(other.y - point.y) * bend });
    const entry = toward(previous); const exit = toward(next);
    path += ` L ${entry.x},${entry.y} Q ${point.x},${point.y} ${exit.x},${exit.y}`;
  }
  return `${path} L ${points.at(-1).x},${points.at(-1).y}`;
}

export function shapeCanvasBounds(nodes, edges) {
  const rects = [...boxesFor(nodes).values()];
  for (const edge of edges) if (edge.data?.route) {
    rects.push(...edge.data.route.points.map((point) => ({ ...point, width: 0, height: 0 })));
    if (edge.data.route.label) rects.push(edge.data.route.label.rect);
  }
  if (!rects.length) return null;
  const x = Math.min(...rects.map((rect) => rect.x)); const y = Math.min(...rects.map((rect) => rect.y));
  return { x, y, width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y };
}
