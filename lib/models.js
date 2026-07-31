// lib/models.js — Read opencode.jsonc config and return available models/agents

const fs = require('fs');
const path = require('path');
const os = require('os');

// Known opencode.jsonc locations (in priority order)
function findConfigPaths() {
  const paths = [];

  // 1. Project-level opencode.jsonc
  const projectPath = path.resolve(__dirname, '..', 'opencode.jsonc');
  paths.push(projectPath);

  // 2. XDG config / ~/.config/opencode/opencode.jsonc
  const xdgConfig = process.env.XDG_CONFIG_HOME
    || path.join(os.homedir(), '.config');
  paths.push(path.join(xdgConfig, 'opencode', 'opencode.jsonc'));

  // Also check without opencode subdir (some setups)
  paths.push(path.join(os.homedir(), '.config', 'opencode', 'opencode.jsonc'));

  return paths;
}

// Strip JSONC comments, respecting string boundaries
function stripJSONC(jsonc) {
  let result = '';
  let inString = false;
  let stringChar = '';
  let i = 0;

  while (i < jsonc.length) {
    const ch = jsonc[i];
    const next = i + 1 < jsonc.length ? jsonc[i + 1] : '';

    if (inString) {
      result += ch;
      if (ch === '\\') {
        // Escape — consume next char
        i++;
        if (i < jsonc.length) result += jsonc[i];
      } else if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    // Not in string
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }

    // Single-line comment //
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < jsonc.length && jsonc[i] !== '\n' && jsonc[i] !== '\r') {
        i++;
      }
      continue;
    }

    // Block comment /* */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < jsonc.length && !(jsonc[i] === '*' && i + 1 < jsonc.length && jsonc[i + 1] === '/')) {
        i++;
      }
      i += 2; // skip */
      continue;
    }

    result += ch;
    i++;
  }

  return result.trim();
}

// Read and parse opencode.jsonc
function readOpencodeConfig() {
  const configPaths = findConfigPaths();

  for (const p of configPaths) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const cleaned = stripJSONC(raw);
        const config = JSON.parse(cleaned);
        return config;
      }
    } catch (e) {
      // Try next location
    }
  }

  return null;
}

// Split "providerID/modelID" string like "deepseek/deepseek-v4-flash"
function parseModelKey(key) {
  if (!key) return { providerID: '', id: '' };
  const slashIdx = key.indexOf('/');
  if (slashIdx === -1) return { providerID: '', id: key };
  return {
    providerID: key.slice(0, slashIdx),
    id: key.slice(slashIdx + 1),
  };
}

// ─── Model discovery cache ──────────────────────────────────────────────────
let _discoveredCache = null;

// Known OpenAI-compatible base URLs for providers without explicit options.baseURL.
// Keys are provider IDs from opencode.jsonc; values are the /v1 endpoint prefix.
const KNOWN_API_URLS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai:   'https://api.openai.com/v1',
  together: 'https://api.together.xyz/v1',
  groq:     'https://api.groq.com/openai/v1',
  fireworks:'https://api.fireworks.ai/inference/v1',
};

// Try to discover models from a provider's OpenAI-compatible /v1/models endpoint.
// Returns an array of model objects, or null if the call fails or is not possible.
async function discoverProviderModels(providerId, provider) {
  const apiKey = provider.apiKey || provider.options?.apiKey;
  if (!apiKey) return null;

  // Resolve env-var references like "{env:DEEPSEEK_API_KEY}"
  const resolvedKey = apiKey.replace(/\{env:([^}]+)\}/g, (_, name) => process.env[name] || '').trim();
  if (!resolvedKey) return null;

  // Determine base URL: options.baseURL → known map → construct from provider ID
  let baseURL = provider.options?.baseURL;
  if (!baseURL) {
    baseURL = KNOWN_API_URLS[providerId] || `https://api.${providerId}.com/v1`;
  }

  const url = baseURL.replace(/\/+$/, '') + '/models';
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + resolvedKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.data || !Array.isArray(body.data)) return null;

    // OpenAI-compatible /v1/models returns: { data: [{ id, object, owned_by }] }
    return body.data
      .filter(m => m.id && !m.id.includes('tts'))  // skip TTS-only models
      .map(m => ({
        id: m.id,
        providerID: providerId,
        key: `${providerId}/${m.id}`,
        name: m.id,
        providerName: provider.name || providerId,
        reasoning: true,
        toolCall: true,
        contextLimit: 128000,
        outputLimit: 16384,
        attachment: true,
        modalities: { input: ['text'] },
        isDefault: false,
        isSmallDefault: false,
        _discovered: true,
      }));
  } catch {
    return null;
  }
}

// Collect all known models from config + dynamic discovery.
async function getModels() {
  const config = readOpencodeConfig();
  if (!config || !config.provider) return [];

  const defaultModel = config.model || '';
  const smallModel = config.small_model || '';
  const defaultParsed = parseModelKey(defaultModel);
  const smallParsed = parseModelKey(smallModel);
  const models = [];

  for (const [providerId, provider] of Object.entries(config.provider)) {
    const providerName = provider.name || providerId;

    if (provider.models && typeof provider.models === 'object') {
      // Provider with explicit model list — use as-is
      for (const [modelId, modelDef] of Object.entries(provider.models)) {
        models.push(createModelEntry(providerId, providerName, modelId, modelDef, defaultParsed, smallParsed));
      }
    } else {
      // No explicit model list — try runtime discovery via provider API
      const discovered = await discoverProviderModels(providerId, provider);
      if (discovered && discovered.length > 0) {
        for (const m of discovered) models.push(m);
      } else {
        // Fallback: show the default/small model for this provider if it matches
        const which = defaultParsed.providerID === providerId ? defaultParsed
                    : smallParsed.providerID === providerId ? smallParsed
                    : null;
        if (which && which.id) {
          models.push({
            id: which.id,
            providerID: providerId,
            key: `${providerId}/${which.id}`,
            name: providerName + ' (' + which.id + ')',
            providerName: providerName,
            reasoning: true, toolCall: true,
            contextLimit: 128000, outputLimit: 16384,
            attachment: true, modalities: { input: ['text'] },
            isDefault: providerId === defaultParsed.providerID && which.id === defaultParsed.id,
            isSmallDefault: providerId === smallParsed.providerID && which.id === smallParsed.id,
          });
        } else {
          // Last resort: show a placeholder entry
          models.push({
            id: providerId,
            providerID: providerId,
            key: providerId,
            name: providerName,
            providerName: providerName,
            reasoning: true, toolCall: true,
            contextLimit: 128000, outputLimit: 16384,
            attachment: false, modalities: { input: ['text'] },
            isDefault: false, isSmallDefault: false,
            placeholder: true,
          });
        }
      }
    }
  }

  return models;
}

function createModelEntry(providerId, providerName, modelId, modelDef, defaultParsed, smallParsed) {
  return {
    id: modelId,
    providerID: providerId,
    key: `${providerId}/${modelId}`,
    name: modelDef.name || modelId,
    providerName: providerName,
    reasoning: !!modelDef.reasoning,
    toolCall: !!modelDef.tool_call,
    contextLimit: modelDef.limit?.context || 0,
    outputLimit: modelDef.limit?.output || 0,
    attachment: !!modelDef.attachment,
    modalities: modelDef.modalities || { input: ['text'] },
    isDefault: providerId === defaultParsed.providerID && modelId === defaultParsed.id,
    isSmallDefault: providerId === smallParsed.providerID && modelId === smallParsed.id,
  };
}

// Available agent types — only 3 user-facing modes (matching OpenCode Desktop)
// Orchestrator internally spawns explorer/librarian/fixer/etc as needed
const AGENTS = [
  { id: 'orchestrator', name: 'Orchestrator', description: 'Full workflow orchestration' },
  { id: 'build_plan', name: 'Build Plan', description: 'Plan-first implementation' },
  { id: 'general', name: 'Plan', description: 'Read-only analysis' },
];

// Thinking intensity variants
const VARIANTS = [
  { id: 'max', name: 'Max', description: 'Maximum reasoning effort' },
  { id: 'medium', name: 'Medium', description: 'Balanced reasoning effort' },
  { id: 'min', name: 'Min', description: 'Minimal reasoning effort' },
];

// Get full capability info for the frontend
async function getCapabilities() {
  const models = await getModels();
  const config = readOpencodeConfig();
  const defaultParsed = parseModelKey(config?.model || '');

  // Find default model from config, or first model
  let defaultModel = models.find(m => m.providerID === defaultParsed.providerID && m.id === defaultParsed.id);
  if (!defaultModel && models.length > 0) {
    defaultModel = models[0];
  }

  return {
    models,
    agents: AGENTS,
    variants: VARIANTS,
    defaultModel: defaultModel ? { id: defaultModel.id, providerID: defaultModel.providerID } : null,
    defaultAgent: 'orchestrator',
    defaultVariant: 'max',
  };
}

module.exports = { getModels, getCapabilities, AGENTS, VARIANTS, readOpencodeConfig };
