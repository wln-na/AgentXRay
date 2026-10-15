// 桌面宠物壳渲染入口（renderer）：requestAnimationFrame 循环 + 消费 window.pet 推送。
//
// · 每帧调 PetPixel.buildFrame() 画内置像素动画；若皮肤可用则由 PetSpriteRenderer.draw 优先画帧。
// · pointer 用 PetPixel.hotZone() 做命中 → window.pet.setInteractive(bool) 请求可交互。
// · 点击 → window.pet.openSession()（N1：只跳转，永不回复 agent）。
// · ⌘ / 右键拖拽 → window.pet.drag({phase})（移动窗口由主进程按屏幕光标增量完成）。
//
// 无 Node、无 electron、无网络、无 require（只经 window.pet 与 DOM/Canvas）。

(() => {
  const canvas = document.getElementById('pet-canvas');
  const ctx = canvas.getContext('2d');

  const GRID = 16;
  let CELL = 6;
  let GEOM = { w: 160, h: 160, cell: 6 };
  let OFFX = 32;
  let OFFY = 56;

  let dpr = window.devicePixelRatio || 1;
  let running = true;
  let currentState = 'idle';
  let stateChangedAt = performance.now();
  let petState = { state: 'idle', bubble: '空闲', platform: null, sessionId: null, agent: null };
  let connected = false;
  let toast = null;
  let wantInteractive = false;
  let dragging = false;
  let suppressClickUntil = 0;
  const pointer = { x: -9999, y: -9999 };

  const CELL_COLORS = () => window.PetPixel?.PALETTE || {};

  function applyGeom(geom, grid) {
    if (geom && geom.w > 0 && geom.h > 0 && geom.cell > 0) GEOM = { w: geom.w, h: geom.h, cell: geom.cell };
    const gridSize = Number.isFinite(grid) && grid > 0 ? grid : GRID;
    CELL = GEOM.cell;
    OFFX = Math.round((GEOM.w - gridSize * CELL) / 2);
    OFFY = Math.max(24, GEOM.h - gridSize * CELL - 8);
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(GEOM.w * dpr);
    canvas.height = Math.round(GEOM.h * dpr);
    canvas.style.width = `${GEOM.w}px`;
    canvas.style.height = `${GEOM.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawBuiltin(frameSpec) {
    for (const c of frameSpec.cells) {
      ctx.fillStyle = c.color;
      ctx.fillRect(OFFX + c.x * CELL, OFFY + c.y * CELL + frameSpec.bounceY, c.w * CELL, c.h * CELL);
    }
    if (frameSpec.pulse) {
      const cx = OFFX + 8 * CELL;
      const cy = OFFY + 8 * CELL + frameSpec.bounceY;
      const r = 40 + Math.sin(performance.now() / 200) * 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.55)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  function drawBubble(frameSpec, now) {
    const activeToast = toast && toast.until > now ? toast.text : null;
    const text = activeToast || petState.bubble || '';
    if (!text) return;
    if (!activeToast && currentState === 'idle') return; // idle 不打扰，不显示气泡

    const label = text.length > 18 ? `${text.slice(0, 17)}…` : text;
    ctx.font = '11px -apple-system, "PingFang SC", system-ui, sans-serif';
    const padX = 6;
    const h = 18;
    const tw = ctx.measureText(label).width;
    const w = Math.min(GEOM.w - 6, tw + padX * 2);
    const x = Math.max(3, Math.min(GEOM.w - w - 3, OFFX + frameSpec.bubbleAnchor.x * CELL - w / 2));
    const y = 4;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
    roundRect(x, y, w, h, 6);
    ctx.fill();

    const palette = CELL_COLORS()[currentState] || {};
    ctx.fillStyle = palette.accent || '#e5e7eb';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + padX, y + h / 2 + 0.5);
  }

  function drawConnectivityDot() {
    ctx.beginPath();
    ctx.arc(8, GEOM.h - 8, 3, 0, Math.PI * 2);
    ctx.fillStyle = connected ? '#34d399' : '#64748b';
    ctx.fill();
  }

  function frame(now) {
    if (!running) return;
    const elapsedMs = now - stateChangedAt;
    const frameSpec = window.PetPixel.buildFrame({ state: currentState, elapsedMs, geom: GEOM, grid: GRID });

    ctx.clearRect(0, 0, GEOM.w, GEOM.h);

    const drewSprite = window.PetSpriteRenderer?.draw(ctx, currentState, elapsedMs, GEOM);
    if (!drewSprite) drawBuiltin(frameSpec);

    drawBubble(frameSpec, now);
    drawConnectivityDot();

    if (!dragging) {
      const inZone = window.PetPixel.hotZone(frameSpec, {
        pointer: { x: pointer.x - OFFX, y: pointer.y - OFFY },
        cell: CELL,
        pad: 8,
      });
      if (inZone !== wantInteractive) {
        wantInteractive = inZone;
        window.pet.setInteractive(inZone);
      }
    }

    requestAnimationFrame(frame);
  }

  function applyState(next) {
    if (!next || typeof next !== 'object') return;
    petState = Object.assign({}, petState, next);
    if (next.state && next.state !== currentState) {
      currentState = next.state;
      stateChangedAt = performance.now();
    }
  }

  // ---------- 订阅主进程推送 ----------
  window.pet.onState(applyState);
  window.pet.onStatus((status) => {
    connected = !!status?.connected;
  });
  window.pet.onFullscreen(({ hidden }) => {
    if (hidden && running) {
      running = false;
    } else if (!hidden && !running) {
      running = true;
      requestAnimationFrame(frame);
    }
  });
  window.pet.onOpenResult((result) => {
    const text = result?.ok ? result.detail || '已跳转会话' : result?.error || '跳转失败';
    toast = { text, until: performance.now() + 3000 };
  });

  // ---------- 指针 / 命中 ----------
  window.addEventListener('mousemove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  });
  window.addEventListener('mouseleave', () => {
    pointer.x = -9999;
    pointer.y = -9999;
  });

  // ---------- 拖拽（⌘ / 右键） ----------
  canvas.addEventListener('mousedown', (event) => {
    if (event.metaKey || event.button === 2) {
      event.preventDefault();
      dragging = true;
      suppressClickUntil = performance.now() + 400;
      window.pet.drag({ phase: 'start' });
    } else {
      // 点击宠物即让窗口获得焦点，这样本地 Esc 安全阀才生效。
      window.focus();
    }
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      suppressClickUntil = performance.now() + 400;
      window.pet.drag({ phase: 'end' });
    }
  });
  window.addEventListener('contextmenu', (event) => event.preventDefault());

  // ---------- 本地 Esc 安全阀（不用全局快捷键） ----------
  // 点宠物获得焦点后按 Esc → 立即恢复穿透；复用现有 setInteractive 通道，不新增 IPC。
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      wantInteractive = false;
      window.pet.setInteractive(false);
    }
  });

  // ---------- 点击 → 跳回会话（N1：只跳转，永不回复） ----------
  canvas.addEventListener('click', () => {
    if (performance.now() < suppressClickUntil) return;
    if (!petState.platform || !petState.sessionId) return;
    window.pet.openSession({
      platform: petState.platform,
      sessionId: petState.sessionId,
      agent: petState.agent || undefined,
    });
  });

  // ---------- 启动 ----------
  window.pet
    .getInfo()
    .then((info) => {
      applyGeom(info?.geom, info?.grid);
      if (window.PetSpriteRenderer) window.PetSpriteRenderer.configure(info);
      resize();
      requestAnimationFrame(frame);
    })
    .catch(() => {
      resize();
      requestAnimationFrame(frame);
    });

  window.addEventListener('resize', () => {
    resize();
  });
})();
