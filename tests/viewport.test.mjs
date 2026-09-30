import { describe, expect, it } from 'vitest';
import {
  readableNodeViewport,
  wheelZoomFactor,
  zoomViewportAtCenter,
} from '../src/viewport.js';

function graphPointAtCanvasCenter(viewport, bounds) {
  return {
    x: (bounds.width / 2 - viewport.x) / viewport.zoom,
    y: (bounds.height / 2 - viewport.y) / viewport.zoom,
  };
}

describe('center-preserving viewport zoom', () => {
  it('keeps the same graph coordinate at the canvas center', () => {
    const bounds = { left: 0, top: 0, width: 1000, height: 700 };
    const before = { x: -240, y: 90, zoom: .8 };
    const after = zoomViewportAtCenter(before, 1.6, bounds, { minZoom: .2, maxZoom: 2 });
    expect(graphPointAtCanvasCenter(after, bounds)).toEqual(graphPointAtCanvasCenter(before, bounds));
  });

  it('uses canvas-local dimensions when panels offset the canvas on the page', () => {
    const viewport = { x: 75, y: -20, zoom: 1.1 };
    const local = zoomViewportAtCenter(viewport, .55, { width: 640, height: 480 });
    const offset = zoomViewportAtCenter(viewport, .55, {
      left: 312, top: 84, right: 952, bottom: 564, width: 640, height: 480,
    });
    expect(offset).toEqual(local);
  });

  it('clamps at both limits without shifting the centered graph point', () => {
    const bounds = { width: 820, height: 530 };
    const viewport = { x: -91, y: 37, zoom: .7 };
    const minimum = zoomViewportAtCenter(viewport, .01, bounds, { minZoom: .2, maxZoom: 2 });
    const maximum = zoomViewportAtCenter(viewport, 12, bounds, { minZoom: .2, maxZoom: 2 });
    expect(minimum.zoom).toBe(.2);
    expect(maximum.zoom).toBe(2);
    const center = graphPointAtCanvasCenter(viewport, bounds);
    expect(graphPointAtCanvasCenter(minimum, bounds).x).toBeCloseTo(center.x, 12);
    expect(graphPointAtCanvasCenter(minimum, bounds).y).toBeCloseTo(center.y, 12);
    expect(graphPointAtCanvasCenter(maximum, bounds).x).toBeCloseTo(center.x, 12);
    expect(graphPointAtCanvasCenter(maximum, bounds).y).toBeCloseTo(center.y, 12);
  });

  it('round-trips repeated 1.2 zoom steps without center drift', () => {
    const bounds = { width: 977, height: 611 };
    const original = { x: -417.25, y: 133.5, zoom: .8 };
    let viewport = original;
    for (let index = 0; index < 20; index += 1) {
      viewport = zoomViewportAtCenter(viewport, viewport.zoom * 1.2, bounds);
      viewport = zoomViewportAtCenter(viewport, viewport.zoom / 1.2, bounds);
    }
    expect(viewport.x).toBeCloseTo(original.x, 10);
    expect(viewport.y).toBeCloseTo(original.y, 10);
    expect(viewport.zoom).toBeCloseTo(original.zoom, 12);
  });
});

describe('readable node viewport', () => {
  it('centers cards that fit in the canvas', () => {
    const bounds = { width: 900, height: 600 };
    const node = { position: { x: 240, y: 100 }, measured: { width: 360, height: 300 } };
    const viewport = readableNodeViewport(node, bounds, { zoom: .9 });
    expect(node.position.x * .9 + viewport.x + node.measured.width * .9 / 2).toBe(450);
    expect(node.position.y * .9 + viewport.y + node.measured.height * .9 / 2).toBe(300);
  });

  it('centers the upper reading area of a tall card and leaves its title visible', () => {
    const bounds = { width: 900, height: 600 };
    const node = { position: { x: 240, y: 100 }, width: 360, height: 1400 };
    const viewport = readableNodeViewport(node, bounds, { zoom: .9 });
    const nodeTop = node.position.y * viewport.zoom + viewport.y;
    expect(nodeTop).toBeCloseTo(bounds.height * .15);
    expect(nodeTop).toBeGreaterThanOrEqual(0);
    expect(nodeTop).toBeLessThan(bounds.height / 4);
  });
});

describe('native wheel zoom factor', () => {
  it('zooms in for negative deltas, out for positive deltas, and respects delta mode', () => {
    expect(wheelZoomFactor({ deltaY: -100 })).toBeGreaterThan(1);
    expect(wheelZoomFactor({ deltaY: 100 })).toBeLessThan(1);
    expect(wheelZoomFactor({ deltaY: -2, deltaMode: 1 }))
      .toBeCloseTo(wheelZoomFactor({ deltaY: -50, deltaMode: 0 }));
  });

  it('gives ctrl trackpad pinch a bounded boost', () => {
    const wheel = wheelZoomFactor({ deltaY: -10, deltaMode: 0 });
    const pinch = wheelZoomFactor({ deltaY: -10, deltaMode: 0, ctrlKey: true });
    expect(pinch).toBeGreaterThan(wheel);
    expect(pinch).toBeLessThanOrEqual(Math.exp(.5));
  });
});
