// @vitest-environment jsdom

import React, { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flow = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  getViewport: vi.fn(() => flow.viewport),
  setViewport: vi.fn((viewport) => { flow.viewport = viewport; }),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ getViewport: flow.getViewport, setViewport: flow.setViewport }),
}));

const { useCenteredZoom } = await import('../src/useCenteredZoom.js');

function Harness({ enabled = true }) {
  const canvasRef = useRef(null);
  const controls = useCenteredZoom({ canvasRef, minZoom: .2, maxZoom: 2, enabled });
  return React.createElement('div', {
    ref: canvasRef,
    'data-testid': 'canvas',
    onDoubleClick: controls.zoomIn,
  },
  React.createElement('div', { className: 'react-flow__renderer', 'data-testid': 'renderer' }),
  React.createElement('div', { 'data-testid': 'overlay' }));
}

describe('useCenteredZoom native gestures', () => {
  let host;
  let root;
  let frames;
  let nextFrame;

  beforeEach(async () => {
    flow.viewport = { x: -100, y: 50, zoom: 1 };
    flow.getViewport.mockClear();
    flow.setViewport.mockClear();
    frames = new Map();
    nextFrame = 1;
    window.requestAnimationFrame = vi.fn((callback) => {
      const id = nextFrame;
      nextFrame += 1;
      frames.set(id, callback);
      return id;
    });
    window.cancelAnimationFrame = vi.fn((id) => frames.delete(id));
    window.matchMedia = vi.fn(() => ({ matches: false }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(() => root.render(React.createElement(Harness)));
    host.firstElementChild.getBoundingClientRect = () => ({
      left: 280, top: 40, width: 800, height: 600, right: 1080, bottom: 640,
    });
  });

  afterEach(async () => {
    await act(() => root.unmount());
    host.remove();
  });

  function flushFrames() {
    const queued = [...frames.values()];
    frames.clear();
    queued.forEach((callback) => callback(performance.now()));
  }

  it('leaves an ordinary wheel alone and exclusively handles command wheel in one frame', () => {
    const canvas = host.firstElementChild;
    const downstream = vi.fn();
    canvas.addEventListener('wheel', downstream);

    const ordinary = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    canvas.dispatchEvent(ordinary);
    expect(ordinary.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(flow.setViewport).not.toHaveBeenCalled();

    const first = new WheelEvent('wheel', {
      deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true,
    });
    const second = new WheelEvent('wheel', {
      deltaY: -10, ctrlKey: true, bubbles: true, cancelable: true,
    });
    canvas.dispatchEvent(first);
    canvas.dispatchEvent(second);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(flow.setViewport).not.toHaveBeenCalled();

    act(flushFrames);
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(flow.getViewport).toHaveBeenCalledTimes(1);
    expect(flow.viewport.zoom).toBeGreaterThan(1);
    expect((400 - flow.viewport.x) / flow.viewport.zoom).toBeCloseTo(500);
    expect((300 - flow.viewport.y) / flow.viewport.zoom).toBeCloseTo(250);
  });

  it('preserves one-finger touch and consumes a two-finger pinch', () => {
    const canvas = host.firstElementChild;
    const downstream = vi.fn();
    canvas.addEventListener('touchstart', downstream);
    const touch = (x, y) => ({ clientX: x, clientY: y });
    const dispatchTouch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      canvas.dispatchEvent(event);
      return event;
    };

    const oneFinger = dispatchTouch('touchstart', [touch(10, 10)]);
    expect(oneFinger.defaultPrevented).toBe(false);
    expect(downstream).toHaveBeenCalledTimes(1);

    const twoFinger = dispatchTouch('touchstart', [touch(10, 10), touch(110, 10)]);
    expect(twoFinger.defaultPrevented).toBe(true);
    expect(downstream).toHaveBeenCalledTimes(1);
    const move = dispatchTouch('touchmove', [touch(0, 10), touch(120, 10)]);
    expect(move.defaultPrevented).toBe(true);
    act(flushFrames);
    expect(flow.viewport.zoom).toBeCloseTo(1.2);
  });

  it('does not leak a one-finger move after a pan transitions into pinch', () => {
    const canvas = host.firstElementChild;
    const observed = { start: 0, move: 0, end: 0, cancel: 0 };
    for (const type of Object.keys(observed)) {
      canvas.addEventListener(`touch${type}`, () => { observed[type] += 1; });
    }
    const touch = (identifier, x) => ({ identifier, clientX: x, clientY: 10 });
    const dispatchTouch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      canvas.dispatchEvent(event);
      return event;
    };

    expect(dispatchTouch('touchstart', [touch(1, 10)]).defaultPrevented).toBe(false);
    expect(observed.start).toBe(1);
    expect(dispatchTouch('touchstart', [touch(1, 10), touch(2, 110)]).defaultPrevented).toBe(true);
    expect(observed).toEqual({ start: 1, move: 0, end: 0, cancel: 1 });

    expect(dispatchTouch('touchend', [touch(2, 110)]).defaultPrevented).toBe(true);
    expect(dispatchTouch('touchmove', [touch(2, 120)]).defaultPrevented).toBe(true);
    expect(dispatchTouch('touchend', []).defaultPrevented).toBe(true);
    expect(observed).toEqual({ start: 1, move: 0, end: 0, cancel: 1 });

    expect(dispatchTouch('touchstart', [touch(3, 30)]).defaultPrevented).toBe(false);
    expect(dispatchTouch('touchmove', [touch(3, 40)]).defaultPrevented).toBe(false);
    expect(observed).toEqual({ start: 2, move: 1, end: 0, cancel: 1 });
  });

  it('clears pinch state on touchcancel before a new one-finger gesture', () => {
    const canvas = host.firstElementChild;
    const touch = (identifier, x) => ({ identifier, clientX: x, clientY: 10 });
    const dispatchTouch = (type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      canvas.dispatchEvent(event);
      return event;
    };

    expect(dispatchTouch('touchstart', [touch(1, 10), touch(2, 110)]).defaultPrevented).toBe(true);
    expect(dispatchTouch('touchcancel', []).defaultPrevented).toBe(true);
    expect(dispatchTouch('touchstart', [touch(3, 30)]).defaultPrevented).toBe(false);
    expect(dispatchTouch('touchmove', [touch(3, 40)]).defaultPrevented).toBe(false);
  });

  it('cancels the retained renderer gesture when the second finger lands on a sibling overlay', () => {
    const canvas = host.firstElementChild;
    const renderer = canvas.querySelector('[data-testid="renderer"]');
    const overlay = canvas.querySelector('[data-testid="overlay"]');
    const rendererCancel = vi.fn();
    const overlayCancel = vi.fn();
    renderer.addEventListener('touchcancel', rendererCancel);
    overlay.addEventListener('touchcancel', overlayCancel);
    const touch = (identifier, x) => ({ identifier, clientX: x, clientY: 10 });
    const dispatchTouch = (target, type, touches) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: touches });
      target.dispatchEvent(event);
      return event;
    };

    expect(dispatchTouch(renderer, 'touchstart', [touch(1, 10)]).defaultPrevented).toBe(false);
    expect(dispatchTouch(overlay, 'touchstart', [touch(1, 10), touch(2, 110)]).defaultPrevented).toBe(true);
    expect(rendererCancel).toHaveBeenCalledTimes(1);
    expect(overlayCancel).not.toHaveBeenCalled();
  });

  it('accepts a button event directly and disables animation for reduced motion', () => {
    window.matchMedia = vi.fn(() => ({ matches: true }));
    host.firstElementChild.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(flow.setViewport.mock.calls[0][1]).toEqual({ duration: 0 });
    expect(flow.viewport.zoom).toBe(1.2);
  });
});
