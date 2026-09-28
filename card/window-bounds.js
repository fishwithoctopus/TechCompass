export function cardBounds(current, area, collapsed) {
  const width = collapsed ? 96 : 400;
  const height = collapsed ? 48 : 580;
  return {
    x: Math.round(Math.max(area.x, Math.min(current.x + current.width - width, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(current.y + current.height - height, area.y + area.height - height))),
    width,
    height,
  };
}
