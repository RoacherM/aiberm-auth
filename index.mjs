// aiberm-auth: Aiberm (https://aiberm.com) as a magpie / OpenCode provider.
//
// Aiberm is a New API gateway. One key reaches every model, and each model
// is served on more than one API: /v1/models lists them per model
// (supported_endpoint_types). This plugin puts each model on its native
// API, so magpie only converts when the agent speaks a different one:
//
//   Claude (and anything listing "anthropic")  -> Anthropic Messages  /v1/messages
//   Gemini (listing "gemini")                  -> Gemini              /v1beta/models/<id>:streamGenerateContent
//   GPT                                        -> OpenAI Responses    /v1/responses
//   everything else                            -> Chat Completions    /v1/chat/completions
//
// Only the entry point's exports run as plugins: helpers stay unexported
// and the tests reach them through _internal.

const PROVIDER = "aiberm"
const ORIGIN = "https://aiberm.com"

const WIRES = {
  anthropic: { npm: "@ai-sdk/anthropic", api: ORIGIN + "/v1" },
  gemini: { npm: "@ai-sdk/google", api: ORIGIN + "/v1beta" },
  responses: { npm: "@ai-sdk/openai", api: ORIGIN + "/v1" },
  chat: { npm: "@ai-sdk/openai-compatible", api: ORIGIN + "/v1" },
}

// Effort levels per wire, as each vendor names them.
const EFFORTS = {
  anthropic: ["low", "medium", "high", "xhigh", "max"],
  gemini: ["low", "medium", "high"],
  responses: ["none", "low", "medium", "high", "xhigh"],
  chat: ["low", "medium", "high"],
}

// The models offered before a key is in, and the limits Aiberm's list
// doesn't give. Context and output are the vendors' published limits;
// Aiberm may cap below them.
// [id, name, context, output, images, reasoning]
const KNOWN = [
  ["claude-opus-5-5", "Claude Opus 5.5", 1000000, 128000, true, true],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", 1000000, 128000, true, true],
  ["anthropic/claude-haiku-5.5", "Claude Haiku 5.5", 1000000, 128000, true, true],
  ["gpt-5.5", "GPT-5.5", 1050000, 128000, true, true],
  ["gemini-3.8-flash", "Gemini 3.8 Flash", 1048576, 65536, true, true],
  ["google/gemini-3.1-pro", "Gemini 3.1 Pro", 1048576, 65536, true, true],
  ["deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 1048576, 393216, false, true],
  ["grok-4.7", "Grok 4.7", 500000, 65536, true, true],
  ["kimi-k3", "Kimi K3", 1048576, 65536, true, true],
  ["qwen3.8-max", "Qwen 3.8 Max", 1000000, 65536, false, true],
]

// Fallback limits by family when a listed model isn't in KNOWN.
const FAMILY = [
  [/claude/i, 200000, 64000, true],
  [/gemini/i, 1048576, 65536, true],
  [/gpt-5|gpt-6|o3/i, 400000, 128000, true],
  [/gpt-4/i, 128000, 16384, true],
  [/grok/i, 256000, 65536, true],
  [/deepseek/i, 128000, 32768, false],
  [/kimi|qwen|glm|minimax|mimo/i, 200000, 32768, false],
]

// Not chat models: embeddings, image, speech and OCR models stay out.
const NOT_CHAT = /embedding|image|banana|tts|ocr|whisper|dall-e|moderation/i

// wireOf picks a model's API from its id and the endpoint types Aiberm
// lists for it.
function wireOf(id, types = []) {
  const t = new Set(types)
  if (t.has("anthropic") && /claude|anthropic/i.test(id)) return "anthropic"
  if (t.has("gemini") || (!types.length && /gemini/i.test(id))) return "gemini"
  if (!types.length && /claude/i.test(id)) return "anthropic"
  // Aiberm serves Responses for OpenAI's models only; Grok and DeepSeek
  // turn it away
  if (/(^|\/)(gpt-|o\d)/i.test(id)) return "responses"
  return "chat"
}

// variantOf is what the AI SDK package of a wire is given for an effort.
function variantOf(wire, effort) {
  if (wire === "anthropic") return { effort }
  if (wire === "gemini") return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
  return { reasoningEffort: effort }
}

function limitsOf(id) {
  const k = KNOWN.find((m) => m[0] === id)
  if (k) return { name: k[1], context: k[2], output: k[3], images: k[4], reasoning: k[5] }
  const f = FAMILY.find(([re]) => re.test(id))
  if (f) return { name: id, context: f[1], output: f[2], images: f[3], reasoning: /thinking|claude|gemini|gpt-5|gpt-6|o3|grok|r1/i.test(id) }
  return { name: id, context: 128000, output: 16384, images: false, reasoning: false }
}

// configModel is a model as OpenCode's config takes it.
function configModel(id, wire) {
  const l = limitsOf(id)
  return {
    id,
    name: l.name,
    provider: { npm: WIRES[wire].npm, api: WIRES[wire].api },
    reasoning: l.reasoning,
    attachment: l.images,
    tool_call: true,
    temperature: true,
    modalities: { input: l.images ? ["text", "image"] : ["text"], output: ["text"] },
    limit: { context: l.context, output: l.output },
    variants: l.reasoning ? Object.fromEntries(EFFORTS[wire].map((e) => [e, variantOf(wire, e)])) : {},
  }
}

function defaultModels() {
  return Object.fromEntries(KNOWN.map(([id]) => [id, configModel(id, wireOf(id))]))
}

// runtimeModel is a model as provider.models returns it (OpenCode's Model),
// built on what config gave when the id is there.
function runtimeModel(id, wire, was = {}) {
  const l = limitsOf(id)
  return {
    ...was,
    id,
    providerID: PROVIDER,
    name: was.name ?? l.name,
    api: { ...(was.api ?? {}), id, url: WIRES[wire].api, npm: WIRES[wire].npm },
    limit: { ...(was.limit ?? {}), context: l.context, output: l.output },
    capabilities: {
      ...(was.capabilities ?? {}),
      reasoning: l.reasoning,
      attachment: l.images,
      toolcall: true,
      input: { ...(was.capabilities?.input ?? {}), text: true, image: l.images },
    },
    variants: l.reasoning ? Object.fromEntries(EFFORTS[wire].map((e) => [e, variantOf(wire, e)])) : {},
  }
}

// keyOf is the model an id names. Aiberm lists one model under several ids:
// a vendor prefix (anthropic/, openai/, google/...), a thinking variant
// (reasoning effort covers it), a date snapshot, a -preview tag, and dots
// or dashes in the version.
function keyOf(id) {
  return id
    .toLowerCase()
    .replace(/^[a-z]+\//, "")
    .replace(/[:-]thinking$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-preview$/, "")
    .replaceAll(".", "-")
}

// pick keeps one id per model: a known one, else a bare id, else the
// shortest. Bare ids are Aiberm's direct channels; the vendor-prefixed ones
// are its mirror channels, which refuse Claude (403, policy) and add a
// hidden ~4k-token prompt to GPT (measured 2026-10-16). The shortest id is
// the alias without thinking, date or preview suffixes.
function pick(ids) {
  const score = (id) => [KNOWN.some((m) => m[0] === id) ? 0 : 1, id.includes("/") ? 1 : 0, id.length]
  return ids.reduce((best, id) => {
    const [a, b] = [score(id), score(best)]
    const i = a.findIndex((v, n) => v !== b[n])
    return i >= 0 && a[i] < b[i] ? id : best
  })
}

// modelsFrom turns /v1/models' data into the account's models: chat models
// only, one id per model, the known ones first (magpie shows the first 24
// of a provider nobody picked models for).
function modelsFrom(data, have = {}) {
  const rank = (id) => {
    const i = KNOWN.findIndex((m) => m[0] === id)
    return i < 0 ? KNOWN.length : i
  }
  const chat = (data ?? []).filter((m) => m && typeof m.id === "string" && !NOT_CHAT.test(m.id))
  const groups = new Map()
  for (const m of chat) groups.set(keyOf(m.id), [...(groups.get(keyOf(m.id)) ?? []), m.id])
  const kept = new Set([...groups.values()].map(pick))
  const list = chat
    .filter((m) => kept.has(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
  const out = {}
  for (const m of list) out[m.id] = runtimeModel(m.id, wireOf(m.id, m.supported_endpoint_types ?? []), have[m.id])
  return out
}

// New API counts quota in units of 1/500000 USD.
const QUOTA_PER_USD = 500000
const usd = (q) => `$${(q / QUOTA_PER_USD).toFixed(2)}`

// usageFrom reads New API's /api/usage/token/ answer for the key.
function usageFrom(body) {
  const d = body?.data
  if (!body?.code || !d) return { error: body?.message || "Aiberm gave no usage", windows: [] }
  const used = Number(d.total_used) || 0
  if (d.unlimited_quota) {
    return {
      plan: "Pay as you go",
      user: d.name || undefined,
      balance: `${usd(used)} used`,
      windows: [],
    }
  }
  const left = Math.max(0, Number(d.total_available) || 0)
  const limit = used + left
  return {
    plan: "Key quota",
    user: d.name || undefined,
    until: d.expires_at > 0 ? d.expires_at : undefined,
    balance: `${usd(left)} left`,
    windows: [
      {
        name: "Key quota",
        used: limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0,
        display: `${usd(used)} / ${usd(limit)}`,
      },
    ],
  }
}

const expired = (msg) => Object.assign(new Error(msg), { signIn: "expired" })

async function listModels(key) {
  const res = await fetch(ORIGIN + "/v1/models", { headers: { authorization: `Bearer ${key}` } })
  if (res.status === 401) throw expired("Aiberm refused the API key; sign in again")
  if (!res.ok) throw new Error(`Aiberm answered ${res.status} for /v1/models`)
  const body = await res.json()
  return body?.data ?? []
}

export const AibermAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    const was = cfg.provider[PROVIDER] ?? {}
    cfg.provider[PROVIDER] = {
      name: "Aiberm",
      npm: WIRES.chat.npm,
      api: WIRES.chat.api,
      ...was,
      models: { ...defaultModels(), ...(was.models ?? {}) },
    }
  },

  auth: {
    provider: PROVIDER,
    methods: [
      {
        type: "api",
        label: "Aiberm API key",
        placeholder: "sk-…",
        // saved as given; a wrong key shows up as a 401 on the model list,
        // which marks the account
      },
    ],

    async loader(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return {}
      // No baseURL: each model's own api (by wire) decides where it goes.
      // apiKey goes out the way each SDK package sends it (x-api-key,
      // x-goog-api-key, Bearer); Aiberm takes all three.
      return { apiKey: auth.key }
    },

    // magpie's own hook: what the key has spent
    async usage(getAuth) {
      const auth = await getAuth()
      if (auth?.type !== "api" || !auth.key) return { error: "Not signed in to Aiberm", windows: [] }
      try {
        const res = await fetch(ORIGIN + "/api/usage/token/", { headers: { authorization: `Bearer ${auth.key}` } })
        if (res.status === 401) return { error: "Aiberm refused the API key", windows: [], signIn: "expired" }
        if (!res.ok) return { error: `Aiberm answered ${res.status}`, windows: [] }
        return usageFrom(await res.json())
      } catch (e) {
        return { error: e.message, windows: [] }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      const have = provider?.models ?? {}
      if (auth?.type !== "api" || !auth.key) return have
      // a failure keeps magpie's last list; a 401 marks the account
      const data = await listModels(auth.key)
      const out = modelsFrom(data, have)
      if (!Object.keys(out).length) throw new Error("Aiberm listed no chat models")
      return out
    },
  },
})

// for tests
export const _internal = { wireOf, variantOf, limitsOf, configModel, defaultModels, modelsFrom, usageFrom, keyOf, WIRES, KNOWN }
