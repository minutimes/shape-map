// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftField } from '../src/flow/FlowFields.jsx';
import { createDraftStore, draftKey, parseDraftKey } from '../src/flow/flowDrafts.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container; let root;
afterEach(() => { act(() => root?.unmount()); container?.remove(); root = null; });

function mount(element) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(element));
}
const field = () => container.querySelector('input');
function type(text) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  act(() => { setter.call(field(), text); field().dispatchEvent(new Event('input', { bubbles: true })); });
}
async function blur() {
  await act(async () => { field().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); await Promise.resolve(); });
}

describe('flow map drafts', () => {
  it('keeps one draft per element and field until it is saved or discarded', () => {
    const store = createDraftStore();
    const label = draftKey('step', 'a', 'label');
    store.set(label, { value: '쓰던 글' });
    store.set(draftKey('step', 'b', 'label'), { value: '다른 글' });
    store.set(label, { status: 'failed', message: '저장하지 못했어요.' });
    expect(store.get(label)).toEqual({ value: '쓰던 글', status: 'failed', message: '저장하지 못했어요.' });
    expect(store.failed().map(([key]) => key)).toEqual([label]);
    store.clear(label);
    expect(store.get(label)).toBeNull();
    expect(store.entries()).toHaveLength(1);
    expect(parseDraftKey(draftKey('arrow', 'a->b', 'label'))).toEqual({ kind: 'arrow', id: 'a->b', field: 'label' });
  });

  it('does not lose text that failed to save when another element is selected', async () => {
    const store = createDraftStore();
    const key = draftKey('step', 'reader_search', 'label');
    const fail = async () => ({ ok: false, message: '다른 곳에서 지도가 바뀌었어요.' });
    mount(<DraftField key="reader_search" label="이름" value="책 찾기" store={store} draftKey={key} onCommit={fail} />);
    type('내가 고친 제목');
    await blur();
    expect(container.textContent).toContain('다른 곳에서 지도가 바뀌었어요.');

    // Another element is selected: its field replaces this one.
    act(() => root.render(<DraftField key="owner_check" label="이름" value="요청 확인" store={store} draftKey={draftKey('step', 'owner_check', 'label')} onCommit={fail} />));
    expect(field().value).toBe('요청 확인');
    expect(store.get(key)).toMatchObject({ value: '내가 고친 제목', status: 'failed' });

    // Coming back shows the kept text with its retry; a successful retry clears it.
    let saved = null;
    const succeed = async (text) => { saved = text; return { ok: true }; };
    act(() => root.render(<DraftField key="reader_search" label="이름" value="책 찾기" store={store} draftKey={key} onCommit={succeed} />));
    expect(field().value).toBe('내가 고친 제목');
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === '다시 저장');
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect(saved).toBe('내가 고친 제목');
    expect(store.get(key)).toBeNull();
  });

  it('discards a kept draft only when the person asks for the saved text', async () => {
    const store = createDraftStore();
    const key = draftKey('lane', 'catalog', 'title');
    mount(<DraftField label="이름" value="도서 정보 제공처" store={store} draftKey={key} onCommit={async () => ({ ok: false, message: '실패' })} />);
    type('정보 회사');
    await blur();
    act(() => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(store.get(key)?.value).toBe('정보 회사');
    const discard = [...container.querySelectorAll('button')].find((button) => button.textContent === '새 내용 쓰기');
    act(() => discard.click());
    expect(store.get(key)).toBeNull();
    expect(field().value).toBe('도서 정보 제공처');
  });
});
