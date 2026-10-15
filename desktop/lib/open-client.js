// 桌面宠物壳的点击跳回（P3，复用现有路由，不改后端）。
//
// 点击宠物 = 跳到原会话（复用 POST .../sessions/:id/open），AgentXRay 是只读查看器。
// N1 铁律：只发 action（open/locate），**永不**携带任何内容回复；fallback 交给系统剪贴板。
//
// 本文件是【纯模块】：httpRequest 可注入，测试用假实现，绝不真连 3800。

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3800;

/**
 * 纯：构造与现有路由匹配的请求（不改后端）。
 * openclaw → /api/agents/:agent/sessions/:id/open（与 frontend/src/api/client.ts 判断一致）
 * 其它     → /api/:platform/sessions/:id/open
 *
 * @param {object} opts
 * @param {string} opts.platform
 * @param {string} opts.sessionId
 * @param {string} [opts.agent]
 * @param {'open'|'locate'} [opts.action='open']
 * @returns {{method: 'POST', path: string, body: {action: string}}}
 */
function buildOpenRequest(opts = {}) {
  const action = opts.action === 'locate' ? 'locate' : 'open';
  const sessionId = encodeURIComponent(opts.sessionId);
  const path =
    opts.platform === 'openclaw'
      ? `/api/agents/${encodeURIComponent(opts.agent || '')}/sessions/${sessionId}/open`
      : `/api/${opts.platform}/sessions/${sessionId}/open`;
  // body 只含 action：绝不携带任何内容回复（N1）。
  return { method: 'POST', path, body: { action } };
}

/**
 * 可注入 transport 的客户端：真正发起请求（默认 Node http.request 到 host:port）。
 *
 * @param {object} [opts]
 * @param {string} [opts.host]
 * @param {number} [opts.port]
 * @param {Function} [opts.httpRequest] 与 http.request 兼容的 (opts, cb) => req
 * @param {Function} [opts.onResult]    (result) => void
 * @param {Function} [opts.onError]     (err) => void
 * @returns {{open: Function, locate: Function, copyFallback: Function}}
 */
function createOpenClient(opts = {}) {
  const host = opts.host || process.env.AGENTXRAY_PET_HOST || DEFAULT_HOST;
  const port = opts.port || Number(process.env.AGENTXRAY_PET_PORT) || DEFAULT_PORT;
  const httpRequest = opts.httpRequest || require('node:http').request;
  const onResult = opts.onResult || (() => {});
  const onError = opts.onError || (() => {});

  function request(pathStr, body) {
    return new Promise((resolve) => {
      let settled = false;
      const resolveOnce = (result) => {
        if (settled) return;
        settled = true;
        onResult(result);
        resolve(result);
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        const error = err instanceof Error ? err : new Error(String(err));
        onError(error);
        resolve({ ok: false, error: error.message });
      };

      let req;
      try {
        req = httpRequest(
          {
            host,
            port,
            path: pathStr,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            let chunks = '';
            if (!res || typeof res.on !== 'function') {
              resolveOnce({ ok: false, error: '无响应' });
              return;
            }
            res.on('data', (chunk) => {
              chunks += chunk;
            });
            res.on('end', () => {
              try {
                const parsed = chunks ? JSON.parse(chunks) : {};
                resolveOnce(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: '响应不是对象' });
              } catch (err) {
                fail(new Error(`响应解析失败：${err?.message ? err.message : err}`));
              }
            });
            res.on('error', fail);
          }
        );
        if (req && typeof req.on === 'function') {
          req.on('error', fail);
        }
        if (req && typeof req.write === 'function') {
          req.write(JSON.stringify(body));
        }
        if (req && typeof req.end === 'function') {
          req.end();
        }
      } catch (err) {
        fail(err);
      }
    });
  }

  return {
    open(payload = {}) {
      const { path: reqPath, body } = buildOpenRequest({ ...payload, action: payload.action || 'open' });
      return request(reqPath, body);
    },
    locate(payload = {}) {
      const { path: reqPath, body } = buildOpenRequest({ ...payload, action: 'locate' });
      return request(reqPath, body);
    },
    /** 返回 fallback.path / fallback.command 供剪贴板；无则 null。 */
    copyFallback(result) {
      const fb = result?.fallback;
      if (!fb) return null;
      return fb.path || fb.command || null;
    },
  };
}

module.exports = {
  buildOpenRequest,
  createOpenClient,
};
