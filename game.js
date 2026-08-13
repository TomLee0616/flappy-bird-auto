(function () {
  'use strict';

  // ---- DOM ----
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlayStart = document.getElementById('overlay-start');
  const overlayOver = document.getElementById('overlay-over');
  const scoreFinal = document.getElementById('score-final');
  const scoreBest = document.getElementById('score-best');
  const newBestEl = document.getElementById('new-best');
  const btnAuto = document.getElementById('btn-auto');

  // ---- 逻辑分辨率 ----
  const W = 400;
  const H = 600;
  const GROUND_H = 80;
  const GROUND_Y = H - GROUND_H;

  // ---- 小鸟物理常量 ----
  const GRAVITY = 0.45;   // 每帧(60fps 基准)重力加速度
  const FLAP = -8.0;      // 手动跳跃冲量(向上为负)
  const MAX_FALL = 11;    // 最大下落速度
  const BIRD_R = 15;
  const BIRD_X = 90;

  // ---- 自动模式参数(经数值模拟调优) ----
  const FLAP_AUTO = -6.0;    // 自动跳跃冲量(较小,避免过冲)
  const AUTO_BAND = 25;      // 目标死区(px)
  const AUTO_COOLDOWN = 6;   // 两次跳跃最小间隔(帧)

  // ---- 管道常量 ----
  const PIPE_W = 68;
  const PIPE_GAP_BASE = 168;  // 初始开口高度
  const PIPE_GAP_MIN = 122;   // 最小开口高度
  const PIPE_SPACING = 250;   // 相邻管道间距
  const SPEED_BASE = 2.7;     // 初始移动速度
  const SPEED_MAX = 5.4;      // 最大移动速度
  const PIPE_SMOOTH_RANGE = 40; // 相邻管道开口中心的最大突变(px),保证可玩且 AI 可追踪

  // ---- 背景云 ----
  const CLOUDS = [
    { x: 60, y: 90, s: 1.0 },
    { x: 210, y: 55, s: 0.7 },
    { x: 320, y: 140, s: 0.9 },
  ];

  // ---- 状态 ----
  let state = 'ready';        // ready | playing | over
  let bird = {};
  let pipes = [];
  let score = 0;
  let best = 0;
  let overAt = 0;             // 死亡时刻,用于防止误触立即重开
  let lastTime = 0;
  let cloudOffset = 0;
  let elapsed = 0;            // 累计帧时间,用于管道上下移动的相位
  let autoMode = false;       // 自动控制模式
  let lastAutoFlap = -999;    // 自动模式上次跳跃时的 elapsed
  let prevPipeCenter = null;  // 上一根管道的开口中心(用于平滑生成)
  let rafId = null;

  // ---- 音效(Web Audio API,无外部文件) ----
  let audioCtx = null;
  function ensureAudio() {
    if (!audioCtx) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        return null;
      }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function tone(opts) {
    const c = ensureAudio();
    if (!c) return;
    const t0 = c.currentTime + (opts.delay || 0);
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.freq, t0);
    if (opts.glide) o.frequency.exponentialRampToValueAtTime(opts.glide, t0 + opts.dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(opts.vol || 0.2, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + opts.dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + opts.dur + 0.05);
  }

  function sfxFlap() {
    tone({ freq: 500, glide: 900, dur: 0.12, type: 'triangle', vol: 0.18 });
  }

  function sfxScore() {
    tone({ freq: 780, dur: 0.09, type: 'square', vol: 0.15 });
    tone({ freq: 1175, dur: 0.12, type: 'square', vol: 0.15, delay: 0.08 });
  }

  function sfxHit() {
    tone({ freq: 220, glide: 55, dur: 0.3, type: 'sawtooth', vol: 0.22 });
    const c = ensureAudio();
    if (!c) return;
    const t0 = c.currentTime;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.15), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.3;
    src.connect(g);
    g.connect(c.destination);
    src.start(t0);
  }

  // ---- 最高分(localStorage) ----
  function loadBest() {
    try { return parseInt(localStorage.getItem('flappy-best') || '0', 10) || 0; }
    catch (e) { return 0; }
  }
  function saveBest(v) {
    try { localStorage.setItem('flappy-best', String(v)); }
    catch (e) { /* 存储不可用时静默忽略 */ }
  }

  // ---- 难度 ----
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function currentGap() {
    return Math.max(PIPE_GAP_BASE - score * 1.4, PIPE_GAP_MIN);
  }
  function currentSpeed() {
    return Math.min(SPEED_BASE + score * 0.06, SPEED_MAX);
  }
  function currentMoveAmp() {
    // 超过 20 分后管道上下摆动;幅度封顶 35,保证开口始终可穿越且 AI 可追踪
    return score > 20 ? Math.min((score - 20) * 0.7, 35) : 0;
  }

  // ---- 小鸟 / 管道 ----
  function resetBird() {
    bird = { x: BIRD_X, y: H / 2, vy: 0, rot: 0 };
  }

  function makePipe(x) {
    const gap = currentGap();
    const half = gap / 2;
    const minTop = 60 + half;
    const maxTop = GROUND_Y - 60 - half;
    let center;
    if (prevPipeCenter === null) {
      center = minTop + Math.random() * (maxTop - minTop);
    } else {
      // 开口中心平滑过渡,避免相邻管道突变导致无法穿越
      center = clamp(prevPipeCenter + (Math.random() * 2 - 1) * PIPE_SMOOTH_RANGE, minTop, maxTop);
    }
    prevPipeCenter = center;
    return {
      x: x,
      center: center,
      baseCenter: center,
      gap: gap,
      scored: false,
      phase: Math.random() * Math.PI * 2, // 上下移动的独立相位
    };
  }

  function spawnPipes() {
    pipes = [];
    prevPipeCenter = null;
    for (let i = 0; i < 4; i++) {
      pipes.push(makePipe(W + i * PIPE_SPACING + 60));
    }
  }

  // ---- 状态切换 ----
  function startGame() {
    score = 0;
    resetBird();
    spawnPipes();
    state = 'playing';
    overlayStart.classList.add('hidden');
    overlayOver.classList.add('hidden');
  }

  function gameOver() {
    state = 'over';
    overAt = performance.now();
    sfxHit();
    const prevBest = best;
    if (score > best) {
      best = score;
      saveBest(best);
    }
    scoreFinal.textContent = score;
    scoreBest.textContent = best;
    newBestEl.classList.toggle('hidden', score <= prevBest);
    overlayOver.classList.remove('hidden');
  }

  function goHome() {
    state = 'ready';
    resetBird();
    spawnPipes();
    overlayOver.classList.add('hidden');
    overlayStart.classList.remove('hidden');
    scoreBest.textContent = best;
  }

  // ---- 玩家操作 ----
  function action() {
    ensureAudio();
    if (state === 'ready') {
      startGame();
      flap();
    } else if (state === 'playing') {
      flap();
    } else if (state === 'over') {
      if (performance.now() - overAt > 350) startGame();
    }
  }

  function flap() {
    bird.vy = FLAP;
    sfxFlap();
  }

  function updateAutoBtn() {
    btnAuto.textContent = autoMode ? '自动模式:开' : '自动模式:关';
    btnAuto.classList.toggle('active', autoMode);
  }

  // 自动控制:瞄准前方最近管道的开口中心,低于目标死区且距上次跳跃足够久时起跳。
  // 目标取"预测到达时"的开口中心,抵消管道上下移动的追踪滞后。
  function autoPilot() {
    let next = null;
    for (const p of pipes) {
      if (p.x + PIPE_W > bird.x - BIRD_R) { next = p; break; }
    }
    if (!next) return;

    const n = (next.x + PIPE_W / 2 - bird.x) / currentSpeed(); // 到管道中心的帧数
    const amp = currentMoveAmp();
    const half = next.gap / 2;
    const target = clamp(
      next.baseCenter + Math.sin((elapsed + n) * 0.03 + next.phase) * amp,
      60 + half,
      GROUND_Y - 60 - half
    );

    if (bird.y > target + AUTO_BAND && elapsed - lastAutoFlap >= AUTO_COOLDOWN) {
      bird.vy = FLAP_AUTO;
      lastAutoFlap = elapsed;
      sfxFlap();
    }
  }

  // ---- 碰撞检测(圆 vs 矩形) ----
  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(cx, rx + rw));
    const ny = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ---- 更新 ----
  function update(t) {
    // 小鸟物理
    bird.vy = Math.min(bird.vy + GRAVITY * t, MAX_FALL);
    bird.y += bird.vy * t;

    // 上仰 / 下俯旋转
    const target = bird.vy < 0 ? -0.35 : Math.min(0.9, bird.vy * 0.06);
    bird.rot += (target - bird.rot) * 0.15;

    // 天花板(钳制,不掉出顶部)
    if (bird.y - BIRD_R < 0) {
      bird.y = BIRD_R;
      bird.vy = 0;
    }
    // 地面 → 结束
    if (bird.y + BIRD_R >= GROUND_Y) {
      bird.y = GROUND_Y - BIRD_R;
      gameOver();
      return;
    }

    // 管道移动
    const speed = currentSpeed();
    const moveAmp = currentMoveAmp();
    for (const p of pipes) {
      p.x -= speed * t;
      // 超过 20 分后,管道开口上下摆动,提升难度
      if (moveAmp > 0) {
        const half = p.gap / 2;
        const minTop = 60;
        const maxTop = GROUND_Y - 60;
        p.center = p.baseCenter + Math.sin(elapsed * 0.03 + p.phase) * moveAmp;
        p.center = Math.max(minTop + half, Math.min(maxTop - half, p.center));
      }
    }

    // 越界回收 + 补充
    if (pipes.length && pipes[0].x + PIPE_W < 0) {
      pipes.shift();
      const last = pipes[pipes.length - 1];
      pipes.push(makePipe(last.x + PIPE_SPACING));
    }

    // 得分
    for (const p of pipes) {
      if (!p.scored && p.x + PIPE_W < bird.x) {
        p.scored = true;
        score++;
        sfxScore();
      }
    }

    // 自动控制
    if (autoMode) autoPilot();

    // 碰撞
    for (const p of pipes) {
      const topH = p.center - p.gap / 2;
      const botY = p.center + p.gap / 2;
      if (
        circleRect(bird.x, bird.y, BIRD_R, p.x, 0, PIPE_W, topH) ||
        circleRect(bird.x, bird.y, BIRD_R, p.x, botY, PIPE_W, GROUND_Y - botY)
      ) {
        gameOver();
        return;
      }
    }
  }

  // ---- 渲染 ----
  function render() {
    ctx.clearRect(0, 0, W, H);

    // 天空
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#4ec0e8');
    sky.addColorStop(1, '#a8e6ff');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    drawClouds();
    drawPipes();
    drawGround();
    drawBird();
    drawScore();
    drawAuto();
  }

  function drawClouds() {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    for (const c of CLOUDS) {
      const x = ((c.x - cloudOffset * c.s) % (W + 120) + (W + 120)) % (W + 120) - 60;
      drawCloud(x, c.y, c.s);
    }
  }

  function drawCloud(x, y, s) {
    ctx.beginPath();
    ctx.arc(x, y, 20 * s, 0, Math.PI * 2);
    ctx.arc(x + 18 * s, y - 8 * s, 16 * s, 0, Math.PI * 2);
    ctx.arc(x + 36 * s, y, 19 * s, 0, Math.PI * 2);
    ctx.arc(x + 18 * s, y + 6 * s, 17 * s, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipes() {
    for (const p of pipes) {
      const topH = p.center - p.gap / 2;
      const botY = p.center + p.gap / 2;
      drawPipe(p.x, 0, PIPE_W, topH);
      drawPipe(p.x, botY, PIPE_W, GROUND_Y - botY);
    }
  }

  function drawPipe(x, y, w, h) {
    if (h <= 0) return;
    // 主体
    const grad = ctx.createLinearGradient(x, 0, x + w, 0);
    grad.addColorStop(0, '#6ecb3c');
    grad.addColorStop(0.5, '#8be04f');
    grad.addColorStop(1, '#57a92f');
    ctx.fillStyle = grad;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#3e7d22';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y, w - 2, h);

    // 帽檐(上下管道朝向开口一端)
    const capH = 26;
    const capY = (y === 0) ? h - capH : y;
    const cg = ctx.createLinearGradient(x, 0, x + w, 0);
    cg.addColorStop(0, '#5cb832');
    cg.addColorStop(0.5, '#7fd24a');
    cg.addColorStop(1, '#4a962a');
    ctx.fillStyle = cg;
    ctx.fillRect(x - 4, capY, w + 8, capH);
    ctx.strokeRect(x - 4, capY, w + 8, capH);
  }

  function drawGround() {
    const g = ctx.createLinearGradient(0, GROUND_Y, 0, H);
    g.addColorStop(0, '#d9b44a');
    g.addColorStop(1, '#b58c2f');
    ctx.fillStyle = g;
    ctx.fillRect(0, GROUND_Y, W, GROUND_H);

    // 顶部草条
    ctx.fillStyle = '#8be04f';
    ctx.fillRect(0, GROUND_Y, W, 10);
    ctx.fillStyle = '#5cb832';
    ctx.fillRect(0, GROUND_Y, W, 4);

    // 斜纹装饰
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.lineWidth = 6;
    for (let x = -GROUND_H; x < W; x += 26) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y + 14);
      ctx.lineTo(x + GROUND_H, H);
      ctx.stroke();
    }
  }

  function drawBird() {
    const x = bird.x;
    const y = bird.y;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bird.rot);

    // 身体
    ctx.fillStyle = '#ffd93b';
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e0a800';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 翅膀
    ctx.fillStyle = '#ffb400';
    ctx.beginPath();
    ctx.ellipse(-4, 2, 9, 6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // 眼睛
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(6, -5, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(8, -5, 3, 0, Math.PI * 2);
    ctx.fill();

    // 嘴
    ctx.fillStyle = '#ff7b3d';
    ctx.beginPath();
    ctx.moveTo(10, 1);
    ctx.lineTo(20, 4);
    ctx.lineTo(10, 8);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function drawScore() {
    if (state !== 'playing') return;
    ctx.font = '800 42px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.strokeText(String(score), W / 2, 30);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(String(score), W / 2, 30);
  }

  function drawAuto() {
    if (state !== 'playing' || !autoMode) return;
    ctx.font = '700 16px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 217, 59, 0.95)';
    ctx.fillText('AUTO', W - 16, 20);
  }

  // ---- 主循环 ----
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = lastTime ? now - lastTime : 1000 / 60;
    lastTime = now;
    const t = Math.min(dt / (1000 / 60), 3); // 归一化到 60fps 帧,上限防跳变

    cloudOffset = (cloudOffset + t * 0.4) % (W + 120);
    elapsed += t;

    if (state === 'playing') {
      update(t);
    } else if (state === 'over') {
      // 死亡后小鸟继续坠落到地面
      bird.vy = Math.min(bird.vy + GRAVITY * t, MAX_FALL);
      bird.y = Math.min(bird.y + bird.vy * t, GROUND_Y - BIRD_R);
      bird.rot = Math.min(bird.rot + 0.08, 1.2);
    } else if (state === 'ready') {
      // 待开始:小鸟轻微上下浮动
      bird.y = H / 2 + Math.sin(now / 400) * 8;
      bird.rot = 0;
    }

    render();
  }

  // ---- 输入 ----
  function bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        action();
      } else if (e.code === 'KeyA') {
        autoMode = !autoMode;
        updateAutoBtn();
      }
    });

    canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      action();
    });

    overlayStart.addEventListener('click', action);
    overlayOver.addEventListener('click', action);

    document.getElementById('btn-start').addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    document.getElementById('btn-restart').addEventListener('click', (e) => {
      e.stopPropagation();
      action();
    });
    document.getElementById('btn-home').addEventListener('click', (e) => {
      e.stopPropagation();
      goHome();
    });
    btnAuto.addEventListener('click', (e) => {
      e.stopPropagation();
      autoMode = !autoMode;
      updateAutoBtn();
    });
  }

  // ---- 初始化 ----
  function setupCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function init() {
    setupCanvas();
    best = loadBest();
    scoreBest.textContent = best;
    resetBird();
    spawnPipes();
    state = 'ready';
    overlayStart.classList.remove('hidden');
    overlayOver.classList.add('hidden');
    bindInput();
    updateAutoBtn();
    lastTime = 0;
    rafId = requestAnimationFrame(loop);
  }

  init();
})();
