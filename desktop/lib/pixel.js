// 桌面宠物壳的内置像素动画（零图片资源）。
//
// 在 16×16 逻辑像素网格上，用「帧规范」描述要画的矩形，renderer 用 Canvas
// fillRect 逐格落笔（imageSmoothingEnabled=false 放大得到像素风）。
//
// UMD 双通道：Node 下 module.exports；浏览器 <script src="../lib/pixel.js"> 下挂
// globalThis.PetPixel。renderer/index.html 直接复用同一文件，靠特性检测分支，
// 不使用 require——一套代码，两条通道，零构建。
//
// 色系对齐 frontend/src/components/PetWidget.tsx 的 PET_META：
//   idle → slate ; thinking → sky ; working → amber ; done → emerald ;
//   waiting_input → red-500(pulse) ; error → red-600(pulse)

((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
  if (root && typeof root === 'object') {
    root.PetPixel = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  // 6 个状态全覆盖；缺一即单测失败（见 test/pet-shell-pixel.test.js）。
  const PALETTE = {
    idle: { base: '#64748b', accent: '#94a3b8', eye: '#0f172a', mood: '#cbd5e1' },
    thinking: { base: '#0ea5e9', accent: '#7dd3fc', eye: '#0c4a6e', mood: '#bae6fd' },
    working: { base: '#f59e0b', accent: '#fcd34d', eye: '#78350f', mood: '#fde68a' },
    done: { base: '#10b981', accent: '#6ee7b7', eye: '#064e3b', mood: '#a7f3d0' },
    waiting_input: { base: '#ef4444', accent: '#fca5a5', eye: '#450a0a', mood: '#fecaca' },
    error: { base: '#dc2626', accent: '#fca5a5', eye: '#450a0a', mood: '#fecaca' },
  };

  const BODY = { left: 3, right: 12, top: 4, bottom: 12 };

  /** 圆角身体的不透明格（逻辑坐标）。命中格即取此集合。 */
  function bodyShape() {
    const out = [];
    for (let y = BODY.top; y <= BODY.bottom; y++) {
      for (let x = BODY.left; x <= BODY.right; x++) {
        const cornerX = x < BODY.left + 2 || x > BODY.right - 2;
        const cornerY = y < BODY.top + 2 || y > BODY.bottom - 2;
        if (cornerX && cornerY) continue; // 去掉四角，做出圆润轮廓
        out.push({ x, y, w: 1, h: 1 });
      }
    }
    return out;
  }

  function eyeShape() {
    return [
      { x: 5, y: 6, w: 2, h: 2 },
      { x: 9, y: 6, w: 2, h: 2 },
    ];
  }

  const BELLY = { x: 6, y: 9, w: 4, h: 2 };
  const BUBBLE_ANCHOR = { x: (BODY.left + BODY.right + 1) / 2, y: BODY.top };

  /**
   * 纯：输出「帧规范」——一组待绘制图元 + 弹跳/脉冲参数；不含任何 canvas API。
   *
   * @param {object} input
   * @param {string} input.state       PetStateName
   * @param {number} [input.elapsedMs] 已播放时长（驱动动画相位）
   * @param {{w:number,h:number,cell:number}} [input.geom]
   * @param {number} [input.grid]
   * @returns {{cells: Array<{x,y,w,h,color}>, bubbleAnchor: {x,y},
   *            hitCells: Array<{x,y,w,h}>, bounceY: number, pulse: boolean, state: string}}
   */
  function buildFrame(input = {}) {
    const requested = input.state;
    const state = Object.hasOwn(PALETTE, requested) ? requested : 'idle';
    const palette = PALETTE[state];
    const t = Number.isFinite(input.elapsedMs) ? input.elapsedMs : 0;

    const body = bodyShape();
    const eyes = eyeShape();
    const cells = [];

    // 状态专属运动参数。
    let bounceY = 0;
    let shakeX = 0;
    let pulse = false;
    if (state === 'idle') {
      bounceY = Math.sin((t / 1500) * Math.PI * 2) * 1; // 缓慢呼吸 ±1px
    } else if (state === 'waiting_input') {
      bounceY = Math.abs(Math.sin(t / 250)) * 6; // 明显上下弹跳
      pulse = true;
    } else if (state === 'error') {
      shakeX = Math.round(Math.sin(t / 60) * 1.5); // 左右抖动
      pulse = true;
    }

    // 绘制顺序：身体 → 肚皮 → 眼睛 → 状态装饰。
    for (const c of body) {
      cells.push({ x: c.x + shakeX, y: c.y, w: c.w, h: c.h, color: palette.base });
    }
    cells.push({ x: BELLY.x + shakeX, y: BELLY.y, w: BELLY.w, h: BELLY.h, color: palette.accent });
    for (const e of eyes) {
      cells.push({ x: e.x + shakeX, y: e.y, w: e.w, h: e.h, color: palette.eye });
    }

    if (state === 'thinking') {
      // 头顶三点「…」闪烁。
      const active = Math.floor(t / 300) % 3;
      for (let i = 0; i < 3; i++) {
        cells.push({
          x: 6 + i * 2 + shakeX,
          y: 2,
          w: 1,
          h: 1,
          color: i === active ? palette.accent : palette.mood,
        });
      }
    } else if (state === 'working') {
      // 环绕一个旋转点（相位 = elapsedMs）。
      const angle = t / 400;
      const ox = Math.min(15, Math.max(0, Math.round(8 + 6.5 * Math.cos(angle))));
      const oy = Math.min(15, Math.max(0, Math.round(8 + 6.5 * Math.sin(angle))));
      cells.push({ x: ox, y: oy, w: 1, h: 1, color: palette.accent });
    } else if (state === 'done' && t < 800) {
      // 短暂「✓」弹出。
      const check = [
        { x: 9, y: 4 },
        { x: 10, y: 3 },
        { x: 11, y: 2 },
        { x: 12, y: 1 },
      ];
      for (const c of check) {
        cells.push({ x: c.x + shakeX, y: c.y, w: 1, h: 1, color: palette.accent });
      }
    }

    const hitCells = body.map((c) => ({ x: c.x + shakeX, y: c.y, w: c.w, h: c.h }));

    return {
      cells,
      bubbleAnchor: { x: BUBBLE_ANCHOR.x + shakeX, y: BUBBLE_ANCHOR.y },
      hitCells,
      bounceY,
      pulse,
      state,
    };
  }

  /**
   * 纯：pointer → 是否落在宠物热区（命中测试，供 click-through 仲裁）。
   *
   * @param {object} frameSpec buildFrame 的返回
   * @param {object} opts
   * @param {{x:number,y:number}} opts.pointer 画布像素坐标
   * @param {number} [opts.cell=4] 逻辑格 → 像素的放大倍数
   * @param {number} [opts.pad=8]  热区外扩像素（迟滞）
   * @returns {boolean}
   */
  function hotZone(frameSpec, opts = {}) {
    if (!frameSpec || !Array.isArray(frameSpec.hitCells)) return false;
    const pointer = opts.pointer;
    if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return false;

    const cell = Number.isFinite(opts.cell) && opts.cell > 0 ? opts.cell : 4;
    const pad = Number.isFinite(opts.pad) ? opts.pad : 8;
    const bounceY = Number.isFinite(frameSpec.bounceY) ? frameSpec.bounceY : 0;

    const lx = pointer.x / cell;
    const ly = (pointer.y - bounceY) / cell;
    const padCells = pad / cell;

    return frameSpec.hitCells.some(
      (c) => lx >= c.x - padCells && lx <= c.x + c.w + padCells && ly >= c.y - padCells && ly <= c.y + c.h + padCells
    );
  }

  return { PALETTE, buildFrame, hotZone };
});
