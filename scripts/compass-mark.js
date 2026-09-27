// One geometric source for the vector wordmark, app icon and template tray icon.
export const strokeWidth = 4;
const starY = 104;
const cubic = (a, b, c, d) => Array.from({ length: 41 }, (_, i) => {
  const t = i / 40, u = 1 - t;
  return [0, 1].map(k => u*u*u*a[k] + 3*u*u*t*b[k] + 3*u*t*t*c[k] + t*t*t*d[k]);
});
// Asymmetric outlined crescent, lower horn ends just below the star's right tip.
const innerTop = cubic([53,131], [42,77], [96,42], [157,40]);
const crossing = innerTop.findIndex((p, i) => i && p[1] <= starY && innerTop[i-1][1] >= starY);
const a = innerTop[crossing-1], b = innerTop[crossing];
const leftTip = a[0] + (b[0]-a[0]) * (starY-a[1]) / (b[1]-a[1]) + strokeWidth;
const moon = [
  ...cubic([157,40], [85,9], [26,58], [32,128]),
  ...cubic([32,128], [37,218], [174,246], [219,128]).slice(1),
  ...cubic([219,128], [160,215], [65,205], [53,131]).slice(1),
  ...innerTop.slice(1),
];
export const paths = [moon,
  [[135,48], [145,94], [194,starY], [145,114], [135,186], [125,114], [leftTip,starY], [125,94], [135,48]],
].map(points => points.map(([x,y]) => [x+3,y+5]));
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="none" stroke="black" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths.map(points => `<polyline points="${points.map(p => p.join(',')).join(' ')}"/>`).join('')}</svg>`;
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
    const coverage = Math.max(0, Math.min(1, (strokeWidth / 2 - distance) * size / 256 + .5));
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
