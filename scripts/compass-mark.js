// One geometric source for the vector wordmark, app icon and template tray icon.
export const paths = [
  Array.from({ length: 101 }, (_, i) => { const a = (25 + i * 2.7) * Math.PI / 180; return [128 + 96 * Math.cos(a), 128 + 96 * Math.sin(a)]; }),
  [[128, 36], [145, 128], [128, 220], [111, 128], [128, 36]],
  [[72, 128], [128, 111], [184, 128], [128, 145], [72, 128]],
];
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none" stroke="black" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">${paths.map(points => `<polyline points="${points.map(p => p.join(',')).join(' ')}"/>`).join('')}</svg>`;
export function drawMark(size, template = false) {
  const out = Buffer.alloc(size * size * 4);
  const segments = paths.flatMap(points => points.slice(1).map((p, i) => [points[i], p]));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + .5) * 256 / size, py = (y + .5) * 256 / size;
    let distance = Infinity;
    for (const [[ax, ay], [bx, by]] of segments) {
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
      distance = Math.min(distance, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    const coverage = Math.max(0, Math.min(1, (6 - distance) * size / 256 + .5));
    const i = (y * size + x) * 4;
    if (template) { out[i+3] = Math.round(255 * coverage); }
    else {
      const cornerX = Math.max(24 - px, 0, px - 232), cornerY = Math.max(24 - py, 0, py - 232);
      const tile = px >= 8 && px <= 248 && py >= 8 && py <= 248 && Math.hypot(cornerX, cornerY) <= 16;
      for (let c = 0; c < 3; c++) out[i+c] = Math.round(26 + coverage * (242 - 26));
      out[i+3] = tile ? 255 : 0;
    }
  }
  return out;
}
