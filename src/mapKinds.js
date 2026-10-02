/** Visible names and tab order of map kinds. Change the names here only. */
export const MAP_KIND_ORDER = Object.freeze(['features', 'user-flow', 'system-flow', 'other']);
export const MAP_KIND_LABELS = Object.freeze({
  features: '기능 계통도',
  'user-flow': '유저 플로우',
  'system-flow': '시스템 플로우',
  other: '기타 그림',
});
export const FLOW_MAP_KINDS = Object.freeze(['user-flow', 'system-flow']);

export function mapKindLabel(kind) {
  return MAP_KIND_LABELS[kind] || MAP_KIND_LABELS.other;
}

const LINE_REASONS = [
  [/missing its legend/, '표시의 이름과 설명이 빠져 있어요.'],
  [/legend .* is missing its classDef/, '설명만 있고 표시는 없어요.'],
  [/need an arrowhead/, '연결선에 화살표가 없어요.'],
  [/comments are not supported/, '메모는 단계 설명으로 옮겨야 해요.'],
  [/inside a lane|may appear inside a lane/, '참여자 줄 안에 둘 수 없는 내용이 있어요.'],
  [/undeclared|does not exist|missing (parent|lane)/, '없는 단계를 가리키고 있어요.'],
  [/duplicate|already|twice/, '같은 이름이나 연결이 두 번 나와요.'],
  [/double quote/, '글에 큰따옴표(")가 들어 있어요.'],
  [/at most \d+ characters|exceeds/, '글이 너무 길어요.'],
  [/keyword/, '쓸 수 없는 이름이 있어요.'],
  [/declare each step on its own line/, '단계를 연결선 안에서 바로 만들고 있어요.'],
  [/instead of &/, '연결선 하나에 여러 단계를 묶었어요.'],
  [/map header|map kind|Map title|Map description/, '지도 종류를 적은 첫머리 줄이 맞지 않아요.'],
  [/Mermaid/, '그림 문법에 맞지 않아요.'],
];

/**
 * A short, plain-Korean reason a map is shown without editing.
 * `entry` is a map list entry or a snapshot (`sourceStatus.error`, `line`).
 */
export function readOnlyReason(entry) {
  const error = entry?.error ?? entry?.sourceStatus?.error ?? '';
  const line = entry?.line ?? entry?.sourceStatus?.line;
  if (entry?.declaredKind) return { text: `이 버전에서는 아직 편집할 수 없는 지도 종류(${entry.declaredKind})예요.`, line };
  if (/no %% sm-map: header/.test(error)) return { text: '어떤 지도인지 적은 첫머리 줄이 없어서 보기만 할 수 있어요.', line };
  if (/diagrams without editing/.test(error)) return { text: 'Shape map이 편집하지 않는 그림 종류라 보기만 할 수 있어요.', line };
  if (/was removed/.test(error)) return { text: '지도 파일이 지워졌어요.', line };
  const reason = LINE_REASONS.find(([pattern]) => pattern.test(error))?.[1];
  if (line) return { text: `${line}번째 줄을 읽지 못했어요. ${reason || '지도 형식에 맞지 않는 내용이 있어요.'}`, line };
  return { text: reason ? `파일을 읽지 못했어요. ${reason}` : '파일 형식을 읽지 못해서 지금은 보기만 할 수 있어요.', line };
}
