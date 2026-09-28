/* Small decorative boid school adapted from this workspace's Nature of Code flock.
 * Separation, alignment and cohesion are local; no PDF bytes are read here. */
(function () {
  "use strict";
  var canvas = document.getElementById("fish-school");
  var ctx = canvas.getContext("2d");
  if (!ctx) return;
  var motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var scheme = window.matchMedia("(prefers-color-scheme: dark)");
  var W = 0, H = 0, scale = 1, fish = [], colors = [];
  var last = 0, raf = 0, pointer = { x: -1000, y: -1000, at: 0 };
  var radius = 54, personal = 20, speed = 1.25, force = 0.055;

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function palette() {
    var style = getComputedStyle(document.documentElement);
    colors = [1, 2, 3].map(function (i) { return style.getPropertyValue("--school-" + i).trim(); });
    if (motion.matches) draw();
  }
  function seed() {
    fish = [];
    var count = W < 480 ? 18 : 68;
    for (var i = 0; i < count; i++) {
      var upper = i < count * 0.75;
      var x = W * (upper ? 0.76 : 0.14) + rand(-65, 65);
      var y = H * (upper ? 0.26 : 0.62) + rand(-55, 55);
      var angle = rand(-0.8, 0.8) + (upper ? Math.PI : 0);
      fish.push({ x: clamp(x, 16, W - 16), y: clamp(y, 16, H - 16),
        vx: Math.cos(angle) * rand(.5, 1.2), vy: Math.sin(angle) * rand(.5, 1.2),
        ax: 0, ay: 0, size: rand(6, 9), phase: rand(0, Math.PI * 2), color: i % 3, cell: 0 });
    }
  }
  function fit() {
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    scale = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    seed(); draw();
  }
  function steer(b, dx, dy, weight) {
    var d = Math.hypot(dx, dy);
    if (d < .001) return;
    var x = dx / d * speed - b.vx, y = dy / d * speed - b.vy;
    var m = Math.hypot(x, y);
    if (m > force) { x *= force / m; y *= force / m; }
    b.ax += x * weight; b.ay += y * weight;
  }
  function update(step, now) {
    var cols = Math.ceil(W / radius) + 1, rows = Math.ceil(H / radius) + 1;
    var grid = Array.from({ length: cols * rows }, function () { return []; });
    fish.forEach(function (b) {
      var cx = clamp(Math.floor(b.x / radius), 0, cols - 1);
      var cy = clamp(Math.floor(b.y / radius), 0, rows - 1);
      b.cell = cy * cols + cx; grid[b.cell].push(b);
    });
    var r2 = radius * radius, p2 = personal * personal;
    fish.forEach(function (b) {
      b.ax = 0; b.ay = 0;
      var sx = 0, sy = 0, ax = 0, ay = 0, cxSum = 0, cySum = 0, n = 0;
      var cx = b.cell % cols, cy = Math.floor(b.cell / cols);
      for (var gy = Math.max(0, cy - 1); gy <= Math.min(rows - 1, cy + 1); gy++) {
        for (var gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
          grid[gy * cols + gx].forEach(function (other) {
            if (other === b) return;
            var dx = other.x - b.x, dy = other.y - b.y, d2 = dx * dx + dy * dy;
            if (d2 > r2 || d2 < .01) return;
            ax += other.vx; ay += other.vy; cxSum += other.x; cySum += other.y; n++;
            if (d2 < p2) { sx -= dx / d2; sy -= dy / d2; }
          });
        }
      }
      steer(b, sx, sy, 1.8);                         // separation
      if (n) { steer(b, ax, ay, 1); steer(b, cxSum / n - b.x, cySum / n - b.y, .8); }
      var flow = Math.sin(b.x * .004 + now * .00018) + Math.cos(b.y * .006 - now * .00012);
      steer(b, Math.cos(flow), Math.sin(flow), .16);
      var edge = 35;
      if (b.x < edge || b.x > W - edge || b.y < edge || b.y > H - edge) {
        steer(b, W / 2 - b.x, H / 2 - b.y, 1.25);
      }
      if (now - pointer.at < 800) {
        var px = b.x - pointer.x, py = b.y - pointer.y, pd2 = px * px + py * py;
        if (pd2 < 130 * 130) steer(b, px, py, 2.5 * (1 - Math.sqrt(pd2) / 130));
      }
      b.vx += b.ax * step; b.vy += b.ay * step;
      var v = Math.hypot(b.vx, b.vy) || 1;
      var wanted = clamp(v, .35, 1.9);
      b.vx *= wanted / v; b.vy *= wanted / v;
      b.x = clamp(b.x + b.vx * step, 9, W - 9);
      b.y = clamp(b.y + b.vy * step, 9, H - 9);
      b.phase += (.12 + wanted * .09) * step;
    });
  }
  function drawFish(b) {
    var s = b.size, wag = Math.sin(b.phase) * .45 * s;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(Math.atan2(b.vy, b.vx));
    ctx.fillStyle = colors[b.color] || "#477f86";
    ctx.beginPath();
    ctx.moveTo(s * 1.2, 0);
    ctx.quadraticCurveTo(s * .2, s * .6, -s * .7, s * .22);
    ctx.quadraticCurveTo(-s, s * .7 + wag, -s * 1.5, s * .55 + wag);
    ctx.lineTo(-s, wag * .6);
    ctx.lineTo(-s * 1.5, -s * .55 + wag);
    ctx.quadraticCurveTo(-s, -s * .7 + wag, -s * .7, -s * .22);
    ctx.quadraticCurveTo(s * .2, -s * .6, s * 1.2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    fish.forEach(drawFish);
  }
  function tick(now) {
    raf = requestAnimationFrame(tick);
    if (now - last < 32) return;                       // 30 fps ceiling
    var step = clamp((now - last) / 33, .3, 1.7);
    last = now;
    update(step, now); draw();
  }
  function sync() {
    cancelAnimationFrame(raf); raf = 0; last = 0;
    if (motion.matches || document.hidden) { draw(); return; }
    raf = requestAnimationFrame(tick);
  }
  window.addEventListener("resize", fit, { passive: true });
  window.addEventListener("pointermove", function (e) {
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.at = performance.now();
  }, { passive: true });
  document.addEventListener("visibilitychange", sync);
  if (motion.addEventListener) motion.addEventListener("change", sync);
  else if (motion.addListener) motion.addListener(sync);
  if (scheme.addEventListener) scheme.addEventListener("change", palette);
  new MutationObserver(palette).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  fit(); palette(); sync();
})();
