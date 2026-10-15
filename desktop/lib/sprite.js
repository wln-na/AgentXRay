// 桌面宠物壳的精灵图包（P4）：pet.json 校验、皮肤发现、帧索引、回退内置。
//
// 目录约定（PRD 固定）：帧文件位于 `<pack>/frames/<state>/*.png`，文件名自然序
// （numeric-aware）即播放顺序。校验时若某 state 无帧文件 → 该 state 视为「未覆盖」，
// 渲染回退内置像素。
//
// UMD 双通道（与 pixel.js 同款）：
//   - Node：module.exports = 全量 API（parseManifest/scanPacks/selectPack/resolveFrame/
//     listStateFrames/triangle/isPathWithin/DEFAULT_STATES），供根 `node --test` 覆盖；
//   - 浏览器：globalThis.PetSprite = { resolveFrame, triangle, DEFAULT_STATES }，只这三个
//     ——renderer/sprite-render.js 的 <script> 只用帧索引，不需要 fs/path（那两个是 Node-only）。
//
// 本文件是【纯模块】：parseManifest/resolveFrame/selectPack/triangle 为纯函数；scanPacks/
// listStateFrames 的 fs 可注入。校验失败只体现在 errors/warnings 里，绝不抛异常。

((root, factory) => {
  // Node 下把 path 注入工厂；浏览器下为 null（Node-only 函数不会被调用）。
  const nodePath = typeof require === 'function' ? require('node:path') : null;
  const api = factory(nodePath);
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api; // Node：全量导出
  }
  if (root && typeof root === 'object') {
    // 浏览器：只挂帧索引相关的三个（renderer 的 sprite-render.js 只用它们）。
    root.PetSprite = {
      DEFAULT_STATES: api.DEFAULT_STATES,
      resolveFrame: api.resolveFrame,
      triangle: api.triangle,
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, (path) => {
  // 与 desktop/lib/config.js 的 PET_STATES 一致（此处内联以避免循环依赖；调用方可覆盖）。
  const DEFAULT_STATES = Object.freeze(['idle', 'thinking', 'working', 'done', 'waiting_input', 'error']);

  function isPathWithin(parent, child) {
    const p = path.resolve(parent);
    const c = path.resolve(child);
    return c === p || c.startsWith(p + path.sep);
  }

  function isFps(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 60;
  }

  function isUnit(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  }

  /** 自然序（numeric-aware）比较：使 `2.png` 排在 `10.png` 之前。 */
  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /**
   * 纯校验：把 pet.json 文本规范化成 NormalizedManifest。
   *
   * @param {string} raw  UTF-8 字符串
   * @param {object} [opts]
   * @param {string} [opts.dir]    pet.json 所在目录（用于把相对 dir 解析成绝对并做逃逸检查）
   * @param {string[]} [opts.states] 合法 state 键集合（默认 6 态）
   * @returns {{ok: boolean, manifest: object|null, errors: string[], warnings: string[]}}
   */
  function parseManifest(raw, opts = {}) {
    const dir = typeof opts.dir === 'string' && opts.dir ? opts.dir : '';
    const states = opts.states || DEFAULT_STATES;
    const errors = [];
    const warnings = [];

    const fail = () => ({ ok: false, manifest: null, errors, warnings });

    if (typeof raw !== 'string') {
      errors.push('pet.json: 内容必须是字符串');
      return fail();
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      errors.push(`pet.json: 不是合法的 JSON（${err?.message ? err.message : err}）`);
      return fail();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      errors.push('pet.json: 顶层必须是一个对象');
      return fail();
    }

    // name：必填 1–64 字。
    if (typeof data.name !== 'string' || data.name.length < 1 || data.name.length > 64) {
      errors.push('pet.json: "name" 必须是 1–64 字的字符串');
    }

    // version：可选整数，默认 1；保留真实值不归一（丢掉信息更糟），非 1 仅告警。
    let version = 1;
    if (data.version !== undefined) {
      if (!Number.isInteger(data.version) || data.version < 1) {
        errors.push('pet.json: "version" 必须是正整数');
      } else {
        version = data.version;
        if (version !== 1) {
          warnings.push(`pet.json: 未知的包格式版本 ${version}，将按当前版本(1)的字段规则解析`);
        }
      }
    }

    // fps：必填 1–60。
    if (!isFps(data.fps)) {
      errors.push('pet.json: "fps" 必须是 1–60 的数字');
    }

    // loop：可选布尔，默认 true。
    let loop = true;
    if (data.loop !== undefined) {
      if (typeof data.loop !== 'boolean') errors.push('pet.json: "loop" 必须是布尔值');
      else loop = data.loop;
    }

    // scale：可选整数 1–8，默认 2。
    let scale = 2;
    if (data.scale !== undefined) {
      if (!Number.isInteger(data.scale) || data.scale < 1 || data.scale > 8) {
        errors.push('pet.json: "scale" 必须是 1–8 的整数');
      } else {
        scale = data.scale;
      }
    }

    // anchor：可选 {x,y} 各 0–1，默认 {0.5, 1.0}。
    let anchor = { x: 0.5, y: 1.0 };
    if (data.anchor !== undefined) {
      const a = data.anchor;
      if (!a || typeof a !== 'object' || Array.isArray(a) || !isUnit(a.x) || !isUnit(a.y)) {
        errors.push('pet.json: "anchor" 必须是 {x:0–1, y:0–1}');
      } else {
        anchor = { x: a.x, y: a.y };
      }
    }

    // states：可选对象；键必须是 state 子集，未知键→warning。
    const normStates = {};
    const known = new Set(states);
    if (data.states !== undefined) {
      if (!data.states || typeof data.states !== 'object' || Array.isArray(data.states)) {
        errors.push('pet.json: "states" 必须是一个对象');
      } else {
        for (const [key, val] of Object.entries(data.states)) {
          if (!known.has(key)) {
            warnings.push(`pet.json: 未知的 state 键 "${key}"，已忽略`);
            continue;
          }
          if (!val || typeof val !== 'object' || Array.isArray(val)) {
            errors.push(`pet.json: states.${key} 必须是一个对象`);
            continue;
          }

          // dir：可选，默认 "frames/<state>"；禁止 .. 逃逸。
          let relDir = val.dir === undefined ? path.join('frames', key) : val.dir;
          if (typeof relDir !== 'string' || relDir.length === 0) {
            errors.push(`pet.json: states.${key}.dir 必须是非空字符串`);
            relDir = path.join('frames', key);
          }
          if (String(relDir).split(/[\\/]/).includes('..')) {
            errors.push(`pet.json: states.${key}.dir 不允许包含 ".."`);
          }
          let absDir;
          if (dir) {
            absDir = path.resolve(dir, relDir);
            if (!isPathWithin(dir, absDir)) {
              errors.push(`pet.json: states.${key}.dir "${relDir}" 逃逸出皮肤目录`);
            }
          } else {
            absDir = relDir;
          }

          // fps：可选，覆盖全局。
          let stFps = data.fps;
          if (val.fps !== undefined) {
            if (!isFps(val.fps)) errors.push(`pet.json: states.${key}.fps 必须是 1–60 的数字`);
            else stFps = val.fps;
          }

          // loop：可选，默认继承全局。
          let stLoop = loop;
          if (val.loop !== undefined) {
            if (typeof val.loop !== 'boolean') errors.push(`pet.json: states.${key}.loop 必须是布尔值`);
            else stLoop = val.loop;
          }

          // pingpong：可选，默认 false。
          let stPingpong = false;
          if (val.pingpong !== undefined) {
            if (typeof val.pingpong !== 'boolean') errors.push(`pet.json: states.${key}.pingpong 必须是布尔值`);
            else stPingpong = val.pingpong;
          }

          normStates[key] = { dir: absDir, relDir, fps: stFps, loop: stLoop, pingpong: stPingpong };
        }
      }
    }

    if (errors.length) return fail();

    const manifest = {
      name: data.name,
      version,
      fps: data.fps,
      loop,
      scale,
      anchor,
      states: normStates,
      dir: dir || undefined,
    };
    return { ok: true, manifest, errors, warnings };
  }

  /**
   * 纯：扫描 <petsDir>/<name>/pet.json，返回可用皮肤列表（校验失败的跳过并告警）。
   *
   * @param {string} petsDir
   * @param {object} [opts]
   * @param {object} [opts.fs]  fs/promises 兼容对象（默认 require('node:fs')，内部取 .promises）
   * @param {string[]} [opts.states]
   * @returns {Promise<Array<{name: string, path: string, manifest: object, mtimeMs: number}>>}
   */
  async function scanPacks(petsDir, opts = {}) {
    const fs = opts.fs || require('node:fs');
    const fsp = fs?.promises ? fs.promises : fs;
    const states = opts.states || DEFAULT_STATES;

    let entries;
    try {
      entries = await fsp.readdir(petsDir, { withFileTypes: true });
    } catch {
      return []; // 目录不存在 → 无自定义皮肤。
    }

    const packs = [];
    for (const entry of entries || []) {
      if (!entry?.isDirectory?.()) continue;
      const packDir = path.join(petsDir, entry.name);
      const manifestPath = path.join(packDir, 'pet.json');
      let raw;
      let mtimeMs = 0;
      try {
        raw = await fsp.readFile(manifestPath, 'utf8');
      } catch {
        continue;
      }
      try {
        const stat = await fsp.stat(manifestPath);
        mtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0;
      } catch {
        mtimeMs = 0;
      }
      const result = parseManifest(raw, { dir: packDir, states });
      if (!result.ok) {
        const first = result.errors[0] || '未知错误';
        console.warn(`[pet:sprite] 跳过无效皮肤 ${entry.name}：${first}`);
        continue;
      }
      packs.push({ name: entry.name, path: packDir, manifest: result.manifest, mtimeMs });
    }
    return packs;
  }

  /**
   * Node-only：列出某 state 目录下全部 `*.png` 的**绝对路径**，按自然序排序；
   * 目录不存在 → 返回 []。
   *
   * @param {string} stateDir
   * @param {object} [opts]
   * @param {object} [opts.fs]
   * @returns {Promise<string[]>}
   */
  async function listStateFrames(stateDir, opts = {}) {
    const fs = opts.fs || require('node:fs');
    const fsp = fs?.promises ? fs.promises : fs;
    let entries;
    try {
      entries = await fsp.readdir(stateDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const names = (entries || [])
      .filter((e) => e && typeof e.isFile === 'function' && e.isFile() && String(e.name).toLowerCase().endsWith('.png'))
      .map((e) => e.name);
    names.sort(naturalCompare);
    return names.map((n) => path.join(stateDir, n));
  }

  /**
   * 纯：选择要用的皮肤（优先级：requested > recent > first > builtin）。
   *
   * @param {object} opts
   * @param {string} [opts.requested] AGENTXRAY_PET_PACK（皮肤名或绝对路径）
   * @param {Array} [opts.packs]       scanPacks 的结果
   * @param {string} [opts.fallback='builtin']
   * @returns {{source: 'requested'|'recent'|'first'|'builtin', pack?: object}}
   */
  function selectPack(opts = {}) {
    const list = Array.isArray(opts.packs) ? opts.packs.filter(Boolean) : [];
    const requested = opts.requested;

    if (requested) {
      const match = list.find((p) => p.name === requested || p.path === requested);
      if (match) return { source: 'requested', pack: match };
    }

    if (list.length > 0) {
      const withMtime = list.filter((p) => Number.isFinite(p.mtimeMs));
      if (withMtime.length > 0) {
        const recent = withMtime.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
        return { source: 'recent', pack: recent };
      }
      const first = [...list].sort((a, b) => naturalCompare(a.name, b.name))[0];
      return { source: 'first', pack: first };
    }

    return { source: opts.fallback || 'builtin' };
  }

  /** 往复（三角形）索引：0..m-1..1..0… */
  function triangle(n, m) {
    if (m <= 1) return 0;
    const period = 2 * (m - 1);
    const pos = ((n % period) + period) % period;
    return pos < m ? pos : period - pos;
  }

  /**
   * 纯：给定皮肤 + 状态 + 已播放时长 → 帧索引。
   *
   * 保证：只要 frameCount>0，返回的 index 恒落在 `[0, frameCount-1]`（loop=false 且 elapsedMs
   * 为负也会被夹到 0）；`-1` 仅保留给 `frameCount<=0` 或 manifest 非对象的退化情形。
   *
   * @param {object} manifest parseManifest 产出的 NormalizedManifest
   * @param {string} state
   * @param {number} elapsedMs
   * @param {number} frameCount
   * @returns {{index: number, fps: number, loop: boolean, pingpong: boolean}}
   */
  function resolveFrame(manifest, state, elapsedMs, frameCount) {
    if (!manifest || typeof manifest !== 'object') {
      return { index: -1, fps: 0, loop: false, pingpong: false };
    }
    const st = manifest.states?.[state] || null;
    const fps = st && Number.isFinite(st.fps) ? st.fps : manifest.fps;
    const loop =
      st && typeof st.loop === 'boolean' ? st.loop : typeof manifest.loop === 'boolean' ? manifest.loop : true;
    const pingpong = !!(st && typeof st.pingpong === 'boolean' ? st.pingpong : false);

    if (!Number.isFinite(frameCount) || frameCount <= 0) {
      return { index: -1, fps: Number.isFinite(fps) ? fps : 0, loop, pingpong };
    }
    if (!Number.isFinite(fps) || fps <= 0) {
      return { index: 0, fps: 0, loop, pingpong };
    }

    const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;
    const raw = Math.floor((t / 1000) * fps);

    let index;
    if (loop === false) {
      // 停在末帧；夹到 [0, frameCount-1]——负 elapsedMs 会让 raw 为负，不加下界会产出负索引。
      index = Math.max(0, Math.min(raw, frameCount - 1));
    } else if (pingpong) {
      index = triangle(raw, frameCount);
    } else {
      index = ((raw % frameCount) + frameCount) % frameCount;
    }
    return { index, fps, loop, pingpong };
  }

  return {
    DEFAULT_STATES,
    isPathWithin,
    naturalCompare,
    parseManifest,
    scanPacks,
    listStateFrames,
    selectPack,
    resolveFrame,
    triangle,
  };
});
