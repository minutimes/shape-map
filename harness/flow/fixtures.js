// Harness fixtures: the synthetic sample project maps plus generated stress maps.
import lending from '../../examples/sample-project/docs/maps/02-lending.mmd?raw';
import lendingSystem from '../../examples/sample-project/docs/maps/03-lending-system.mmd?raw';

/** A deterministic user flow with many lanes, branches, handoffs, and returns. */
export function generatedFlow({ lanes = 12, steps = 200, kind = 'user-flow' } = {}) {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const laneIds = Array.from({ length: lanes }, (_, index) => `lane${index + 1}`);
  const perLane = laneIds.map(() => []);
  for (let index = 0; index < steps; index += 1) perLane[index % lanes].push(`s${index + 1}`);
  const lines = ['flowchart LR', `  %% sm-map: {"kind":"${kind}","title":"큰 지도 ${steps}단계","description":"성능과 배치를 확인하는 만든 지도"}`];
  const shapes = (id, index) => (index === 0 ? `${id}(["시작 ${id}"])` : random() < .18 ? `${id}{"판단 ${id}?"}` : `${id}["${id} 단계에서 하는 일"]`);
  laneIds.forEach((lane, index) => {
    lines.push(`  subgraph ${lane}["참여자 ${index + 1}"]`);
    perLane[index].forEach((id, position) => lines.push(`    ${shapes(id, position)}`));
    lines.push('  end');
  });
  lines.push('');
  const pairs = new Set();
  const add = (a, b, arrow, label) => { if (a === b || pairs.has(`${a}->${b}`)) return; pairs.add(`${a}->${b}`); lines.push(`  ${a} ${arrow}${label ? `|"${label}"|` : ''} ${b}`); };
  perLane.forEach((list) => list.forEach((id, position) => { if (position) add(list[position - 1], id, '-->'); }));
  for (let index = 0; index < steps / 3; index += 1) {
    const a = perLane[Math.floor(random() * lanes)]; const b = perLane[Math.floor(random() * lanes)];
    const i = Math.floor(random() * a.length); const j = Math.min(b.length - 1, i + 1 + Math.floor(random() * 2));
    add(a[i], b[j], '==>', random() < .5 ? '건네기' : '');
  }
  for (let index = 0; index < steps / 20; index += 1) {
    const list = perLane[Math.floor(random() * lanes)];
    const i = 2 + Math.floor(random() * (list.length - 2));
    add(list[i], list[i - 2], '-.->', '다시');
  }
  return `${lines.join('\n')}\n`;
}

export const EMPTY_FLOW = 'flowchart LR\n  %% sm-map: {"kind":"user-flow","title":"새 유저 플로우"}\n';

export const FIXTURES = {
  lending: { source: lending, map: { project: 'sample-project', file: '02-lending.mmd', kind: 'user-flow', editable: true } },
  system: { source: lendingSystem, map: { project: 'sample-project', file: '03-lending-system.mmd', kind: 'system-flow', editable: true } },
  large: { source: generatedFlow(), map: { project: 'generated', file: 'large.mmd', kind: 'user-flow', editable: true } },
  empty: { source: EMPTY_FLOW, map: { project: 'generated', file: 'empty.mmd', kind: 'user-flow', editable: true } },
  readonly: { source: lending, map: { project: 'sample-project', file: '02-lending.mmd', kind: 'user-flow', editable: false }, options: { editable: false } },
};
