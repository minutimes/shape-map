import { useCallback, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { wheelZoomFactor, zoomViewportAtCenter } from './viewport.js';

const BUTTON_FACTOR = 1.2;

function reducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function viewportOptions(value) {
  return value && typeof value === 'object' && typeof value.preventDefault !== 'function'
    ? value
    : {};
}

export function useCenteredZoom({ canvasRef, minZoom = .08, maxZoom = 2, enabled = true }) {
  const { getViewport, setViewport } = useReactFlow();

  const zoomTo = useCallback((nextZoom, options = {}) => {
    const canvas = canvasRef.current;
    if (!enabled || !canvas) return undefined;
    const safeOptions = viewportOptions(options);
    const viewport = getViewport();
    const next = zoomViewportAtCenter(
      viewport,
      typeof nextZoom === 'function' ? nextZoom(viewport.zoom) : nextZoom,
      canvas.getBoundingClientRect(),
      { minZoom, maxZoom },
    );
    const duration = reducedMotion() ? 0 : (safeOptions.duration ?? 140);
    return setViewport(next, { ...safeOptions, duration });
  }, [canvasRef, enabled, getViewport, maxZoom, minZoom, setViewport]);

  const zoomIn = useCallback((options) => zoomTo(
    (zoom) => zoom * BUTTON_FACTOR,
    options,
  ), [zoomTo]);

  const zoomOut = useCallback((options) => zoomTo(
    (zoom) => zoom / BUTTON_FACTOR,
    options,
  ), [zoomTo]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;

    let canvas;
    let bindFrame;
    let zoomFrame;
    let pendingFactor = 1;
    let pinchDistance = null;
    let pinchActive = false;
    let singleTouchTarget = null;
    let releasingUnderlyingTouch = false;
    let disposed = false;

    const requestFrame = window.requestAnimationFrame?.bind(window)
      ?? ((callback) => window.setTimeout(callback, 16));
    const cancelFrame = window.cancelAnimationFrame?.bind(window)
      ?? window.clearTimeout.bind(window);

    const flushZoom = () => {
      zoomFrame = undefined;
      const factor = pendingFactor;
      pendingFactor = 1;
      const element = canvasRef.current;
      if (!element || factor === 1) return;
      const viewport = getViewport();
      setViewport(zoomViewportAtCenter(
        viewport,
        viewport.zoom * factor,
        element.getBoundingClientRect(),
        { minZoom, maxZoom },
      ), { duration: 0 });
    };

    const queueZoom = (factor) => {
      if (!Number.isFinite(factor) || factor <= 0 || factor === 1) return;
      pendingFactor = Math.min(Math.exp(2), Math.max(Math.exp(-2), pendingFactor * factor));
      if (zoomFrame === undefined) zoomFrame = requestFrame(flushZoom);
    };

    const consume = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    const onWheel = (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      consume(event);
      queueZoom(wheelZoomFactor(event));
    };

    const touchDistance = (touches) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    const cancelUnderlyingTouch = (event) => {
      const retainedTarget = singleTouchTarget?.isConnected === false ? null : singleTouchTarget;
      const target = retainedTarget
        ?? canvas?.querySelector('.react-flow__renderer')
        ?? event.target;
      if (!(target instanceof EventTarget)) return;
      let cancelEvent;
      const init = {
        bubbles: true,
        cancelable: false,
        touches: [],
        targetTouches: [],
        changedTouches: Array.from(event.touches),
      };
      try {
        cancelEvent = new TouchEvent('touchcancel', init);
      } catch {
        cancelEvent = new Event('touchcancel', { bubbles: true, cancelable: false });
        Object.defineProperties(cancelEvent, {
          touches: { value: init.touches },
          targetTouches: { value: init.targetTouches },
          changedTouches: { value: init.changedTouches },
        });
      }
      releasingUnderlyingTouch = true;
      try {
        target.dispatchEvent(cancelEvent);
      } finally {
        releasingUnderlyingTouch = false;
        singleTouchTarget = null;
      }
    };

    const onTouchStart = (event) => {
      if (!pinchActive && event.touches.length !== 2) {
        if (event.touches.length === 1) singleTouchTarget = event.target;
        return;
      }
      if (!pinchActive) cancelUnderlyingTouch(event);
      pinchActive = true;
      if (event.touches.length !== 2) {
        pinchDistance = null;
        consume(event);
        return;
      }
      pinchDistance = touchDistance(event.touches);
      consume(event);
    };

    const onTouchMove = (event) => {
      if (!pinchActive) return;
      consume(event);
      if (pinchDistance === null || event.touches.length !== 2) return;
      const nextDistance = touchDistance(event.touches);
      if (pinchDistance > 0 && nextDistance > 0) queueZoom(nextDistance / pinchDistance);
      pinchDistance = nextDistance;
    };

    const onTouchEnd = (event) => {
      if (releasingUnderlyingTouch) return;
      if (!pinchActive) {
        if (event.touches.length === 0) singleTouchTarget = null;
        return;
      }
      consume(event);
      if (event.touches.length === 2) pinchDistance = touchDistance(event.touches);
      else pinchDistance = null;
      if (event.touches.length === 0) pinchActive = false;
    };

    const listenerOptions = { capture: true, passive: false };
    const removeListeners = () => {
      if (!canvas) return;
      canvas.removeEventListener('wheel', onWheel, listenerOptions);
      canvas.removeEventListener('touchstart', onTouchStart, listenerOptions);
      canvas.removeEventListener('touchmove', onTouchMove, listenerOptions);
      canvas.removeEventListener('touchend', onTouchEnd, listenerOptions);
      canvas.removeEventListener('touchcancel', onTouchEnd, listenerOptions);
      canvas = undefined;
    };

    const bindWhenMounted = () => {
      if (disposed) return;
      const nextCanvas = canvasRef.current;
      if (!nextCanvas) {
        bindFrame = requestFrame(bindWhenMounted);
        return;
      }
      canvas = nextCanvas;
      canvas.addEventListener('wheel', onWheel, listenerOptions);
      canvas.addEventListener('touchstart', onTouchStart, listenerOptions);
      canvas.addEventListener('touchmove', onTouchMove, listenerOptions);
      canvas.addEventListener('touchend', onTouchEnd, listenerOptions);
      canvas.addEventListener('touchcancel', onTouchEnd, listenerOptions);
    };

    bindWhenMounted();
    return () => {
      disposed = true;
      removeListeners();
      if (bindFrame !== undefined) cancelFrame(bindFrame);
      if (zoomFrame !== undefined) cancelFrame(zoomFrame);
    };
  }, [canvasRef, enabled, getViewport, maxZoom, minZoom, setViewport]);

  return { zoomIn, zoomOut, zoomTo };
}
