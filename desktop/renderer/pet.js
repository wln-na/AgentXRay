// 桌面宠物壳渲染入口（renderer）：requestAnimationFrame 循环 + 消费 window.pet 推送。
//
// · 绘制优先级：皮肤帧（PetSpriteRenderer）→ Codex 矢量吉祥物（CodexPet，默认外观）
//   → 内置像素动画（PetPixel，兜底，绝不画空白）。
// · pointer 命中：CodexPet.hotTest()（矢量）或 PetPixel.hotZone()（像素）→ window.pet.setInteractive(bool)。
// · 点击 → window.pet.openSession()（N1：只跳转，永不回复 agent）。
// · 鼠标左键按住拖拽 → window.pet.drag({phase})（移动窗口由主进程按屏幕光标增量完成；
//   位移超阈值才算拖拽，原地点击仍是「跳回会话」）。
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
  let petState = {
    state: 'idle',
    bubble: '空闲',
    platform: null,
    platformLabel: null,
    sessionId: null,
    title: null,
    agent: null,
    activeCount: 0,
    sessions: [],
  };
  let toast = null;
  let wantInteractive = false;
  let dragging = false;
  let suppressClickUntil = 0;
  const pointer = { x: -9999, y: -9999 };
  // 会话卡片展开态与命中区域（每帧由绘制函数回填）。
  let expanded = false;
  let winTall = false; // 窗口是否处于加高态（有气泡内容时加高，与 expanded 布局开关解耦）
  let lastTallRequestAt = 0; // 上次窗口高度请求时间（长高失败的冷却重试用）
  let cardRects = []; // { x, y, w, h, session }
  let expandButtonRect = null; // { x, y, w, h }
  let geomLockUntil = 0; // 收到 pet:geom 后锁定高度自愈的截止时间（避开 setBounds 后的 innerHeight 滞后）

  function applyGeom(geom, grid) {
    if (geom && geom.w > 0 && geom.h > 0 && geom.cell > 0) {
      // petH：宠物壳基准高度（收起态高度），展开态窗口变高但宠物缩放锁定不变。
      // bubbleBelow：气泡向下模式（宠物贴屏幕顶时主进程把窗口向下生长，宠物画到窗口顶部）。
      GEOM = { w: geom.w, h: geom.h, cell: geom.cell, petH: geom.petH || geom.h, bubbleBelow: !!geom.bubbleBelow };
    }
    const gridSize = Number.isFinite(grid) && grid > 0 ? grid : GRID;
    CELL = GEOM.cell;
    OFFX = Math.round((GEOM.w - gridSize * CELL) / 2);
    OFFY = Math.max(24, GEOM.h - gridSize * CELL - 8);
    resize();
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

  // 按像素宽度截断文本（超宽补省略号）。调用前 ctx.font 需先设为 font。
  function fitText(text, font, maxWidth) {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  }

  // 画一张白色胶囊卡片：上行标题（加粗深色），下行「[平台] 状态」（灰色）。
  // 返回命中矩形 {x,y,w,h}。
  const BUBBLE = window.PetBubbleLayout.BUBBLE_LAYOUT;

  function drawCard(card, bubbleX, y) {
    const titleFont = `600 ${BUBBLE.titleFontSize}px -apple-system, "PingFang SC", system-ui, sans-serif`;
    const subFont = `${BUBBLE.subtitleFontSize}px -apple-system, "PingFang SC", system-ui, sans-serif`;
    const padX = BUBBLE.paddingX;
    const maxW = GEOM.w - 6;

    const titleText = card.title || null;
    const subText = card.platformLabel ? `[${card.platformLabel}] ${card.bubble || ''}` : card.bubble || '';

    const sub = fitText(subText, subFont, maxW - padX * 2);
    ctx.font = subFont;
    const subW = ctx.measureText(sub).width;
    let title = null;
    let titleW = 0;
    if (titleText) {
      title = fitText(titleText, titleFont, maxW - padX * 2);
      ctx.font = titleFont;
      titleW = ctx.measureText(title).width;
    }

    const w = Math.min(maxW, Math.max(subW, titleW) + padX * 2);
    const h = BUBBLE.cardHeight;
    const r = h / 2; // 胶囊形
    const x = Math.max(3, Math.min(GEOM.w - w - 3, bubbleX - w / 2));

    // 每张卡片都带灰色阴影 + 灰色描边：叠层/展开时相邻气泡边界清晰可辨。
    ctx.save();
    ctx.shadowColor = 'rgba(100, 116, 139, 0.4)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
    roundRect(x, y, w, h, r);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(107, 114, 128, 0.55)';
    ctx.lineWidth = 1;
    roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r - 0.5);
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (title) {
      ctx.font = titleFont;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(title, x + padX, y + BUBBLE.titleTextY);
      ctx.font = subFont;
      ctx.fillStyle = '#9ca3af';
      ctx.fillText(sub, x + padX, y + BUBBLE.subtitleTextY);
    } else {
      ctx.font = subFont;
      ctx.fillStyle = '#1f2937';
      ctx.fillText(sub, x + padX, y + h / 2 + 0.5);
    }
    return { x, y, w, h };
  }

  // 叠层气泡（类 Codex 桌宠）：
  //  · 收起：最多 3 张重叠（每张下移 20px 露出底行），胜出会话在最前。
  //  · 展开：卡片逐张分开排列，每张可点击跳对应会话；下方圆形箭头按钮收起。
  const BUBBLE_STACK_STEP = BUBBLE.collapsedStackStep;
  const BUBBLE_MAX_COLLAPSED = BUBBLE.maxCollapsed;
  const BUBBLE_MAX_EXPANDED = BUBBLE.maxExpanded;
  const CARD_H = BUBBLE.cardHeight;
  const CARD_GAP = BUBBLE.expandedCardGap;

  function bubbleList() {
    const sessions = Array.isArray(petState.sessions) ? petState.sessions : [];
    if (sessions.length) {
      return sessions.slice(0, expanded ? BUBBLE_MAX_EXPANDED : BUBBLE_MAX_COLLAPSED);
    }
    // 无会话列表数据时的兜底单卡。
    return [{ title: petState.title, platformLabel: petState.platformLabel, bubble: petState.bubble }];
  }

  // 向下气泡模式里宠物贴窗口顶部，脚底线（徽标挂点）在窗口内的 y。
  function petAnchorBelow() {
    return GEOM.petH - 12;
  }

  function drawBubbles(bubbleX, anchorY, now) {
    cardRects = [];
    const activeToast = toast && toast.until > now ? toast.text : null;
    if (!activeToast && currentState === 'idle') return; // idle 不打扰

    // 窗口还没长高（刚请求长高、等几何同步回来）：先不画卡片，避免闪现在窗口顶部。
    if (GEOM.h <= GEOM.petH + 1) return;

    if (activeToast) {
      // toast 锚定在宠物旁边：向上模式贴头顶上方，向下模式贴脚底下方。
      const ty = GEOM.bubbleBelow
        ? Math.min(GEOM.h - CARD_H - 2, petAnchorBelow() + 6)
        : Math.max(4, anchorY != null ? anchorY - 6 - CARD_H : 2);
      const rect = drawCard({ bubble: activeToast }, bubbleX, ty);
      cardRects.push({ ...rect, session: null });
      return;
    }

    const list = bubbleList();
    // 步长：展开 = 卡片完全分开（48 + 12px）；收起 = 重叠叠层（20px 露出底行）。
    // 两种形态都从宠物头顶向上生长：最下面的卡离宠物最近（最新的胜出会话）。
    const step = expanded ? CARD_H + CARD_GAP : BUBBLE_STACK_STEP;
    list.forEach((card, i) => {
      // 无宠物锚点（像素兜底）时退回顶部排列；有锚点则贴宠物头顶向上生长。
      const y = window.PetBubbleLayout.bubbleStackY({
        bubbleBelow: GEOM.bubbleBelow,
        anchorY,
        petAnchorBelow: petAnchorBelow(),
        height: GEOM.h,
        cardHeight: CARD_H,
        step,
        index: i,
        listLength: list.length,
      });
      const rect = drawCard(card, bubbleX, y);
      cardRects.push({ ...rect, session: card.platform ? card : null });
    });
  }

  // 展开/收起按钮：宠物下方白色圆形箭头（≥2 个会话时出现）。
  function drawExpandButton() {
    expandButtonRect = null;
    const sessions = Array.isArray(petState.sessions) ? petState.sessions : [];
    if (sessions.length < 2) return;
    const r = window.PetBubbleLayout.BUBBLE_LAYOUT.expandButtonRadius;
    const badge = window.PetBubbleLayout.badgeCenter({
      width: GEOM.w,
      petHeight: GEOM.petH || GEOM.h,
      height: GEOM.h,
      bubbleBelow: GEOM.bubbleBelow,
    });
    const center = window.PetBubbleLayout.expandButtonCenter({ badgeCenter: badge });
    const cx = center.x;
    const cy = center.y;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.2)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.97)';
    ctx.fill();
    ctx.restore();

    // 箭头：收起时朝下（点开展开），展开时朝上（点回收起）。
    ctx.strokeStyle = '#4b5563';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    if (expanded) {
      ctx.moveTo(cx - 5, cy + 2);
      ctx.lineTo(cx, cy - 3);
      ctx.lineTo(cx + 5, cy + 2);
    } else {
      ctx.moveTo(cx - 5, cy - 2);
      ctx.lineTo(cx, cy + 3);
      ctx.lineTo(cx + 5, cy - 2);
    }
    ctx.stroke();

    expandButtonRect = { x: cx - r, y: cy - r, w: r * 2, h: r * 2 };
  }

  function inRect(p, r) {
    return !!r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  }

  // 指针是否悬在卡片/按钮上（用于请求鼠标穿透开关）。
  function overBubbleUi() {
    if (cardRects.some((r) => inRect(pointer, r))) return true;
    return inRect(pointer, expandButtonRect);
  }

  // 活跃会话数徽标：绿色圆牌白字，挂在右脚边（类 Codex 桌宠）。
  function drawBadge(count) {
    if (!Number.isFinite(count) || count < 1) return;
    // 与吉祥物同一缩放基准（petH），保证展开态窗口变高时徽标仍贴着宠物脚边。
    const center = window.PetBubbleLayout.badgeCenter({
      width: GEOM.w,
      petHeight: GEOM.petH || GEOM.h,
      height: GEOM.h,
      bubbleBelow: GEOM.bubbleBelow,
    });
    const cx = center.x;
    const cy = center.y;
    const r = window.PetBubbleLayout.BUBBLE_LAYOUT.badgeRadius;
    const label = count > 99 ? '99+' : String(count);

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#16a34a';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = `600 ${count > 9 ? 8 : 10}px -apple-system, "PingFang SC", system-ui, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy + 0.5);
    ctx.textAlign = 'left';
  }

  function frame(now) {
    if (!running) return;
    const elapsedMs = now - stateChangedAt;

    // 几何自愈：以窗口真实内尺寸为兜底，防 pet:geom 丢失/错序导致 canvas 与窗口尺寸漂移
    // （曾出现 canvas 停在展开态 372 高而窗口已收起 128，宠物被裁剪到窗口外“隐身”）。
    // 但收到 pet:geom 后 200ms 内锁定高度自愈：setBounds 改高后 window.innerHeight 会滞后数帧，
    // 旧值若覆盖了新高度，长高态被拉回收起态、气泡永久不画。宽度自愈不受锁定影响。
    if (window.innerWidth > 0 && (window.innerWidth !== GEOM.w || (window.innerHeight !== GEOM.h && performance.now() > geomLockUntil))) {
      applyGeom({ w: window.innerWidth, h: window.innerHeight, cell: GEOM.cell, petH: GEOM.petH, bubbleBelow: GEOM.bubbleBelow });
    }

    // 窗口高度仲裁：只要有内容要显示（卡片/toast），窗口就保持高个，给宠物头顶留出气泡空间；
    // 空闲无内容时缩回宠物壳高度。卡片布局（收起叠层/展开分开）由 expanded 单独控制。
    // 带冷却重试：若长高请求发出后窗口实际仍未变高（setBounds 失败/geom 丢失），
    // 每 500ms 重发一次，否则卡片会因“窗口不够高不画”的守卫永远不显示。
    const hasContent = expanded || currentState !== 'idle' || (toast != null && toast.until > now);
    const tallReady = GEOM.h > GEOM.petH + 1;
    // 拖动期间跳过仲裁：主进程拖动会把窗口收拢回宠物壳高度，此时若重发长高请求，
    // 窗口会在 128/372 之间反复跳变（每次 244px），这是拖动卡顿的根源；松手后下一帧自动恢复。
    if (!dragging && (hasContent !== winTall || (hasContent && !tallReady && now - lastTallRequestAt > 500))) {
      winTall = hasContent;
      lastTallRequestAt = now;
      window.pet.setExpanded(winTall);
    }
    // 窗口实际不够高且我们也没在请求长高 → 不可能处于展开态，同步卡片布局，
    // 避免按钮/卡片按展开坐标画到窗口外且无法点击导致状态卡死。
    if (expanded && !winTall) {
      expanded = false;
    }

    ctx.clearRect(0, 0, GEOM.w, GEOM.h);

    // 绘制优先级：皮肤帧 → Codex 矢量吉祥物 → 内置像素（兜底，绝不画空白）。
    let bubbleX = OFFX + 8 * CELL;
    let bubbleAnchorY = null; // 宠物头顶静态锚点（展开卡片贴它向上生长，不随呼吸抖动）
    let drew = false;
    let codexHot = null;

    // 向下气泡模式：整个宠物绘制向上平移到窗口顶部（屏幕上宠物位置不变）。
    const petDy = GEOM.bubbleBelow ? GEOM.petH - GEOM.h : 0;
    let codexInfo = null;
    ctx.save();
    if (petDy) ctx.translate(0, petDy);
    const drewSprite = window.PetSpriteRenderer?.draw(ctx, currentState, elapsedMs, GEOM);
    if (drewSprite) {
      drew = true;
    } else if (window.CodexPet) {
      codexInfo = window.CodexPet.draw(ctx, currentState, elapsedMs, GEOM);
      if (codexInfo) drew = true;
    }

    if (!drew) {
      const frameSpec = window.PetPixel.buildFrame({ state: currentState, elapsedMs, geom: GEOM, grid: GRID });
      drawBuiltin(frameSpec);
      bubbleX = OFFX + frameSpec.bubbleAnchor.x * CELL;
    }
    ctx.restore();

    if (codexInfo) {
      if (petDy) {
        // CodexPet 返回的是平移前坐标，换算回窗口坐标供锚点/热区使用。
        codexInfo.bubblePx = { ...codexInfo.bubblePx, y: codexInfo.bubblePx.y + petDy };
        if (codexInfo.hot) codexInfo.hot = { ...codexInfo.hot, cy: codexInfo.hot.cy + petDy };
      }
      bubbleX = codexInfo.bubblePx.x;
      // 云朵头设计上沿 -132：hot.cy 不含 bobY，锚点静态、卡片不跟着呼吸抖。
      bubbleAnchorY = codexInfo.hot ? codexInfo.hot.cy - 132 * codexInfo.hot.s : null;
      codexHot = codexInfo.hot;
    }

    drawBubbles(bubbleX, bubbleAnchorY, now);
    drawExpandButton();
    drawBadge(petState.activeCount);

    if (!dragging) {
      let inZone;
      if (codexHot) {
        inZone = window.CodexPet.hotTest(pointer, codexHot, { pad: 8 });
      } else {
        // 皮肤帧 / 像素兜底：沿用像素网格热区（历史行为）。
        const frameSpec = window.PetPixel.buildFrame({ state: currentState, elapsedMs, geom: GEOM, grid: GRID });
        inZone = window.PetPixel.hotZone(frameSpec, {
          pointer: { x: pointer.x - OFFX, y: pointer.y - OFFY - petDy },
          cell: CELL,
          pad: 8,
        });
      }
      // 卡片 / 展开按钮同样是可交互区（需要接收点击）。
      if (!inZone) inZone = overBubbleUi();
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
    // 活跃会话少于 2 个时自动收起布局（按钮已隐藏；窗口高度由 frame 仲裁）。
    const count = Array.isArray(petState.sessions) ? petState.sessions.length : 0;
    if (expanded && count < 2) {
      expanded = false;
    }
    if (next.state && next.state !== currentState) {
      currentState = next.state;
      stateChangedAt = performance.now();
    }
  }

  // ---------- 订阅主进程推送 ----------
  window.pet.onState(applyState);
  // 主进程检测到光标离开窗口（在贴边外松手）会强制结束拖拽：同步清理本地拖拽状态，
  // 恢复高度仲裁与点击，宠物留在贴边位置。
  window.pet.onDragCancel(() => {
    dragging = false;
    press = null;
    suppressClickUntil = performance.now() + 400;
  });
  window.pet.onGeom((geom) => {
    applyGeom(geom);
    // setBounds 后 window.innerHeight 会滞后数帧（macOS 上尤其明显），期间若让自愈用旧值
    // 覆盖这里推来的新高度，长高态会被拉回收起态、气泡永远不画。锁定窗口跳过这段滞后。
    geomLockUntil = performance.now() + 200;
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

  // ---------- 拖拽（鼠标左键按住拖动；原地点击 = 跳回会话） ----------
  // 按下时先不进入拖拽：位移超过阈值才真正开始拖（否则松开仍是 click → 打开会话）。
  const DRAG_THRESHOLD = 5; // px
  let press = null; // { x, y, dragging }

  canvas.addEventListener('mousedown', (event) => {
    if (event.button === 1) return; // 中键不参与
    event.preventDefault();
    press = { x: event.clientX, y: event.clientY, dragging: false };
    // 点击宠物即让窗口获得焦点，这样本地 Esc 安全阀才生效。
    window.focus();
  });

  window.addEventListener('mousemove', (event) => {
    if (!press || press.dragging) return;
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      press.dragging = true;
      dragging = true;
      suppressClickUntil = performance.now() + 400;
      window.pet.drag({ phase: 'start' });
    }
  });

  window.addEventListener('mouseup', () => {
    if (!press) return;
    if (press.dragging) {
      dragging = false;
      suppressClickUntil = performance.now() + 400;
      window.pet.drag({ phase: 'end' });
    }
    press = null;
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

  // ---------- 点击分发（N1：只跳转，永不回复） ----------
  function openSessionOf(session) {
    if (!session?.platform || !session.sessionId) return;
    window.pet.openSession({
      platform: session.platform,
      sessionId: session.sessionId,
      agent: session.agent || undefined,
    });
  }

  canvas.addEventListener('click', () => {
    if (performance.now() < suppressClickUntil) return;
    // 展开按钮：切换展开/收起布局（窗口高度由 frame 仲裁，有内容时保持高个）。
    if (inRect(pointer, expandButtonRect)) {
      expanded = !expanded;
      return;
    }
    if (expanded) {
      // 展开态：点哪张卡跳哪个会话。
      const card = cardRects.find((r) => r.session && inRect(pointer, r));
      if (card) {
        openSessionOf(card.session);
        return;
      }
    } else if (cardRects.some((r) => inRect(pointer, r))) {
      // 收起态：点叠层先展开（与 Codex 桌宠一致）。
      expanded = true;
      return;
    }
    // 点宠物本体 → 跳回当前胜出的会话。
    openSessionOf(petState);
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
