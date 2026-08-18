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
  const btnTest = document.getElementById('btn-test');
  const rlHud = document.getElementById('rl-hud');
  const hudMode = document.getElementById('hud-mode');
  const hudEpisode = document.getElementById('hud-episode');
  const hudScore = document.getElementById('hud-score');
  const hudBest = document.getElementById('hud-best');
  const hudEps = document.getElementById('hud-eps');
  const hudQsize = document.getElementById('hud-qsize');

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

  // ---- 超能力常量 ----
  const POWER_EVERY = 6;         // 每跨过 6 个障碍获得一次超能力
  const SHRINK_DUR = 5 * 60;     // 变小持续 5 秒(60fps 帧)
  const SHRINK_FACTOR = 0.55;    // 变小后的半径比例
  const DASH_DUR = 2 * 60;       // 超音速冲刺持续 2 秒(60fps 帧)
  const DASH_SPEED_MULT = 1.9;   // 冲刺时世界加速倍率
  const BOMB_PIPES = 3;          // 炸弹可炸掉的管道数量
  const INVINCIBLE_AFTER = 60;   // 获得能力后无敌帧数(1 秒)
  const DASH_PIPE_ALPHA = 0.35;  // 冲刺时管道透明度

  // ---- 强化学习(Q-learning)超参数,经数值模拟调优 ----
  const RL_FLAP = -3.5;       // 学习用跳跃冲量(小冲量,便于精细控制)
  const RL_ALPHA = 0.6;       // 学习率
  const RL_GAMMA = 0.99;      // 折扣因子
  const RL_EPS_START = 1.0;   // 初始探索率
  const RL_EPS_MIN = 0.1;     // 最小探索率
  const RL_EPS_DECAY = 0.998; // 每局探索率衰减
  const RL_R_IN = 1.0;        // 缝隙内奖励
  const RL_R_OUT = -0.05;     // 缝隙外奖励
  const RL_R_DEATH = -10;     // 死亡奖励
  const RL_SPEED = 60;        // 训练加速倍率(每渲染帧跑 60 个物理步)

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
  let autoMode = false;       // 强化学习接管(训练或测试)
  let rlMode = 'train';       // 'train' 训练中学习 | 'test' 测试(纯贪心、不学习)
  let prevPipeCenter = null;  // 上一根管道的开口中心(用于平滑生成)
  let rafId = null;

  // ---- 超能力状态 ----
  let pipesSincePower = 0;   // 自上次获得超能力后跨过的障碍数
  let shrinkTime = 0;        // 变小剩余时间(帧)
  let dashTime = 0;          // 冲刺剩余时间(帧)
  let bombCount = 0;         // 持有的炸弹数量
  let effects = [];          // 粒子特效(爆炸/尾迹)
  let toast = null;          // 能力提示 { text, color, time }
  let invincibleTime = 0;    // 无敌剩余时间(帧,获得能力后)
  let prePowerInvincible = false; // 即将获得能力(差 1 个障碍)时进入无敌

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

  function sfxPower() {
    tone({ freq: 660, glide: 990, dur: 0.16, type: 'triangle', vol: 0.2 });
    tone({ freq: 990, dur: 0.14, type: 'sine', vol: 0.16, delay: 0.06 });
  }

  function sfxBomb() {
    tone({ freq: 180, glide: 40, dur: 0.4, type: 'sawtooth', vol: 0.24 });
    const c = ensureAudio();
    if (!c) return;
    const t0 = c.currentTime;
    const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.3), c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.32;
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
    clearPowers();
    overlayStart.classList.add('hidden');
    overlayOver.classList.add('hidden');
    if (autoMode) {
      if (rlMode === 'train') RL.reset(); // 仅训练模式从头重置 Q 表;测试沿用已学到的 Q 表
      RL.onEpisodeStart();
      updateRLHud();
    }
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
    updateBombBtn();
  }

  function goHome() {
    state = 'ready';
    resetBird();
    spawnPipes();
    clearPowers();
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
    if (autoMode) return; // AI 接管时不响应手动跳跃
    bird.vy = FLAP;
    sfxFlap();
  }

  function updateAutoBtn() {
    const trainOn = autoMode && rlMode === 'train';
    const testOn = autoMode && rlMode === 'test';
    btnAuto.textContent = trainOn ? 'AI 训练:开' : 'AI 训练';
    btnAuto.classList.toggle('active', trainOn);
    btnTest.textContent = testOn ? 'AI 测试:开' : 'AI 测试';
    btnTest.classList.toggle('active', testOn);
    rlHud.classList.toggle('hidden', !autoMode);
    hudMode.textContent = rlMode === 'test' ? '测试' : '训练';
  }

  function enterRL(mode) {
    autoMode = true;
    rlMode = mode;
    clearPowers();
    updateAutoBtn();
    if (state === 'playing') {
      RL.onEpisodeStart();
      updateRLHud();
    }
  }

  function toggleTrain() {
    if (autoMode && rlMode === 'train') autoMode = false;
    else enterRL('train');
    updateAutoBtn();
  }

  function toggleTest() {
    if (autoMode && rlMode === 'test') autoMode = false;
    else enterRL('test');
    updateAutoBtn();
  }

  // ---- 强化学习(Q-learning)智能体 ----
  // 状态: (距管道水平距离, 距开口中心竖直距离, 速度方向), 动作: {0 不跳, 1 跳}
  const RL = {
    Q: new Map(),
    eps: RL_EPS_START,
    episode: 0,
    bestScore: 0,
    curState: null,
    curAction: 0,

    nextPipe() {
      for (const p of pipes) if (p.x + PIPE_W > BIRD_X - BIRD_R) return p;
      return null;
    },

    stateOf(next) {
      const dx = next.x + PIPE_W / 2 - BIRD_X;
      const dxIdx = clamp(Math.round(dx / 20), 0, 20);
      const dy = bird.y - next.center;
      const dyIdx = clamp(Math.round(dy / 15), -22, 22);
      const vy = bird.vy > 0 ? 1 : 0;
      return (dxIdx * 45 + (dyIdx + 22)) * 2 + vy;
    },

    qget(s, a) { return this.Q.get(s * 2 + a) || 0; },
    qset(s, a, v) { this.Q.set(s * 2 + a, v); },
    maxQ(s) { const a0 = this.qget(s, 0), a1 = this.qget(s, 1); return a0 >= a1 ? a0 : a1; },

    act(s) {
      // 测试模式:纯贪心,不探索
      if (rlMode === 'test') return this.qget(s, 0) >= this.qget(s, 1) ? 0 : 1;
      if (Math.random() < this.eps) return Math.random() < 0.5 ? 0 : 1;
      return this.qget(s, 0) >= this.qget(s, 1) ? 0 : 1;
    },

    reset() {
      this.Q.clear();
      this.eps = RL_EPS_START;
      this.episode = 0;
      this.bestScore = 0;
    },

    onEpisodeStart() {
      const next = this.nextPipe();
      this.curState = this.stateOf(next);
      this.curAction = this.act(this.curState);
    },

    // 每帧结算: 依据当前状态计算奖励 → 更新 Q → 选择下一动作
    step(died) {
      const next = this.nextPipe();
      const s2 = this.stateOf(next);
      const half = next.gap / 2;
      const inGap = bird.y >= next.center - half + 6 && bird.y <= next.center + half - 6;
      let r;
      if (died) r = RL_R_DEATH;
      else if (inGap) r = RL_R_IN;
      else r = RL_R_OUT;

      // 训练模式才更新 Q 表与探索率;测试模式只做决策,不学习
      if (rlMode === 'train' && this.curState !== null) {
        const old = this.qget(this.curState, this.curAction);
        const target = died ? r : r + RL_GAMMA * this.maxQ(s2);
        this.qset(this.curState, this.curAction, old + RL_ALPHA * (target - old));
      }

      if (died) {
        if (rlMode === 'train') {
          this.episode++;
          this.eps = Math.max(RL_EPS_MIN, this.eps * RL_EPS_DECAY);
        }
      } else {
        this.curState = s2;
        this.curAction = this.act(s2);
      }
    },
  };

  function updateRLHud() {
    hudEpisode.textContent = RL.episode;
    hudScore.textContent = score;
    hudBest.textContent = RL.bestScore;
    hudEps.textContent = rlMode === 'test' ? '贪心' : RL.eps.toFixed(2);
    hudQsize.textContent = RL.Q.size / 2;
  }

  // ---- 碰撞检测(圆 vs 矩形) ----
  function circleRect(cx, cy, r, rx, ry, rw, rh) {
    const nx = Math.max(rx, Math.min(cx, rx + rw));
    const ny = Math.max(ry, Math.min(cy, ry + rh));
    const dx = cx - nx;
    const dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ---- 超能力 ----
  function currentBirdR() {
    return shrinkTime > 0 ? BIRD_R * SHRINK_FACTOR : BIRD_R;
  }

  function updateBombBtn() {
    const btn = document.getElementById('btn-bomb');
    const show = bombCount > 0 && state === 'playing';
    btn.classList.toggle('hidden', !show);
    document.getElementById('bomb-count').textContent = bombCount;
  }

  function clearPowers() {
    pipesSincePower = 0;
    shrinkTime = 0;
    dashTime = 0;
    bombCount = 0;
    effects = [];
    toast = null;
    invincibleTime = 0;
    prePowerInvincible = false;
    updateBombBtn();
  }

  function showToast(text, color) {
    toast = { text, color, time: 0 };
  }

  function grantPower() {
    const r = Math.random();
    if (r < 1 / 3) {
      shrinkTime = SHRINK_DUR;
      showToast('超能力: 变小!', '#7fd2ff');
    } else if (r < 2 / 3) {
      dashTime = DASH_DUR;
      showToast('超能力: 超音速冲刺!', '#ffd93b');
    } else {
      bombCount++;
      updateBombBtn();
      showToast('超能力: 获得炸弹!', '#ff9f43');
    }
    invincibleTime = INVINCIBLE_AFTER; // 获得能力后 1 秒无敌
    prePowerInvincible = false;
    sfxPower();
  }

  function explodePipe(p) {
    const colors = ['#ffd93b', '#ff9f43', '#ff6b6b', '#ffffff'];
    const cx = p.x + PIPE_W / 2;
    for (let i = 0; i < 28; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 4;
      effects.push({
        x: cx + (Math.random() - 0.5) * PIPE_W,
        y: p.center + (Math.random() - 0.5) * 60,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 32 + Math.random() * 26,
        maxLife: 58,
        size: 2 + Math.random() * 4,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  function triggerBomb() {
    if (state !== 'playing' || bombCount <= 0) return;
    let n = 0;
    for (const p of pipes) {
      if (n >= BOMB_PIPES) break;
      if (p.destroyed || p.scored) continue;
      p.destroyed = true;
      p.scored = true; // 被炸掉的障碍不再计分
      explodePipe(p);
      n++;
    }
    if (n > 0) {
      bombCount--;
      updateBombBtn();
      sfxBomb();
      showToast('炸弹! 摧毁 ' + n + ' 个障碍', '#ff6b6b');
    }
  }

  function updateEffects(t) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.life -= t;
      if (e.life <= 0) { effects.splice(i, 1); continue; }
      e.x += e.vx * t;
      e.y += e.vy * t;
      e.vy += 0.08 * t;
    }
    if (toast) {
      toast.time += t;
      if (toast.time > 85) toast = null;
    }
  }

  // ---- 更新 ----
  function update(t) {
    elapsed += t;

    // 超能力计时(帧)
    if (shrinkTime > 0) shrinkTime = Math.max(0, shrinkTime - t);
    if (dashTime > 0) dashTime = Math.max(0, dashTime - t);
    if (invincibleTime > 0) invincibleTime = Math.max(0, invincibleTime - t);

    const birdR = currentBirdR();

    // RL: 应用上一步选择的动作(小冲量起跳)
    if (autoMode && RL.curAction === 1) {
      bird.vy = RL_FLAP;
    }

    // 小鸟物理
    bird.vy = Math.min(bird.vy + GRAVITY * t, MAX_FALL);
    bird.y += bird.vy * t;

    // 上仰 / 下俯旋转
    const rotTarget = bird.vy < 0 ? -0.35 : Math.min(0.9, bird.vy * 0.06);
    bird.rot += (rotTarget - bird.rot) * 0.15;

    // 天花板(钳制,不掉出顶部)
    if (bird.y - birdR < 0) {
      bird.y = birdR;
      bird.vy = 0;
    }

    let died = false;
    // 地面
    if (bird.y + birdR >= GROUND_Y) {
      bird.y = GROUND_Y - birdR;
      died = true;
    }

    // 管道移动(冲刺时世界加速)
    let speed = currentSpeed();
    if (dashTime > 0) speed *= DASH_SPEED_MULT;
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

    // 得分 + 跨障碍计数(每 6 个触发超能力,仅手动模式)
    for (const p of pipes) {
      if (!p.scored && !p.destroyed && p.x + PIPE_W < bird.x) {
        p.scored = true;
        score++;
        if (!autoMode) {
          sfxScore();
          pipesSincePower++;
          if (pipesSincePower === POWER_EVERY - 1) prePowerInvincible = true; // 差 1 个障碍获得能力,提前进入无敌
          if (pipesSincePower >= POWER_EVERY) {
            pipesSincePower = 0;
            grantPower();
          }
        }
      }
    }

    // 碰撞(冲刺时无视障碍;被摧毁的管道不参与碰撞)
    if (!died && dashTime <= 0 && invincibleTime <= 0 && !prePowerInvincible) {
      for (const p of pipes) {
        if (p.destroyed) continue;
        const topH = p.center - p.gap / 2;
        const botY = p.center + p.gap / 2;
        if (
          circleRect(bird.x, bird.y, birdR, p.x, 0, PIPE_W, topH) ||
          circleRect(bird.x, bird.y, birdR, p.x, botY, PIPE_W, GROUND_Y - botY)
        ) {
          died = true;
          break;
        }
      }
    }

    // RL 学习结算
    if (autoMode) {
      RL.step(died);
    }

    // 处理死亡
    if (died) {
      if (autoMode && rlMode === 'train') {
        // 训练:记录本局最高分,自动重开新局继续训练
        RL.bestScore = Math.max(RL.bestScore, score);
        score = 0;
        resetBird();
        spawnPipes();
        RL.onEpisodeStart();
      } else {
        // 测试或手动:显示结束界面
        gameOver();
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
    drawEffects();
    drawGround();
    drawDash();
    drawBird();
    drawScore();
    drawPowerHud();
    drawToast();
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
    const ghost = state === 'playing' && dashTime > 0;
    ctx.globalAlpha = ghost ? DASH_PIPE_ALPHA : 1;
    for (const p of pipes) {
      if (p.destroyed) continue;
      const topH = p.center - p.gap / 2;
      const botY = p.center + p.gap / 2;
      drawPipe(p.x, 0, PIPE_W, topH);
      drawPipe(p.x, botY, PIPE_W, GROUND_Y - botY);
    }
    ctx.globalAlpha = 1;
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

  function drawEffects() {
    for (const e of effects) {
      const a = e.life / e.maxLife;
      ctx.globalAlpha = a;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size * a + 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawDash() {
    if (state !== 'playing' || dashTime <= 0) return;
    ctx.save();
    ctx.lineCap = 'round';

    // 橙红拖尾光带
    const grad = ctx.createLinearGradient(bird.x - 16, 0, bird.x - 140, 0);
    grad.addColorStop(0, 'rgba(255, 90, 60, 0.8)');
    grad.addColorStop(1, 'rgba(255, 90, 60, 0)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.moveTo(bird.x - 14, bird.y);
    ctx.lineTo(bird.x - 140, bird.y);
    ctx.stroke();

    // 白色速度线
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    for (let i = 0; i < 16; i++) {
      const y = bird.y + (Math.random() - 0.5) * 74;
      const len = 40 + Math.random() * 100;
      ctx.lineWidth = 1 + Math.random() * 3;
      ctx.globalAlpha = 0.35 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.moveTo(bird.x - 14, y);
      ctx.lineTo(bird.x - 14 - len, y);
      ctx.stroke();
    }
    ctx.restore();
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
    const s = currentBirdR() / BIRD_R;
    const dashing = state === 'playing' && dashTime > 0;
    const invincible = state === 'playing' && (invincibleTime > 0 || prePowerInvincible);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(bird.rot);
    ctx.scale(s, s);

    // 无敌光环
    if (invincible) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, BIRD_R + 7 + Math.sin(elapsed * 0.5) * 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 冲刺时红色发光
    if (dashing) {
      ctx.shadowColor = '#ff3030';
      ctx.shadowBlur = 20;
    }

    // 身体
    ctx.fillStyle = dashing ? '#ff3b3b' : '#ffd93b';
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = dashing ? '#c41616' : '#e0a800';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 翅膀
    ctx.fillStyle = dashing ? '#e02828' : '#ffb400';
    ctx.beginPath();
    ctx.ellipse(-4, 2, 9, 6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

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

  function drawPowerHud() {
    if (state !== 'playing') return;
    const items = [];
    if (shrinkTime > 0) items.push({ text: '变小 ' + (shrinkTime / 60).toFixed(1) + 's', color: '#7fd2ff' });
    if (dashTime > 0) items.push({ text: '冲刺 ' + (dashTime / 60).toFixed(1) + 's', color: '#ffd93b' });
    if (bombCount > 0) items.push({ text: '炸弹 x' + bombCount + ' (B 释放)', color: '#ff9f43' });
    if (invincibleTime > 0 || prePowerInvincible) items.push({ text: '无敌', color: '#ffe08a' });
    if (items.length === 0) return;

    ctx.font = '700 14px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let y = 14;
    for (const it of items) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.strokeText(it.text, 12, y);
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, 12, y);
      y += 20;
    }
  }

  function drawToast() {
    if (!toast) return;
    let a;
    if (toast.time < 10) a = toast.time / 10;
    else if (toast.time > 75) a = Math.max(0, (85 - toast.time) / 10);
    else a = 1;
    ctx.globalAlpha = a;
    ctx.font = '800 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.strokeText(toast.text, W / 2, 110);
    ctx.fillStyle = toast.color;
    ctx.fillText(toast.text, W / 2, 110);
    ctx.globalAlpha = 1;
  }

  function drawAuto() {
    if (state !== 'playing' || !autoMode) return;
    ctx.font = '700 15px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 217, 59, 0.95)';
    ctx.fillText(rlMode === 'test' ? 'AI 测试中' : 'AI 训练中', W - 12, 20);
  }

  // ---- 主循环 ----
  function loop(now) {
    rafId = requestAnimationFrame(loop);
    const dt = lastTime ? now - lastTime : 1000 / 60;
    lastTime = now;
    const t = Math.min(dt / (1000 / 60), 3); // 归一化到 60fps 帧,上限防跳变

    cloudOffset = (cloudOffset + t * 0.4) % (W + 120);
    updateEffects(t);

    if (state === 'playing') {
      if (autoMode && rlMode === 'train') {
        // 训练:每渲染帧跑多个物理步,加速学习
        for (let i = 0; i < RL_SPEED; i++) update(1);
      } else {
        // 测试/手动:正常速度
        update(t);
      }
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
    if (autoMode && state === 'playing') updateRLHud();
  }

  // ---- 输入 ----
  function bindInput() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
        e.preventDefault();
        action();
      } else if (e.code === 'KeyA') {
        toggleTrain();
      } else if (e.code === 'KeyT') {
        toggleTest();
      } else if (e.code === 'KeyB') {
        e.preventDefault();
        triggerBomb();
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
      toggleTrain();
    });
    btnTest.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTest();
    });
    document.getElementById('btn-bomb').addEventListener('click', (e) => {
      e.stopPropagation();
      triggerBomb();
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
