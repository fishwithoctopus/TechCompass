// Local-only optional waiting game. No document-level keyboard handlers.
export function newGame() {
  return { body: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], dir: { x: 1, y: 0 }, food: { x: 12, y: 5 }, score: 0, over: false };
}
export function step(game, random = Math.random) {
  if (game.over) return game;
  const head = { x: game.body[0].x + game.dir.x, y: game.body[0].y + game.dir.y };
  const eat = head.x === game.food?.x && head.y === game.food?.y;
  const solid = eat ? game.body : game.body.slice(0, -1);
  if (head.x < 0 || head.x >= 20 || head.y < 0 || head.y >= 10 || solid.some(p => p.x === head.x && p.y === head.y)) { game.over = true; return game; }
  game.body.unshift(head);
  if (!eat) game.body.pop();
  else {
    game.score++;
    const free = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) if (!game.body.some(p => p.x === x && p.y === y)) free.push({ x, y });
    game.food = free[Math.min(free.length - 1, Math.floor(random() * free.length))];
    if (!free.length) game.over = true;
  }
  return game;
}
export function mountSnake(canvas, label) {
  let game = newGame(), timer = null, turned = false;
  const paint = () => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const styles = getComputedStyle(canvas);
    ctx.clearRect(0, 0, 320, 160);
    ctx.fillStyle = styles.getPropertyValue('--accent').trim() || '#4c8dff';
    for (const p of game.body) ctx.fillRect(p.x * 16 + 2, p.y * 16 + 2, 12, 12);
    ctx.fillStyle = styles.getPropertyValue('--warn').trim() || '#d9a03f';
    if (game.food) ctx.fillRect(game.food.x * 16 + 4, game.food.y * 16 + 4, 8, 8);
    label.textContent = `得分 ${game.score}${game.over ? ' · 本局结束' : !timer ? ' · 已暂停' : ''}`;
  };
  const pause = () => { clearInterval(timer); timer = null; paint(); };
  const resume = () => {
    if (timer || game.over) return;
    timer = setInterval(() => { step(game); turned = false; if (game.over) pause(); else paint(); }, 170);
    paint();
  };
  canvas.addEventListener('blur', pause);
  canvas.addEventListener('keydown', e => {
    if (e.key === ' ') { e.preventDefault(); timer ? pause() : resume(); return; }
    const dir = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } }[e.key];
    if (!dir) return;
    e.preventDefault();
    if (!turned && (dir.x !== -game.dir.x || dir.y !== -game.dir.y)) { game.dir = dir; turned = true; }
  });
  return { pause, start() { pause(); game = newGame(); turned = false; canvas.focus(); resume(); } };
}
