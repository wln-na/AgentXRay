const { loadLlmConfig, saveLlmConfig, llmBackend } = require('../llm');

const ROUTE_KEYS = ['sessionTasks', 'promptRewrite', 'promptAnalysis', 'libraryName'];
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function profileSummary(profile) {
  return {
    type: profile.type,
    baseUrl: profile.baseUrl || '',
    model: profile.model || '',
    hasApiKey: Boolean(profile.apiKey),
  };
}

async function publicConfig(config) {
  const profiles = Object.fromEntries(
    Object.entries(config.profiles).map(([name, profile]) => [name, profileSummary(profile)])
  );
  const active = config.profiles[config.activeProfile];
  const routeBackends = Object.fromEntries(
    await Promise.all(ROUTE_KEYS.map(async (purpose) => [purpose, await llmBackend({ purpose })]))
  );
  return {
    version: 2,
    activeProfile: config.activeProfile,
    profiles,
    routes: config.routes,
    routeBackends,
    // Keep these fields for older clients while they migrate to profiles.
    baseUrl: active?.baseUrl || '',
    model: active?.model || '',
    hasApiKey: Boolean(active?.apiKey),
    backend: await llmBackend(),
  };
}

function validateProfile(name, raw) {
  if (!PROFILE_NAME_RE.test(name)) {
    return `invalid profile name: ${name}`;
  }
  if (!raw || typeof raw !== 'object') return `profile must be an object: ${name}`;
  const type = raw.type || 'openai-compatible';
  if (!['openai-compatible', 'claude-cli'].includes(type)) {
    return `unsupported profile type: ${type}`;
  }
  if (type === 'openai-compatible') {
    const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() : '';
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!baseUrl || !/^https?:\/\//.test(baseUrl)) {
      return `profile ${name}: baseUrl must start with http:// or https://`;
    }
    if (!model) return `profile ${name}: model is required`;
  }
  return null;
}

function buildConfig(body, current) {
  // Keep accepting the original { baseUrl, model, apiKey } request shape.
  if (!body.profiles) {
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey : current.profiles.default?.apiKey || '';
    const hasEndpoint = Boolean(baseUrl || model);
    return {
      version: 2,
      activeProfile: hasEndpoint ? 'default' : '',
      profiles: hasEndpoint ? { default: { type: 'openai-compatible', baseUrl, model, apiKey } } : {},
      routes: {},
    };
  }

  const profiles = {};
  for (const [name, raw] of Object.entries(body.profiles)) {
    const previous = current.profiles[name];
    profiles[name] = {
      type: raw?.type || 'openai-compatible',
      baseUrl: typeof raw?.baseUrl === 'string' ? raw.baseUrl.trim() : '',
      model: typeof raw?.model === 'string' ? raw.model.trim() : '',
      // An omitted or empty key keeps the existing local key. Use
      // clearApiKey when a caller explicitly wants to remove it.
      apiKey:
        raw?.clearApiKey === true
          ? ''
          : typeof raw?.apiKey === 'string' && raw.apiKey
            ? raw.apiKey
            : previous?.apiKey || '',
    };
  }
  const activeProfile = typeof body.activeProfile === 'string' ? body.activeProfile.trim() : current.activeProfile;
  const routes = { ...current.routes };
  if (body.routes && typeof body.routes === 'object' && !Array.isArray(body.routes)) {
    for (const purpose of ROUTE_KEYS) {
      if (!Object.hasOwn(body.routes, purpose)) continue;
      const target = body.routes[purpose];
      if (typeof target === 'string' && target.trim()) routes[purpose] = target.trim();
      else delete routes[purpose];
    }
  }
  return { version: 2, activeProfile, profiles, routes };
}

function validateConfig(config) {
  if (config.activeProfile && config.activeProfile !== 'claude-cli' && !config.profiles[config.activeProfile]) {
    return `activeProfile not found: ${config.activeProfile}`;
  }
  for (const [name, profile] of Object.entries(config.profiles)) {
    const error = validateProfile(name, profile);
    if (error) return error;
  }
  for (const purpose of ROUTE_KEYS) {
    const target = config.routes[purpose];
    if (target && target !== 'claude-cli' && !config.profiles[target]) {
      return `route ${purpose} points to a missing profile: ${target}`;
    }
  }
  return null;
}

// LLM backend settings are stored server-side in ~/.agentxray/llm.json.
// GET never leaks API keys; it exposes only hasApiKey flags for each profile.
module.exports = function mountLlmRoutes(app) {
  app.get('/api/settings/llm', async (_req, res) => {
    try {
      res.json(await publicConfig(await loadLlmConfig()));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings/llm', async (req, res) => {
    try {
      const current = await loadLlmConfig();
      const next = buildConfig(req.body || {}, current);
      const validationError = validateConfig(next);
      if (validationError) return res.status(400).json({ error: validationError });
      res.json(await publicConfig(await saveLlmConfig(next)));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
