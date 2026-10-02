// Visible words for each flow map kind. The owner may rename them; keep them here only.
export const FLOW_VOCABULARY = {
  'user-flow': {
    kindLabel: '유저 플로우',
    lane: '참여자',
    lanes: '참여자',
    laneAdd: '참여자 추가',
    laneNew: '새 참여자',
    laneName: '참여자 이름',
    laneDelete: '참여자 지우기',
    laneFocus: '이 참여자만 보기',
    laneOnly: (title) => `${title}만 보기`,
    allLanes: '모든 참여자',
    shared: '함께 쓰는 단계',
    sharedHint: '여러 참여자가 함께 거치는 단계',
    lanePlaceholder: '누구인지, 무엇을 하는지',
  },
  'system-flow': {
    kindLabel: '시스템 플로우',
    lane: '영역',
    lanes: '영역',
    laneAdd: '영역 추가',
    laneNew: '새 영역',
    laneName: '영역 이름',
    laneDelete: '영역 지우기',
    laneFocus: '이 영역만 보기',
    laneOnly: (title) => `${title}만 보기`,
    allLanes: '모든 영역',
    shared: '공통 단계',
    sharedHint: '어느 영역에도 속하지 않은 단계',
    lanePlaceholder: '무엇을 맡는 곳인지',
  },
};

export const FLOW_KINDS = Object.keys(FLOW_VOCABULARY);

export function flowVocabulary(kind) {
  return FLOW_VOCABULARY[kind] || FLOW_VOCABULARY['user-flow'];
}

export const SHARED_BAND_ID = '__shared';
export const NEW_STEP_LABEL = '새 단계';

export const STEP_SHAPES = [
  { id: 'action', label: '행동', hint: '누가, 또는 시스템이 하는 일' },
  { id: 'decision', label: '갈림길', hint: '고르거나 판단하는 곳' },
  { id: 'milestone', label: '시작·끝', hint: '시작, 끝, 중요한 지점' },
];

export const ARROW_STYLES = [
  { id: 'next', label: '다음 단계', hint: '이어서 하는 일' },
  { id: 'alternative', label: '다른 길', hint: '고를 수 있는 길, 실패했을 때의 길, 되돌아가는 길' },
  { id: 'exchange', label: '주고받기', hint: '돈, 정보, 물건이 다른 쪽으로 건너가는 곳' },
];

export const TEXT_LIMITS = { step: 200, lane: 80, arrow: 120, summary: 4000, title: 80, description: 400, tag: 40 };

/**
 * Tag colors: a calm fill, a readable stroke, and a dark text color with at
 * least 7:1 contrast on its fill. A dashed tag marks something undecided.
 */
export const TAG_PALETTE = [
  { name: '모래', fill: '#FFF1DB', stroke: '#B86E00', textColor: '#5C3700' },
  { name: '라벤더', fill: '#F1EAFB', stroke: '#7C4DCC', textColor: '#3F2470' },
  { name: '청록', fill: '#E3F4F1', stroke: '#1F8A78', textColor: '#0F4A40' },
  { name: '하늘', fill: '#EEF3FF', stroke: '#3550C8', textColor: '#1A2A6B' },
  { name: '살구', fill: '#FDECE6', stroke: '#C2552F', textColor: '#6B2A12' },
  { name: '장미', fill: '#FBE9F0', stroke: '#B8457A', textColor: '#62193D' },
  { name: '올리브', fill: '#F0F3E2', stroke: '#6C7A1F', textColor: '#363E0B' },
  { name: '회색', fill: '#F2F2F4', stroke: '#5B5B66', textColor: '#28282C' },
];

export const DASHED_PATTERN = '4 3';
