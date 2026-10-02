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

/** Kinds a person can create from the app, with one line on what each shows. */
export const CREATABLE_MAP_KINDS = Object.freeze(['features', 'user-flow', 'system-flow']);
export const MAP_KIND_HINTS = Object.freeze({
  features: '제품이 할 수 있는 일을 가지처럼 나눠요.',
  'user-flow': '사람마다 무엇을 어떤 순서로 하는지 그려요.',
  'system-flow': '시스템이 어떤 순서로 돌아가는지 그려요.',
});
export const MAP_TITLE_EXAMPLES = Object.freeze({
  features: '예: 동네 책장 기능',
  'user-flow': '예: 책 빌리기',
  'system-flow': '예: 대여 처리',
});
/** Same limits as the map header (docs/FORMAT.md "Project maps"), counted in characters. */
export const MAP_TEXT_LIMITS = Object.freeze({ title: 80, description: 400 });

export function textLength(value) {
  return [...String(value ?? '')].length;
}

/** A short Korean reason for a failed create or rename request. */
export function mapRequestReason(error) {
  const code = error?.body?.code;
  if (!error?.status) return 'Shape map에 연결하지 못했어요. 잠시 뒤에 다시 해 주세요.';
  if (code === 'project_not_found') return '이 프로젝트를 찾을 수 없어요. 폴더가 옮겨졌을 수 있어요.';
  if (code === 'map_not_found') return '이 지도 파일을 찾을 수 없어요. 옮겨지거나 지워졌을 수 있어요.';
  if (code === 'maps_folder_unavailable') return 'docs/maps 폴더를 만들 수 없어요. 같은 이름의 파일이나 다른 곳을 가리키는 바로가기가 있는지 확인해 주세요.';
  if (code === 'map_name_unavailable') return '새 파일 이름을 정하지 못했어요. docs/maps 폴더를 정리한 뒤 다시 해 주세요.';
  if (code === 'revision_conflict') return '그사이 지도가 바뀌었어요. 한 번 더 저장해 주세요.';
  if (code === 'read_only_map' || code === 'invalid_source') return '지금은 이 지도를 고칠 수 없어요. 파일의 틀린 줄을 먼저 고쳐 주세요.';
  if (code === 'validation_error') return '이름이나 설명을 다시 확인해 주세요. 줄바꿈 없이 한 줄로 적어야 해요.';
  return '요청을 마치지 못했어요. 잠시 뒤에 다시 해 주세요.';
}

/** What a lane is called in each flow kind. Change the words here only. */
export const MAP_LANE_WORDS = Object.freeze({
  'user-flow': Object.freeze({ noun: '참여자', place: '참여자 줄' }),
  'system-flow': Object.freeze({ noun: '영역', place: '영역' }),
});

export function laneWords(kind) {
  return MAP_LANE_WORDS[kind] || MAP_LANE_WORDS['user-flow'];
}

/** Picks the Korean particle that fits the last syllable of a word: 을/를, 이/가, 은/는. */
export function josa(word, withFinal, withoutFinal) {
  const code = String(word).trim().slice(-1).charCodeAt(0);
  if (code < 0xac00 || code > 0xd7a3) return withFinal;
  return (code - 0xac00) % 28 ? withFinal : withoutFinal;
}

// Server messages (English) mapped to short Korean reasons. Lane wording follows the map kind.
const LINE_REASONS = [
  [/Recorded turns cannot/, '기록한 턴은 원문에서 바꾸거나 지울 수 없어요.'],
  [/review and memo records cannot/, '메모와 검수 기록은 원문에서 새로 쓰거나 고칠 수 없어요.'],
  [/\b[Tt]urns? /, '턴 기록 줄의 형식이 맞지 않아요.'],
  [/feature link|features must|link at most/, '연결된 기능을 적은 형식이 맞지 않아요.'],
  [/proposal/, '수정안 줄의 형식이 맞지 않아요.'],
  [/[Bb]lock comment|comment ID|comments must|review needs|review field|invalid status|too many memos/, '메모나 검수 기록의 형식이 맞지 않아요.'],
  [/missing its legend/, '표시의 이름과 설명이 빠져 있어요.'],
  [/legend .* is missing its classDef/, '설명만 있고 표시는 없어요.'],
  [/need an arrowhead/, '연결선에 화살표가 없어요.'],
  [/comments are not supported/, '메모는 단계 설명으로 옮겨야 해요.'],
  [/lanes cannot be nested/, (w) => `${w.place} 안에 또 ${w.place}${josa(w.place, '을', '를')} 넣을 수 없어요.`],
  [/missing its end line/, (w) => `${w.place}${josa(w.place, '이', '가')} end 줄로 닫히지 않았어요.`],
  [/end without an open lane/, '짝이 없는 end 줄이 있어요.'],
  [/direction must be the first/, (w) => `${w.place}의 방향(direction)은 맨 앞에 적어야 해요.`],
  [/inside a lane|may appear inside a lane/, (w) => `${w.place} 안에 둘 수 없는 내용이 있어요.`],
  [/arrows join steps, not lanes/, (w) => `화살표가 단계가 아니라 ${w.noun}${josa(w.noun, '을', '를')} 가리키고 있어요.`],
  [/missing lane|Lane does not exist/, (w) => `없는 ${w.noun}${josa(w.noun, '을', '를')} 가리키고 있어요.`],
  [/not in the same lane/, (w) => `같은 ${w.noun}의 단계 옆에만 둘 수 있어요.`],
  [/lane has steps/, (w) => `단계가 있는 ${w.noun}${josa(w.noun, '은', '는')} 단계와 함께 지워야 해요.`],
  [/at most \d+ lanes/, (w) => `${w.noun}${josa(w.noun, '을', '를')} 더 넣을 수 없어요.`],
  [/at most \d+ (steps|arrows|tags)/, '지도에 넣을 수 있는 수를 넘었어요.'],
  [/already connected|duplicate arrow/, '같은 두 단계를 잇는 화살표가 이미 있어요.'],
  [/connect to itself|two different steps/, '단계가 자기 자신을 가리킬 수 없어요.'],
  [/undeclared|does not exist|missing parent/, '없는 단계를 가리키고 있어요.'],
  [/duplicate|already|twice/, '같은 이름이나 연결이 두 번 나와요.'],
  [/double quote/, '글에 큰따옴표(")가 들어 있어요.'],
  [/at most \d+ characters|exceeds/, '글이 너무 길어요.'],
  [/one line/, '글은 한 줄로 적어야 해요.'],
  [/cannot be empty|non-empty/, '비어 있으면 안 되는 글이 비어 있어요.'],
  [/keyword/, '쓸 수 없는 이름이 있어요.'],
  [/declare each step on its own line/, '단계를 연결선 안에서 바로 만들고 있어요.'],
  [/instead of &/, '연결선 하나에 여러 단계를 묶었어요.'],
  [/unsupported arrow/, '읽을 수 없는 화살표예요. -->, -.->, ==> 중 하나를 써 주세요.'],
  [/JSON-quoted/, '글을 큰따옴표로 바르게 감싸지 않았어요.'],
  [/descriptions support only summary|step blocks support|lane blocks support|description must be a JSON|duplicate description|needs a summary/, '단계 설명 줄의 형식이 맞지 않아요.'],
  [/invalid .*color|stroke width|cannot contain \| or a newline|undefined tag|Tag does not exist|classDef/, '표시를 정한 줄이 맞지 않아요.'],
  [/flowchart (LR|declaration)|one flowchart/, '첫 줄에 flowchart LR, TB, TD 중 하나가 있어야 해요.'],
  [/map header|map kind|Map title|Map description|sm-map/, '지도 종류를 적은 첫머리 줄이 맞지 않아요.'],
  [/unsupported statement/, '지도 형식에서 쓰지 않는 줄이에요.'],
  [/Mermaid/, '그림 문법에 맞지 않아요.'],
];

/**
 * A plain-Korean reason for one server message, with the original kept as detail.
 * `kind` picks the lane words (참여자 for user flows, 영역 for system flows).
 */
export function sourceProblemReason(error, kind) {
  const message = String(error ?? '');
  const found = LINE_REASONS.find(([pattern]) => pattern.test(message))?.[1];
  const reason = typeof found === 'function' ? found(laneWords(kind)) : found;
  return { reason: reason || null, detail: message.replace(/^Line \d+: /, '') || null };
}

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
  const { reason, detail } = sourceProblemReason(error, entry?.kind ?? entry?.graph?.map?.kind);
  if (line) return { text: `${line}번째 줄을 읽지 못했어요. ${reason || '지도 형식에 맞지 않는 내용이 있어요.'}`, line, reason, detail };
  return { text: reason ? `파일을 읽지 못했어요. ${reason}` : '파일 형식을 읽지 못해서 지금은 보기만 할 수 있어요.', line, reason, detail };
}
