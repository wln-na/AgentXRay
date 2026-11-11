const { runLlmDetailed, llmBackend, loadLlmConfig } = require('../llm');
const { parseLlmJson } = require('../llm-json');
const crypto = require('node:crypto');
const evals = require('../evals');

// Eval loop routes: manual annotations, LLM-as-judge scoring, regression set.
// Business rules live in lib/evals.js; routes validate parameters and shape
// responses only.

const PLATFORM_RE = /^[a-z0-9-]{1,32}$/;

function cleanPlatform(value) {
  const s = String(value || '').toLowerCase();
  return PLATFORM_RE.test(s) ? s : null;
}

function cleanSessionId(value) {
  const s = String(value || '').trim();
  return s && s.length <= 200 ? s : null;
}

// Judge prompt: dimensions mirror the rule-based scoreHealth in
// frontend/src/lib/pure.ts so both scores share one shape.
function buildJudgeInput(transcript) {
  return `你是 AI coding agent 会话的质量评审（LLM-as-judge）。阅读下面这段 coding agent 会话记录，评估这次会话的执行质量。

四个维度（各 0-100）:
- completion 任务完成度: 是否给出最终结论/交付，任务是否闭环
- efficiency 执行效率: 是否绕路、重复劳动、明显浪费轮次或 token
- toolQuality 工具质量: 工具选择与参数是否合理，有无死循环或连续重复调用
- errorResilience 错误恢复: 出错后是否合理重试或换路，错误率是否过高

会话记录（可能被截断，截断处不影响整体判断）:
"""
${transcript}
"""

只输出一个 JSON 对象，不要任何其它文字或 markdown 围栏:
{ "overall": 0-100 的总分, "dimensions": { "completion": 0-100, "efficiency": 0-100, "toolQuality": 0-100, "errorResilience": 0-100 }, "summary": "两三句话总评(中文)", "issues": ["具体问题1", "具体问题2"] }
issues 数组列出你发现的具体问题（没有就给空数组）。用中文。`;
}

module.exports = function mountEvalRoutes(app) {
  // Whole eval store: annotations, judgements, regression set
  app.get('/api/evals', async (_req, res) => {
    try {
      res.json(await evals.loadEvalStore());
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Manual annotation (👍/👎 + note). A 👎 auto-collects the session into the
  // regression set; flipping to 👍 removes an untouched auto-collected case.
  app.put('/api/evals/annotation', async (req, res) => {
    try {
      const platform = cleanPlatform(req.body?.platform);
      const sessionId = cleanSessionId(req.body?.sessionId);
      if (!platform || !sessionId) {
        return res.status(400).json({ error: 'platform and sessionId are required' });
      }
      const body = req.body || {};
      if (body.thumb === undefined && body.note === undefined) {
        return res.status(400).json({ error: 'thumb or note is required' });
      }
      const { annotation } = await evals.setAnnotation(platform, sessionId, body);
      res.json({ annotation });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // LLM-as-judge: score a session transcript into the health-score shape.
  // The transcript is built client-side from the turns the user is looking
  // at; the server only talks to the LLM backend and persists the result.
  app.post('/api/evals/judge', async (req, res) => {
    try {
      const platform = cleanPlatform(req.body?.platform);
      const sessionId = cleanSessionId(req.body?.sessionId);
      const transcript = String(req.body?.transcript || '').slice(0, 60000);
      if (!platform || !sessionId) {
        return res.status(400).json({ error: 'platform and sessionId are required' });
      }
      if (!transcript.trim()) {
        return res.status(400).json({ error: 'transcript is required' });
      }

      const result = await runLlmDetailed(buildJudgeInput(transcript), 600_000);
      const { content: raw, reasoning } = result;
      const parsed = parseLlmJson(raw);
      const backend = result.backend || (await llmBackend()) || 'unknown';
      const config = await loadLlmConfig();
      const model =
        result.model || (backend === 'openai' ? config.profiles?.[config.activeProfile]?.model : 'claude-cli') || '';
      const contentHash = crypto.createHash('sha256').update(transcript).digest('hex').slice(0, 12);
      if (!parsed || typeof parsed.overall !== 'number') {
        // Model refused to produce the JSON shape — record the attempt in the
        // session's judge history (ok:false + raw) so it survives navigation,
        // but keep `judgements` on the last successful score. The raw text is
        // also returned for immediate display; retry-friendly.
        const trimmed = raw.trim().slice(0, 4000);
        await evals.setJudgementFailure(platform, sessionId, { raw: trimmed, model, backend, contentHash });
        return res.json({ judgement: null, raw: trimmed });
      }
      const judgement = await evals.setJudgement(
        platform,
        sessionId,
        evals.sanitizeJudgement(parsed, {
          model,
          backend,
          contentHash,
          // Full audit trail: exactly what the judge saw and (when the
          // endpoint exposes it) how the model reasoned its way to the score.
          transcript: transcript.slice(0, 60000),
          reasoning: (reasoning || '').slice(0, 10000) || null,
        })
      );
      res.json({ judgement });
    } catch (error) {
      if (error.code === 'NO_LLM_BACKEND') {
        return res.status(503).json({ error: error.message, code: 'NO_LLM_BACKEND' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // Regression set (curated bad cases)
  app.get('/api/evals/regression', async (_req, res) => {
    try {
      const store = await evals.loadEvalStore();
      res.json({ cases: store.regression });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/evals/regression', async (req, res) => {
    try {
      const platform = cleanPlatform(req.body?.platform);
      const sessionId = cleanSessionId(req.body?.sessionId);
      if (!platform || !sessionId) {
        return res.status(400).json({ error: 'platform and sessionId are required' });
      }
      const entry = await evals.addRegression({
        platform,
        sessionId,
        tags: req.body?.tags,
        note: req.body?.note,
        source: req.body?.source,
      });
      res.json({ case: entry });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete('/api/evals/regression/:id', async (req, res) => {
    try {
      const removed = await evals.removeRegressionById(String(req.params.id || ''));
      res.json({ removed });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
