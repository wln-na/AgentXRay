// Codex 风格矢量吉祥物（renderer 默认外观）：蓝色云朵脑袋 + 深色终端屏 + 小身体。
//
// 参考 Codex 吉祥物：蓬松云朵头（多圆并集）、深藏青圆角屏幕内发青色 ">_" 提示符、
// 下方圆身体 + 肚皮 ">_" + 两只小脚。全部用 Canvas 路径矢量绘制，零图片、零构建。
//
// 职责边界（与 lib/pixel.js 内置像素动画的契约对齐）：
//   draw(ctx, state, elapsedMs, geom) → 帧信息 | false（state 非法时返回 false，调用方回退像素）
//   帧信息 = { bubblePx:{x,y}, pulse:bool, hot:{cx,cy,s,bobY,shakeX}, geom }
//   hotTest(pointer, hot, opts) → boolean（点击穿透热区命中测试，画布像素坐标）
//
// 仅用 DOM/Canvas，无 require、无网络；6 态全覆盖，未知 state 直接放弃绘制。

(() => {
  // ---- 配色（取自参考图：皇家蓝云朵 + 藏青屏幕 + 青色提示符） ----
  const C = {
    base: '#3E5EDB', // 云朵主体
    light: '#5F7FEE', // 顶部高光
    deep: '#3452C4', // 底部阴影
    deep2: '#2B44A6', // 脚 / 暗部
    screenEdge: '#0B1126', // 屏幕外框
    screen: '#151E3C', // 屏幕底色
    prompt: '#7CF0DC', // 青色提示符
    promptDim: '#41BFA8', // 提示符暗态
    halo: '#67E8F9', // waiting 光环
    red: '#F87171', // error
    green: '#4ADE80', // done
  };

  const STATES = ['idle', 'thinking', 'working', 'done', 'waiting_input', 'error'];

  // ---- 小工具 ----
  // 描圆角矩形到当前路径（不 beginPath，可并入路径并集）
  function traceRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    traceRoundRect(ctx, x, y, w, h, r);
  }

  function circle(ctx, x, y, r) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }

  function line(ctx, x1, y1, x2, y2) {
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
  }

  // ---- 姿态：每个状态的时间驱动参数 ----
  // 返回 { bobY(设计px, 负=上), shakeX, rot(弧度), pulse }
  function pose(state, t) {
    let bobY = 0;
    let shakeX = 0;
    let rot = 0;
    let pulse = false;
    if (state === 'idle') {
      bobY = Math.sin((t / 1600) * Math.PI * 2) * 2.2;
    } else if (state === 'thinking') {
      bobY = Math.sin((t / 1200) * Math.PI * 2) * 1.6;
      rot = Math.sin((t / 900) * Math.PI * 2) * 0.035; // 轻微左右歪头
    } else if (state === 'working') {
      bobY = -Math.abs(Math.sin((t / 320) * Math.PI)) * 4; // 轻快小跳
    } else if (state === 'done') {
      bobY = t < 650 ? -Math.sin((t / 650) * Math.PI) * 12 : 0; // 开心一蹦
    } else if (state === 'waiting_input') {
      bobY = -Math.abs(Math.sin((t / 300) * Math.PI)) * 6; // 明显弹跳
      pulse = true;
    } else if (state === 'error') {
      shakeX = Math.sin(t / 55) * 3; // 左右抖动
      pulse = true;
    }
    return { bobY, shakeX, rot, pulse };
  }

  // ---- 云朵头（多圆并集路径）：窄底、顶中大包 + 两侧小包 ----
  const HEAD = [
    { x: 0, y: -100, r: 30 }, // 顶
    { x: -26, y: -86, r: 24 }, // 左上
    { x: 26, y: -86, r: 24 }, // 右上
    { x: -40, y: -66, r: 16 }, // 左侧
    { x: 40, y: -66, r: 16 }, // 右侧
  ];
  const HEAD_SLAB = { x: -44, y: -88, w: 88, h: 50, r: 22 }; // 头底板（补平下缘，底 = -38）

  function headPath(ctx, dx = 0) {
    ctx.beginPath();
    for (const c of HEAD) circle(ctx, c.x + dx, c.y, c.r);
    const s = HEAD_SLAB;
    traceRoundRect(ctx, s.x + dx, s.y, s.w, s.h, s.r);
  }

  // ---- 屏幕内容（提示符区，局部坐标：屏幕中心为原点） ----
  // 屏幕（局部）：w=56 h=42，中心 (0,-84)
  function drawScreen(ctx, state, t) {
    const sx = 0;
    const sy = -84;
    // 外框 + 底
    roundRectPath(ctx, sx - 28, sy - 21, 56, 42, 12);
    ctx.fillStyle = C.screenEdge;
    ctx.fill();
    roundRectPath(ctx, sx - 25, sy - 18, 50, 36, 9);
    ctx.fillStyle = C.screen;
    ctx.fill();

    ctx.save();
    ctx.translate(sx, sy);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;
    ctx.strokeStyle = C.prompt;
    ctx.fillStyle = C.prompt;

    // 左侧 ">" 折线（所有状态通用，等待/错误态闪烁）
    const blink = Math.floor(t / 450) % 2 === 0;
    if (state === 'waiting_input' || state === 'error') {
      ctx.globalAlpha = blink ? 1 : 0.25;
    }
    ctx.beginPath();
    line(ctx, -19, -8, -12, 0);
    line(ctx, -12, 0, -19, 8);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 右侧内容按状态
    if (state === 'idle' || state === 'working') {
      // 下划线 "_"
      ctx.beginPath();
      line(ctx, -5, 8, 3, 8);
      ctx.stroke();
      if (state === 'working') {
        // 打字块光标（快闪）
        if (Math.floor(t / 260) % 2 === 0) {
          ctx.fillRect(7, -7, 8, 15);
        }
      }
    } else if (state === 'thinking') {
      // 三点轮流亮
      const active = Math.floor(t / 280) % 3;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(-2 + i * 8, 5, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = i === active ? C.prompt : C.promptDim;
        ctx.fill();
      }
      ctx.fillStyle = C.prompt;
    } else if (state === 'done') {
      // 绿色对勾
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      line(ctx, -5, 1, -1, 7);
      line(ctx, -1, 7, 10, -7);
      ctx.stroke();
      ctx.strokeStyle = C.prompt;
    } else if (state === 'waiting_input') {
      // 问号（弧 + 竖线 + 点），随 blink 呼吸
      ctx.beginPath();
      ctx.arc(1, -2, 6, -Math.PI * 0.85, Math.PI * 0.25);
      ctx.stroke();
      ctx.beginPath();
      line(ctx, 6, 1, 1, 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(1, 13, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = blink ? C.prompt : C.promptDim;
      ctx.fill();
      ctx.fillStyle = C.prompt;
    } else if (state === 'error') {
      // 红色 ✕
      ctx.strokeStyle = C.red;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      line(ctx, -5, -7, 7, 7);
      line(ctx, 7, -7, -5, 7);
      ctx.stroke();
      ctx.strokeStyle = C.prompt;
    }
    ctx.restore();
  }

  // ---- 主体绘制（局部坐标：脚底 = y0，向上为负） ----
  function drawMascot(ctx, state, t) {
    // 脚（收在身体正下方）
    ctx.fillStyle = C.deep2;
    roundRectPath(ctx, -20, -10, 18, 10, 5);
    ctx.fill();
    roundRectPath(ctx, 2, -10, 18, 10, 5);
    ctx.fill();

    // 身体（上 8px 藏进头后，下半清晰可见）
    ctx.fillStyle = C.base;
    roundRectPath(ctx, -27, -46, 54, 40, 20);
    ctx.fill();
    // 肚皮暗板 + 小提示符
    ctx.fillStyle = C.deep;
    roundRectPath(ctx, -17, -31, 34, 19, 10);
    ctx.fill();
    ctx.strokeStyle = C.prompt;
    ctx.fillStyle = C.prompt;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    line(ctx, -9, -26, -5, -22);
    line(ctx, -5, -22, -9, -18);
    line(ctx, -2, -18, 3, -18);
    ctx.stroke();

    // 云朵头：整头先铺阴影色 → 上部回填主色（底部留一圈自然阴影）→ 顶部高光
    headPath(ctx);
    ctx.fillStyle = C.deep;
    ctx.fill();
    ctx.save();
    headPath(ctx);
    ctx.clip();
    ctx.fillStyle = C.base;
    ctx.fillRect(-60, -132, 120, 76); // y ∈ [-132,-56] 主色，-56 以下露阴影
    ctx.fillStyle = C.light;
    ctx.globalAlpha = 0.5;
    circle(ctx, -10, -116, 13);
    ctx.fill();
    circle(ctx, -30, -94, 8);
    ctx.fill();
    circle(ctx, 24, -102, 10);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();

    // 终端屏
    drawScreen(ctx, state, t);
  }

  // ---- 光环（waiting / error 脉冲） ----
  function drawHalo(ctx, state, t, s) {
    const isWaiting = state === 'waiting_input';
    if (!isWaiting && state !== 'error') return;
    const phase = (Math.sin(t / (isWaiting ? 300 : 200)) + 1) / 2; // 0..1
    const r = (60 + phase * 9) * s;
    ctx.beginPath();
    ctx.arc(0, -62 * s, r, 0, Math.PI * 2);
    ctx.strokeStyle = isWaiting ? C.halo : C.red;
    ctx.globalAlpha = 0.14 + phase * 0.18;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /**
   * 绘制当前帧；成功返回帧信息（含气泡锚点 / 热区参数），state 非法返回 false。
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} state
   * @param {number} elapsedMs
   * @param {{w:number,h:number}} geom
   */
  function draw(ctx, state, elapsedMs, geom) {
    if (!STATES.includes(state)) return false;
    const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
    const w = geom?.w || 160;
    const h = geom?.h || 160;
    // 缩放基准 = 宠物壳高度（petH，收起态高度）：展开态窗口向上生长变高，但宠物大小锁定不变。
    const base = geom?.petH || h;
    const s = Math.min(w, base) / 160; // 设计稿 160 → 实际画布的缩放
    const { bobY, shakeX, rot, pulse } = pose(state, t);

    const cx = w / 2;
    const cy = h - 6; // 脚底基线

    ctx.save();
    // 光环画在 mascot 后面，跟随 bob
    ctx.translate(cx + shakeX * s, cy + bobY * s);
    drawHalo(ctx, state, t, s);
    ctx.rotate(rot);
    ctx.scale(s, s);
    drawMascot(ctx, state, t);
    ctx.restore();

    return {
      bubblePx: { x: cx, y: Math.max(6, cy + (-132 + bobY) * s) },
      pulse,
      hot: { cx, cy, s, bobY, shakeX },
      geom: { w, h },
    };
  }

  /**
   * 热区命中测试：椭圆 ≈ 云朵头 + 身体范围，pad 外扩（迟滞）。
   * @param {{x:number,y:number}} pointer 画布像素坐标
   * @param {{cx:number,cy:number,s:number,bobY:number,shakeX:number}} hot
   * @param {{pad?:number}} [opts]
   */
  function hotTest(pointer, hot, opts = {}) {
    if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;
    if (!hot || !Number.isFinite(hot.s)) return false;
    const pad = Number.isFinite(opts.pad) ? opts.pad : 8;
    const lx = (pointer.x - hot.cx - hot.shakeX * hot.s) / hot.s;
    const ly = (pointer.y - hot.cy - hot.bobY * hot.s) / hot.s;
    // 局部设计坐标：覆盖 x∈[-56,56], y∈[-130,2] → 椭圆中心 (0,-64)，半轴 (52,70)
    const nx = lx / (52 + pad);
    const ny = (ly + 64) / (68 + pad);
    return nx * nx + ny * ny <= 1;
  }

  window.CodexPet = { draw, hotTest, STATES };
})();
