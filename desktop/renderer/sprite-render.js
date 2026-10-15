// 精灵图帧渲染（renderer）：把 PetSprite.resolveFrame 选中的帧画到 canvas。
//
// 复用 desktop/lib/sprite.js 的 UMD 浏览器分支（globalThis.PetSprite）——零构建、零 require。
// 契约：manifest===null、某 state 无帧、或 resolveFrame 返回 index===-1 → draw() 返回 false，
// 调用方（pet.js）回退到内置像素动画，绝不画空白。

(() => {
  const cache = new Map(); // url -> { img, ready }
  let skin = null; // { manifest, frames: Record<state, string[]> }
  let scale = 2;
  let anchor = { x: 0.5, y: 1.0 };

  function ensureImage(url) {
    const hit = cache.get(url);
    if (hit) return hit;
    const entry = { img: new Image(), ready: false };
    entry.img.onload = () => {
      entry.ready = true;
    };
    entry.img.onerror = () => {
      entry.ready = false;
    };
    entry.img.src = url;
    cache.set(url, entry);
    return entry;
  }

  function preload() {
    if (!skin?.frames) return;
    for (const list of Object.values(skin.frames)) {
      for (const url of list || []) ensureImage(url);
    }
  }

  /** 主进程经 get-info 下发的皮肤 payload。 */
  function configure(info) {
    skin = info?.skin ? info.skin : null;
    if (skin?.manifest) {
      scale = Number.isFinite(skin.manifest.scale) ? skin.manifest.scale : 2;
      if (skin.manifest.anchor) anchor = skin.manifest.anchor;
    }
    preload();
  }

  /** 当前状态应显示的帧 URL；无皮肤/无帧/索引越界 → null（回退内置）。 */
  function pickFrameUrl(state, elapsedMs) {
    if (!skin?.manifest) return null;
    const frames = skin.frames?.[state] || [];
    if (frames.length === 0) return null;
    const rf = window.PetSprite.resolveFrame(skin.manifest, state, elapsedMs, frames.length);
    if (!rf || rf.index < 0 || rf.index >= frames.length) return null;
    return frames[rf.index] || null;
  }

  /**
   * 尝试用皮肤帧绘制；成功返回 true，否则 false（调用方回退内置像素）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {string} state
   * @param {number} elapsedMs
   * @param {{w:number,h:number}} geom
   */
  function draw(ctx, state, elapsedMs, geom) {
    const url = pickFrameUrl(state, elapsedMs);
    if (!url) return false;
    const entry = ensureImage(url);
    if (!entry.ready) return false; // 尚未解码完成 → 先用内置像素顶着
    const img = entry.img;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    if (w <= 0 || h <= 0) return false;
    const x = geom.w * anchor.x - w * anchor.x;
    const y = geom.h * anchor.y - h * anchor.y;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, x, y, w, h);
    return true;
  }

  window.PetSpriteRenderer = { configure, pickFrameUrl, draw };
})();
