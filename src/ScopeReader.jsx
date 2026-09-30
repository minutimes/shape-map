import { useState } from 'react';
import { ShapeIcon } from './ShapeNode.jsx';
import { compareTurnGraphs } from '../lib/shape.mjs';
import { areaReading } from './systemReading.js';

export function FeatureHistory({ records }) {
  return <div className="sm-feature-history">{records.length ? records.map(({ turn, facts }) => <article key={turn.id}>
    <header><span>지도 턴 {turn.number}</span><strong>{turn.title}</strong></header>
    {turn.summary && <p className="sm-history-reason">{turn.summary}</p>}
    {facts.map((fact) => <details key={fact.label}><summary>{fact.label}</summary><div className="sm-history-values">
      {fact.before !== undefined && <div><small>이전</small><p>{fact.before}</p></div>}<div><small>이후</small><p>{fact.after}</p></div>
    </div></details>)}
  </article>) : <p className="sm-tab-intro">이 기능을 비교할 이전 턴이 아직 없습니다. 첫 기록 이후부터 실제 차이를 보여줍니다.</p>}</div>;
}

export default function ScopeReader({ graph, focusId, turns, onFocus, onOpen, onRepository }) {
  const [tab, setTab] = useState('composition');
  const area = areaReading(graph, focusId);
  const latest = turns.at(-1); const previous = turns.at(-2);
  const difference = previous ? compareTurnGraphs(previous, latest) : null;
  const previousIds = previous?.nodes.some((node) => node.id === area.focus.id) ? areaReading(previous, area.focus.id).ids : new Set();
  const changed = difference ? [...difference.addedIds, ...difference.changedIds, ...difference.removedIds]
    .filter((id) => area.ids.has(id) || previousIds.has(id)) : [];
  const plans = area.parts.filter((node) => node.proposal);
  return <div className="sm-scope-reader">
    <div className="sm-reader-tabs" role="tablist" aria-label="구성과 개선 설명">{[['composition', '시스템 구성'], ['history', '지난 변경'], ['plans', `다음 개선 ${plans.length}`]].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} aria-controls={`sm-reader-${id}`} onClick={() => setTab(id)}>{label}</button>)}</div>
    <section id={`sm-reader-${tab}`} role="tabpanel">
      {tab === 'composition' && <>
        <p className="sm-reader-lead">{area.focus.block?.summary || area.focus.task?.logic || area.focus.label}</p>
        <div className="sm-reader-facts"><span>전체 {area.total}개 기능</span><span>이 영역 {area.count}개</span><span>내부 {area.depth}단계</span></div>
        <dl className="sm-io">{[['inputs', '어디에서 시작하나요?'], ['outputs', '어떤 결과를 받나요?'], ['ui', '사용자는 어떻게 참여하나요?']].map(([key, label]) => area.focus.task?.[key] && <div key={key}><dt>{label}</dt><dd>{area.focus.task[key]}</dd></div>)}</dl>
        <h3>이 안에는 무엇이 있나요?</h3><div className="sm-reader-parts">{area.children.map((child) => <article key={child.id}><button onClick={() => onFocus(child.id)}><strong>{child.label}</strong><ShapeIcon name="arrow" size={15} /></button><p>{child.block?.summary || child.task?.logic}</p><small>세부 기능 {areaReading(graph, child.id).count}개</small><button className="sm-text-button" onClick={() => onOpen(child.id)}>설명과 의견 보기</button></article>)}</div>
        <p className="sm-reader-note">큰 기능 안의 +로 내부를 펼치고, 안으로 들어가기를 누르면 그 영역을 크게 봅니다. 카드 클릭은 상세 정보입니다.</p>
      </>}
      {tab === 'history' && <>
        {latest && <div className="sm-reader-turn"><span>최근에 기록한 지도 턴 {latest.number}</span><h3>{latest.title}</h3><p>{latest.summary}</p></div>}
        <p className="sm-reader-note">지도 턴은 구성과 설명의 변화입니다. 실제 코드의 변경은 연결된 레포 기록에서 확인합니다.</p>
        <button className="sm-button" onClick={onRepository}><ShapeIcon name="code" size={15} />실제 코드 변경 보기</button>
        <div className="sm-reader-parts">{changed.map((id) => { const node = graph.nodes.find((item) => item.id === id) || previous.nodes.find((item) => item.id === id); return <article key={id}><button disabled={!graph.nodes.some((item) => item.id === id)} onClick={() => onOpen(id)}><strong>{node.label}</strong><ShapeIcon name="history" size={15} /></button><small>{difference.addedIds.includes(id) ? '새로 추가' : difference.removedIds.includes(id) ? '제거' : '설명·구성·연결 변경'}</small></article>; })}</div>
        {!previous && <p className="sm-tab-intro">현재는 첫 기록입니다. 다음 턴부터 이전 모습과 비교할 수 있습니다.</p>}
        {previous && !changed.length && <p className="sm-tab-intro">직전 지도 턴에서 이 영역은 바뀌지 않았습니다.</p>}
      </>}
      {tab === 'plans' && <>
        <p className="sm-reader-lead">아래 기능에 저장된 개선안입니다. 기능을 누르면 현재 동작과 바꿀 내용을 나란히 읽고 의견을 남길 수 있습니다.</p>
        <div className="sm-reader-plans">{plans.map((node) => <article key={node.id}><button onClick={() => onOpen(node.id)}><span className="sm-state sm-state--planned"><span className="sm-state__dot" />개선안</span><strong>{node.label}</strong><ShapeIcon name="arrow" size={14} /></button><h4>왜 바꾸나요?</h4><p>{node.proposal.reason || '카드에 저장한 동작을 개선합니다.'}</p>{node.proposal.logic && <><h4>어떻게 바뀌나요?</h4><p>{node.proposal.logic}</p></>}</article>)}</div>
        {!plans.length && <p className="sm-tab-intro">이 영역에는 저장된 개선안이 없습니다. 기능 카드의 다음 변경안에서 작성할 수 있습니다.</p>}
      </>}
    </section>
  </div>;
}
