const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function viewportSize(bounds = {}) {
  return {
    width: Math.max(0, finite(bounds.width)),
    height: Math.max(0, finite(bounds.height)),
  };
}

function zoomLimits({ minZoom = 0, maxZoom = Number.POSITIVE_INFINITY } = {}) {
  const minimum = Math.max(0, finite(minZoom));
  const maximum = Math.max(minimum, finite(maxZoom, Number.POSITIVE_INFINITY));
  return { minimum, maximum };
}

/**
 * Changes zoom while leaving the graph coordinate at the canvas's visual center fixed.
 * Viewport x/y are canvas-local, so a DOMRect's page offset intentionally has no effect.
 */
export function zoomViewportAtCenter(viewport, nextZoom, bounds, limits = {}) {
  const currentZoom = Math.max(Number.EPSILON, finite(viewport?.zoom, 1));
  const { minimum, maximum } = zoomLimits(limits);
  const zoom = Math.min(maximum, Math.max(minimum, finite(nextZoom, currentZoom)));
  const { width, height } = viewportSize(bounds);
  const centerX = width / 2;
  const centerY = height / 2;
  const x = finite(viewport?.x);
  const y = finite(viewport?.y);
  const scale = zoom / currentZoom;

  return {
    x: centerX - (centerX - x) * scale,
    y: centerY - (centerY - y) * scale,
    zoom,
  };
}

function nodeMetric(node, dimension) {
  return Math.max(0, finite(
    node?.measured?.[dimension]
      ?? node?.[dimension]
      ?? node?.style?.[dimension],
  ));
}

/**
 * Builds a viewport that centers ordinary cards. If a card is taller than the visible
 * graph area, it centers the upper 70% reading window and leaves its title in view.
 */
export function readableNodeViewport(node, bounds, { zoom = .9 } = {}) {
  const safeZoom = Math.max(Number.EPSILON, finite(zoom, .9));
  const { width: canvasWidth, height: canvasHeight } = viewportSize(bounds);
  const position = node?.positionAbsolute ?? node?.position ?? node ?? {};
  const nodeX = finite(position.x);
  const nodeY = finite(position.y);
  const nodeWidth = nodeMetric(node, 'width');
  const nodeHeight = nodeMetric(node, 'height');
  const visibleGraphHeight = canvasHeight / safeZoom;
  const targetY = nodeHeight > visibleGraphHeight
    ? nodeY + visibleGraphHeight * .35
    : nodeY + nodeHeight / 2;

  return {
    x: canvasWidth / 2 - (nodeX + nodeWidth / 2) * safeZoom,
    y: canvasHeight / 2 - targetY * safeZoom,
    zoom: safeZoom,
  };
}

/** Converts one native wheel event into a bounded zoom multiplier. */
export function wheelZoomFactor({ deltaY = 0, deltaMode = 0, ctrlKey = false } = {}) {
  const sensitivity = deltaMode === 1 ? .05 : deltaMode === 2 ? 1 : .002;
  const pinchBoost = ctrlKey && deltaMode === 0 ? 4 : 1;
  const exponent = Math.min(.5, Math.max(-.5, -finite(deltaY) * sensitivity * pinchBoost));
  return Math.exp(exponent);
}
