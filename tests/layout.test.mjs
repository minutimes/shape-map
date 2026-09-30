import { describe, expect, it } from 'vitest';
import {
  allBranchVisibilityPositions,
  branchVisibilityPositions,
  centeredRankRepairPositions,
  NODE_HEIGHT,
  NODE_WIDTH,
  mergeSnapshotPositions,
  overlappingNodePairs,
  reflowSiblingBranches,
  reparentBranchPositions,
  reparentBranchesPositions,
  resizeReflowPositions,
  resolveNodeLayout,
  visibleLayoutPositions,
} from '../src/layout.js';

function fiftyNodeFixture() {
  const nodes = [{ id: 'root', label: '방향', parentId: null }];
  const branches = Array.from({ length: 8 }, (_, index) => `branch_${index + 1}`);
  branches.forEach((id) => nodes.push({ id, label: id, parentId: 'root' }));
  let childNumber = 0;
  branches.forEach((parentId, branchIndex) => {
    const count = branchIndex === 0 ? 6 : 5;
    for (let index = 0; index < count; index += 1) {
      childNumber += 1;
      nodes.push({ id: `child_${childNumber}`, label: `child ${childNumber}`, parentId });
    }
  });
  return { nodes, branches };
}

function overlapPairs(positions) {
  const entries = Object.entries(positions);
  const pairs = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftId, a] = entries[left];
      const [rightId, b] = entries[right];
      if (
        a.x < b.x + NODE_WIDTH
        && a.x + NODE_WIDTH > b.x
        && a.y < b.y + NODE_HEIGHT
        && a.y + NODE_HEIGHT > b.y
      ) pairs.push([leftId, rightId]);
    }
  }
  return pairs;
}

describe('visible branch layout', () => {
  it('lays out only root and eight folded branches on an empty first view', () => {
    const { nodes, branches } = fiftyNodeFixture();
    const incoming = {
      graph: { nodes, direction: 'LR' },
      view: { positions: {}, collapsedIds: branches },
    };
    const positions = mergeSnapshotPositions(incoming, {}, false);
    const visible = Object.fromEntries(['root', ...branches].map((id) => [id, positions[id]]));
    const yValues = Object.values(visible).map((position) => position.y);

    expect(nodes).toHaveLength(50);
    expect(Object.keys(positions)).toHaveLength(50);
    expect(overlapPairs(visible)).toEqual([]);
    expect(Math.max(...yValues) - Math.min(...yValues)).toBeLessThan(850);
  });

  it('preserves saved positions until the user explicitly arranges visible nodes', () => {
    const { nodes, branches } = fiftyNodeFixture();
    const saved = { root: { x: 901, y: 777 }, branch_1: { x: 1204, y: 802 } };
    const incoming = {
      graph: { nodes, direction: 'LR' },
      view: { positions: saved, collapsedIds: branches },
    };
    const positions = mergeSnapshotPositions(incoming, {}, false);

    expect(positions.root).toEqual(saved.root);
    expect(positions.branch_1).toEqual(saved.branch_1);
  });

  it('produces a non-overlapping visible layout after one branch expands', () => {
    const { nodes, branches } = fiftyNodeFixture();
    const collapsedIds = branches.slice(1);
    const positions = visibleLayoutPositions(nodes, collapsedIds, 'LR');

    expect(Object.keys(positions)).toHaveLength(15);
    expect(overlapPairs(positions)).toEqual([]);
  });

  it('uses long-label and fixed card dimensions when detecting and repairing overlap', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null, layout: { mode: 'fit' } },
      { id: 'long', label: '아주 긴 제목을 모두 보여 주면서 너비와 높이를 자동으로 계산하는 카드', parentId: 'root', layout: { mode: 'wrap', width: 240 } },
      { id: 'fixed', label: '크기 우선', parentId: 'root', layout: { mode: 'fixed', width: 360, height: 160 } },
    ];
    expect(resolveNodeLayout(nodes[1])).toMatchObject({ mode: 'wrap', width: 240 });
    expect(overlappingNodePairs(nodes, {
      root: { x: 0, y: 0 }, long: { x: 300, y: 0 }, fixed: { x: 400, y: 30 },
    })).toEqual([['long', 'fixed']]);

    const arranged = visibleLayoutPositions(nodes, [], 'LR');
    expect(overlappingNodePairs(nodes, arranged)).toEqual([]);
  });

  it('aligns different-width cards by the leading edge and reserves the widest rank', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '넓은 카드', parentId: 'root', layout: { mode: 'fixed', width: 720, height: 88 } },
      { id: 'b', label: '보통 카드', parentId: 'root' },
      { id: 'a1', label: '세부 A', parentId: 'a' },
      { id: 'b1', label: '세부 B', parentId: 'b' },
    ];
    const positions = visibleLayoutPositions(nodes, [], 'LR');

    expect(positions.a.x).toBe(positions.b.x);
    expect(positions.a1.x).toBe(positions.b1.x);
    expect(positions.a1.x).toBeGreaterThanOrEqual(positions.a.x + 720 + 88);
    expect(overlappingNodePairs(nodes, positions)).toEqual([]);
  });

  it('reflows a resize continuously while keeping the selected leading edge fixed', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '첫 번째', parentId: 'root' },
      { id: 'a1', label: '첫 번째 세부', parentId: 'a' },
      { id: 'b', label: '두 번째', parentId: 'root' },
      { id: 'b1', label: '두 번째 세부', parentId: 'b' },
    ];
    const basePositions = {
      root: { x: 40, y: 180 },
      a: { x: 336, y: 100 },
      a1: { x: 632, y: 100 },
      b: { x: 336, y: 240 },
      b1: { x: 632, y: 240 },
    };
    const nextLayout = { mode: 'fixed', width: 400, height: 160 };
    const preview = resizeReflowPositions(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: [] } },
      basePositions,
      'a',
      nextLayout,
      basePositions.a,
    );

    expect(preview.positions.a).toEqual(basePositions.a);
    expect(preview.positions.b.x).toBe(basePositions.b.x);
    expect(preview.positions.a1.x - basePositions.a1.x).toBe(192);
    expect(preview.positions.b1.x - basePositions.b1.x).toBe(192);
    expect(preview.positions.b.y).toBe(312);
    expect(preview.positions.b1.y - basePositions.b1.y).toBe(72);
    expect(overlappingNodePairs(nodes, preview.positions, [], { a: nextLayout })).toEqual([]);
  });

  it('repairs only the primary axis of legacy center-aligned ranks', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '보통 카드', parentId: 'root' },
      { id: 'b', label: '넓은 카드', parentId: 'root', layout: { mode: 'fixed', width: 360, height: 88 } },
      { id: 'c', label: '가장 넓은 카드', parentId: 'root', layout: { mode: 'fixed', width: 720, height: 88 } },
      { id: 'child', label: '세부', parentId: 'a' },
    ];
    const positions = {
      root: { x: 99, y: 400 },
      a: { x: 947, y: 100 },
      b: { x: 871, y: 220 },
      c: { x: 691, y: 340 },
      child: { x: 1499, y: 100 },
    };
    const patch = centeredRankRepairPositions(nodes, positions, [], 'LR');

    expect(patch.a).toBeUndefined();
    expect(patch.b).toEqual({ x: 947, y: 220 });
    expect(patch.c).toEqual({ x: 947, y: 340 });
    expect(patch.child).toEqual({ x: 1755, y: 100 });
  });

  it('keeps a dragged subtree fixed while packing neighboring sibling branches away', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'above', label: '윗 가지', parentId: 'root' },
      { id: 'moved', label: '움직인 가지', parentId: 'root', layout: { mode: 'fixed', width: 360, height: 120 } },
      { id: 'child', label: '하위', parentId: 'moved' },
      { id: 'below', label: '아랫 가지', parentId: 'root' },
    ];
    const projected = {
      root: { x: 24, y: 500 },
      above: { x: 320, y: 900 },
      moved: { x: 385, y: 974 },
      child: { x: 833, y: 950 },
      below: { x: 320, y: 1040 },
    };
    const preview = reflowSiblingBranches(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: [] } },
      projected,
      'moved',
    );

    expect(preview.positions.moved).toEqual(projected.moved);
    expect(preview.positions.child).toEqual(projected.child);
    expect(preview.positions.above.y).toBeLessThan(projected.above.y);
    expect(preview.positions.below.y).toBeGreaterThan(projected.below.y);
    expect(overlappingNodePairs(nodes, preview.positions)).toEqual([]);
  });

  it('pushes every lower sibling branch down when a folded branch opens, then reclaims the gap', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '펼칠 가지', parentId: 'root' },
      { id: 'a1', label: '첫 하위', parentId: 'a' },
      { id: 'a2', label: '둘째 하위', parentId: 'a' },
      { id: 'b', label: '다음 가지', parentId: 'root' },
      { id: 'b1', label: '접힌 하위', parentId: 'b' },
      { id: 'c', label: '마지막 가지', parentId: 'root' },
    ];
    const positions = {
      root: { x: 24, y: 100 },
      a: { x: 320, y: 100 },
      a1: { x: 616, y: 40 },
      a2: { x: 616, y: 150 },
      b: { x: 320, y: 210 },
      b1: { x: 616, y: 210 },
      c: { x: 320, y: 320 },
    };
    const snapshot = {
      graph: { nodes, direction: 'LR' },
      view: { collapsedIds: ['a', 'b'] },
    };
    const expanded = branchVisibilityPositions(snapshot, positions, 'a', ['b']);

    expect(expanded.positions.a).toEqual(positions.a);
    expect(expanded.positions.a1).toEqual(positions.a1);
    expect(expanded.positions.a2).toEqual(positions.a2);
    expect(expanded.positions.b.y).toBeGreaterThan(positions.b.y);
    expect(expanded.positions.b1.y - positions.b1.y).toBe(
      expanded.positions.b.y - positions.b.y,
    );
    expect(expanded.positions.c.y).toBeGreaterThan(positions.c.y);
    expect(overlappingNodePairs(nodes, expanded.positions, ['b'])).toEqual([]);

    const collapsed = branchVisibilityPositions(
      { ...snapshot, view: { collapsedIds: ['b'] } },
      expanded.positions,
      'a',
      ['a', 'b'],
      { compact: true },
    );
    expect(collapsed.positions.a).toEqual(positions.a);
    expect(collapsed.positions.b.y).toBeLessThan(expanded.positions.b.y);
    expect(collapsed.positions.c.y).toBeLessThan(expanded.positions.c.y);
    expect(overlappingNodePairs(nodes, collapsed.positions, ['a', 'b'])).toEqual([]);
  });

  it('keeps a still-folded nested subtree attached while repairing newly revealed siblings', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '펼칠 가지', parentId: 'root' },
      { id: 'a1', label: '접힌 중간 가지', parentId: 'a' },
      { id: 'a1x', label: '아직 숨은 하위', parentId: 'a1' },
      { id: 'a2', label: '겹친 형제', parentId: 'a' },
      { id: 'b', label: '다음 큰 가지', parentId: 'root' },
    ];
    const positions = {
      root: { x: 24, y: 100 },
      a: { x: 320, y: 100 },
      a1: { x: 616, y: 90 },
      a1x: { x: 912, y: 105 },
      a2: { x: 616, y: 90 },
      b: { x: 320, y: 220 },
    };
    const preview = branchVisibilityPositions(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: ['a', 'a1'] } },
      positions,
      'a',
      ['a1'],
    );
    const middleDelta = preview.positions.a1.y - positions.a1.y;

    expect(preview.positions.a1x.y - positions.a1x.y).toBe(middleDelta);
    expect(overlappingNodePairs(nodes, preview.positions, ['a1'])).toEqual([]);
  });

  it('reconnects a folded branch whose saved descendants are stranded far apart', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '펼칠 가지', parentId: 'root' },
      { id: 'a1', label: '첫 하위', parentId: 'a' },
      { id: 'a2', label: '둘째 하위', parentId: 'a' },
      { id: 'b', label: '다음 큰 가지', parentId: 'root' },
    ];
    const positions = {
      root: { x: 24, y: 100 },
      a: { x: 320, y: 100 },
      a1: { x: 616, y: 820 },
      a2: { x: 616, y: 1280 },
      b: { x: 320, y: 1420 },
    };
    const preview = branchVisibilityPositions(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: ['a'] } },
      positions,
      'a',
      [],
    );
    const branchBottom = Math.max(
      preview.positions.a.y + NODE_HEIGHT,
      preview.positions.a1.y + NODE_HEIGHT,
      preview.positions.a2.y + NODE_HEIGHT,
    );
    const branchTop = Math.min(
      preview.positions.a.y,
      preview.positions.a1.y,
      preview.positions.a2.y,
    );

    expect(preview.positions.a).toEqual(positions.a);
    expect(branchBottom - branchTop).toBeLessThan(360);
    expect(preview.positions.b.y).toBeLessThan(positions.b.y);
    expect(preview.positions.b.y).toBeGreaterThanOrEqual(branchBottom + 24);
    expect(overlappingNodePairs(nodes, preview.positions)).toEqual([]);
  });

  it('keeps hidden descendants attached to their visible branch during a global collapse', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'a', label: '첫 가지', parentId: 'root' },
      { id: 'a1', label: '숨겨질 하위', parentId: 'a' },
      { id: 'a2', label: '숨겨질 하위 2', parentId: 'a' },
      { id: 'b', label: '둘째 가지', parentId: 'root' },
    ];
    const positions = {
      root: { x: 40, y: 220 },
      a: { x: 410, y: 310 },
      a1: { x: 706, y: 275 },
      a2: { x: 706, y: 385 },
      b: { x: 410, y: 520 },
    };
    const snapshot = { graph: { nodes, direction: 'LR' }, view: { collapsedIds: [] } };
    const collapsed = allBranchVisibilityPositions(snapshot, positions, ['a']);

    expect(collapsed.a1.x - collapsed.a.x).toBe(positions.a1.x - positions.a.x);
    expect(collapsed.a1.y - collapsed.a.y).toBe(positions.a1.y - positions.a.y);
    expect(collapsed.a2.x - collapsed.a.x).toBe(positions.a2.x - positions.a.x);
    expect(collapsed.a2.y - collapsed.a.y).toBe(positions.a2.y - positions.a.y);
    expect(overlappingNodePairs(nodes, collapsed, ['a'])).toEqual([]);

    const expanded = allBranchVisibilityPositions(
      { ...snapshot, view: { collapsedIds: ['a'] } },
      collapsed,
      [],
    );
    expect(overlappingNodePairs(nodes, expanded, [])).toEqual([]);
  });

  it('moves a reparented subtree onto the new rank and keeps its internal offsets', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'left', label: '왼쪽 가지', parentId: 'root' },
      { id: 'right', label: '오른쪽 가지', parentId: 'root' },
      { id: 'moved', label: '옮긴 가지', parentId: 'left' },
      { id: 'child', label: '옮긴 하위', parentId: 'moved' },
      { id: 'peer', label: '기존 하위', parentId: 'left' },
    ];
    const positions = {
      root: { x: 24, y: 200 },
      left: { x: 320, y: 100 },
      right: { x: 320, y: 360 },
      moved: { x: 912, y: 360 },
      child: { x: 1208, y: 430 },
      peer: { x: 616, y: 100 },
    };
    const childOffset = {
      x: positions.child.x - positions.moved.x,
      y: positions.child.y - positions.moved.y,
    };
    const preview = reparentBranchPositions(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: [] } },
      positions,
      'moved',
    );

    expect(preview.positions.moved.x).toBe(616);
    expect(preview.positions.child.x - preview.positions.moved.x).toBe(childOffset.x);
    expect(preview.positions.child.y - preview.positions.moved.y).toBe(childOffset.y);
    expect(overlappingNodePairs(nodes, preview.positions)).toEqual([]);
  });

  it('places multiple reparented branches together without covering their new siblings', () => {
    const nodes = [
      { id: 'root', label: '방향', parentId: null },
      { id: 'left', label: '왼쪽 가지', parentId: 'root' },
      { id: 'right', label: '오른쪽 가지', parentId: 'root' },
      { id: 'a', label: '옮긴 가지 A', parentId: 'right' },
      { id: 'a1', label: 'A 하위', parentId: 'a' },
      { id: 'b', label: '옮긴 가지 B', parentId: 'right' },
      { id: 'peer', label: '기존 하위', parentId: 'right' },
    ];
    const positions = {
      root: { x: 24, y: 240 },
      left: { x: 320, y: 80 },
      right: { x: 320, y: 380 },
      a: { x: 616, y: 70 },
      a1: { x: 912, y: 90 },
      b: { x: 616, y: 180 },
      peer: { x: 616, y: 380 },
    };
    const childOffset = {
      x: positions.a1.x - positions.a.x,
      y: positions.a1.y - positions.a.y,
    };
    const preview = reparentBranchesPositions(
      { graph: { nodes, direction: 'LR' }, view: { collapsedIds: [] } },
      positions,
      ['a', 'b'],
    );

    expect(preview.positions.a.x).toBe(preview.positions.b.x);
    expect(preview.positions.a1.x - preview.positions.a.x).toBe(childOffset.x);
    expect(preview.positions.a1.y - preview.positions.a.y).toBe(childOffset.y);
    expect(overlappingNodePairs(nodes, preview.positions)).toEqual([]);
  });
});
