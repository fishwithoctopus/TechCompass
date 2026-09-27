// One geometric source for the vector wordmark, app icon and template tray icon.
export const strokeWidth = 8;
const starY = 104;
// The left tip's stroke touches the crescent's inner circle at the raised crossbar.
const leftTip = 142 - Math.sqrt(90 ** 2 - (starY - 128) ** 2) + strokeWidth / 2;
export const paths = [
  [[128, 48], [138, 94], [184, starY], [138, 114], [128, 212], [118, 114], [leftTip, starY], [118, 94], [128, 48]],
];
const tipX = 128 + (96 ** 2 - 90 ** 2 + 14 ** 2) / 28;
const tipY = 128 - Math.sqrt(96 ** 2 - (tipX - 128) ** 2);
const crescent = `M ${tipX} ${tipY} A 96 96 0 1 0 ${tipX} ${256-tipY} A 90 90 0 1 1 ${tipX} ${tipY} Z`;
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><path d="${crescent}" fill="black"/><polyline points="${paths[0].map(p => p.join(',')).join(' ')}" fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
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
    const moonDistance = Math.min(96 - Math.hypot(px - 128, py - 128), Math.hypot(px - 142, py - 128) - 90);
    const coverage = Math.max(0, Math.min(1, Math.max(strokeWidth / 2 - distance, moonDistance) * size / 256 + .5));
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
