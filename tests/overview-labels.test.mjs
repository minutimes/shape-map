import { describe, expect, it } from 'vitest';
import { layoutOverviewLabels, OVERVIEW_ZOOM } from '../src/overviewLabels.js';

const viewport = { x: 0, y: 0, zoom: 0.5 };
const bounds = { width: 800, height: 500 };
const node = (id, x, y, data = {}, size = {}) => ({
  id,
  position: { x, y },
  width: size.width ?? 360,
  height: size.height ?? 88,
  data: { label: id, depth: 0, parentId: null, childCount: 0, ...data },
});

function overlapsWithGap(left, right, gap = 6) {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

describe('overview label layout', () => {
  it('returns no overlay labels at normal reading zoom', () => {
    const nodes = [node('root', 40, 100)];
    expect(layoutOverviewLabels(nodes, { ...viewport, zoom: OVERVIEW_ZOOM }, bounds)).toEqual([]);
    expect(layoutOverviewLabels(nodes, { ...viewport, zoom: 1 }, bounds)).toEqual([]);
  });

  it('keeps only labels whose projected cards intersect the canvas', () => {
    const labels = layoutOverviewLabels([
      node('left-edge', -350, 100),
      node('right-edge', 1590, 100),
      node('off-left', -800, 100),
      node('off-bottom', 100, 1200),
    ], viewport, bounds);
    expect(labels.map(({ id }) => id).sort()).toEqual(['left-edge', 'right-edge']);
    labels.forEach((label) => {
      expect(label.x).toBeGreaterThanOrEqual(8);
      expect(label.y).toBeGreaterThanOrEqual(8);
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.width - 8);
      expect(label.y + label.height).toBeLessThanOrEqual(bounds.height - 8);
    });
  });

  it('produces deterministic fixed-height geometry and Korean-aware widths', () => {
    const nodes = [
      node('a', 80, 160, { label: '짧은 제목' }),
      node('b', 700, 300, { label: '아주 긴 한국어 가지 제목을 한눈에 읽을 수 있게 표시합니다' }),
    ];
    const first = layoutOverviewLabels(nodes, viewport, bounds);
    const second = layoutOverviewLabels(nodes.toReversed(), viewport, bounds);
    expect(second).toEqual(first);
    expect(first.find(({ id }) => id === 'a')).toMatchObject({ width: 140, height: 32 });
    expect(first.find(({ id }) => id === 'b')).toMatchObject({ width: 240, height: 32 });
  });

  it('omits colliding dense labels instead of detaching them from their cards', () => {
    const nodes = Array.from({ length: 10 }, (_, index) => node(
      `item-${String(index).padStart(2, '0')}`,
      240 + (index % 2) * 12,
      210 + (index % 3) * 8,
      { depth: 2 },
    ));
    const labels = layoutOverviewLabels(nodes, viewport, bounds);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(nodes.length);
    const byId = new Map(nodes.map((item) => [item.id, item]));
    labels.forEach((label) => {
      const card = byId.get(label.id);
      const cardTop = viewport.y + card.position.y * viewport.zoom;
      const cardBottom = cardTop + card.height * viewport.zoom;
      const attachedAbove = label.y + label.height + 8 === cardTop;
      const attachedBelow = label.y === cardBottom + 8;
      const pinnedToViewportEdge = label.y === 8 || label.y + label.height === bounds.height - 8;
      expect(attachedAbove || attachedBelow || pinnedToViewportEdge).toBe(true);
    });
    for (let left = 0; left < labels.length; left += 1) {
      for (let right = left + 1; right < labels.length; right += 1) {
        expect(overlapsWithGap(labels[left], labels[right])).toBe(false);
      }
    }
  });

  it('keeps selected and hovered cards ahead of branches when space is scarce', () => {
    const tightBounds = { width: 304, height: 120 };
    const nodes = [
      node('branch', 100, 100, { depth: 1, childCount: 9 }),
      node('hovered', 100, 100, { depth: 8 }),
      node('selected', 100, 100, { depth: 9 }),
    ];
    expect(layoutOverviewLabels(nodes, viewport, tightBounds, {
      selectedId: 'selected', hoveredId: 'hovered',
    }).map(({ id }) => id)).toEqual(['selected']);
  });

  it('treats measured UI rectangles as hard obstacles even for selected labels', () => {
    const selected = node('selected', 200, 160, { label: '선택한 카드' });
    const preferred = layoutOverviewLabels([selected], viewport, bounds, { selectedId: 'selected' })[0];
    const excludeRects = [{
      x: preferred.x - 1,
      y: preferred.y - 1,
      width: preferred.width + 2,
      height: preferred.height + 2,
    }];
    const before = structuredClone(excludeRects);
    const [moved] = layoutOverviewLabels([selected], viewport, bounds, { selectedId: 'selected', excludeRects });
    expect(moved).toBeDefined();
    expect(overlapsWithGap(moved, excludeRects[0], 0)).toBe(false);
    expect({ x: moved.x, y: moved.y }).not.toEqual({ x: preferred.x, y: preferred.y });
    expect(excludeRects).toEqual(before);
  });

  it('labels a deep panned region and still adds descendant leaves when room allows', () => {
    const nodes = [
      node('root-offscreen', -3000, -3000, { depth: 0, childCount: 1 }),
      node('deep-branch', 160, 260, { label: '현재 보이는 깊은 가지', depth: 8, parentId: 'root-offscreen', childCount: 2 }),
      node('deep-leaf-a', 560, 140, { label: '세부 A', depth: 9, parentId: 'deep-branch' }),
      node('deep-leaf-b', 560, 520, { label: '세부 B', depth: 9, parentId: 'deep-branch' }),
    ];
    const labels = layoutOverviewLabels(nodes, viewport, bounds);
    expect(labels.map(({ id }) => id)).toEqual(expect.arrayContaining(['deep-branch', 'deep-leaf-a', 'deep-leaf-b']));
    expect(labels.some(({ depth }) => depth === 0)).toBe(false);
  });

  it('pins clipped and canvas-spanning card titles to the readable top edge', () => {
    const nodes = [
      node('near-top', 40, 20, { label: '위쪽 카드' }),
      node('spanning', 800, -100, { label: '화면보다 긴 카드' }, { height: 1200 }),
    ];
    const labels = layoutOverviewLabels(nodes, viewport, bounds);
    expect(labels.find(({ id }) => id === 'near-top')).toMatchObject({ y: 8 });
    expect(labels.find(({ id }) => id === 'spanning')).toMatchObject({ y: 8 });
  });

  it('does not mutate node, viewport, bounds, or option inputs', () => {
    const nodes = [node('root', 40, 100, { label: '방향', path: ['방향'] })];
    const options = { selectedId: 'root', hoveredId: null };
    const before = structuredClone({ nodes, viewport, bounds, options });
    const labels = layoutOverviewLabels(nodes, viewport, bounds, options);
    expect({ nodes, viewport, bounds, options }).toEqual(before);
    expect(labels[0].path).toBe('방향');
  });

  it('builds readable breadcrumb paths from parents and normalizes supplied arrays', () => {
    const nodes = [
      node('root', -2000, -2000, { label: '전체 방향', childCount: 1 }),
      node('branch', 80, 160, { label: '준비', depth: 1, parentId: 'root', childCount: 1 }),
      node('leaf', 600, 500, { label: '촬영', depth: 2, parentId: 'branch', path: ['별도', '경로'] }),
    ];
    const labels = layoutOverviewLabels(nodes, viewport, bounds);
    expect(labels.find(({ id }) => id === 'branch').path).toBe('전체 방향 › 준비');
    expect(labels.find(({ id }) => id === 'leaf').path).toBe('별도 › 경로');
  });
});
