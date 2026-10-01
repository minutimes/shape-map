import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ShapeConnectionPreview from '../src/ShapeConnectionPreview.jsx';

const state = vi.hoisted(() => ({ nodes: [], camera: { x: 0, y: 0, zoom: 1 } }));
vi.mock('@xyflow/react', async (original) => ({ ...await original(), useNodes: () => state.nodes, useViewport: () => state.camera }));

describe('connection preview coordinates', () => {
  it.each([{ x: 171, y: 169, zoom: .62 }, { x: -380, y: 240, zoom: 1.6 }])('draws nested card outlines and ports once in flow space with camera %j', (camera) => {
    state.camera = camera;
    state.nodes = [
      { id: 'source', position: { x: 0, y: 100 }, style: { width: 100, height: 80 } },
      { id: 'section', position: { x: 400, y: 50 }, style: { width: 600, height: 400 } },
      { id: 'child', parentId: 'section', position: { x: 100, y: 50 }, style: { width: 200, height: 80 } },
    ];
    // React Flow supplies a world-space source and a canvas-pixel pointer.
    const pointer = { x: 530 * camera.zoom + camera.x, y: 140 * camera.zoom + camera.y };
    const markup = renderToStaticMarkup(<ShapeConnectionPreview fromNode={state.nodes[0]} fromX={100} fromY={140} fromPosition="right" pointer={pointer} toX={530} toY={140} />);
    expect(markup).toContain('data-target-id="child"');
    expect(markup).toContain('cx="500" cy="140"');
    const outlineX = Number(markup.match(/<rect[^>]* x="([^"]+)"/)[1]);
    expect(outlineX * camera.zoom + camera.x).toBeCloseTo(500 * camera.zoom + camera.x - 4);
    expect(markup).toMatch(/<path d="M100 140/);
  });
  it('keeps the line under the pointer in blank space instead of accepting a distant native snap', () => {
    state.camera = { x: 170, y: 160, zoom: .5 };
    state.nodes = [
      { id: 'source', position: { x: 0, y: 0 }, style: { width: 100, height: 80 } },
      { id: 'remote', position: { x: 2000, y: 1000 }, style: { width: 200, height: 80 } },
    ];
    const markup = renderToStaticMarkup(<ShapeConnectionPreview fromNode={state.nodes[0]} fromX={100} fromY={40} fromPosition="right"
      pointer={{ x: 370, y: 310 }} toX={2000} toY={1040} toNode={state.nodes[1]} toHandle={{ id: 'in' }} connectionStatus="valid" />);
    expect(markup).not.toContain('connection-card-target');
    expect(markup).toContain('cx="400" cy="300"');
  });
});
