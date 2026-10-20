import { describe, expect, test } from "bun:test"
import { _internal, AibermAuthPlugin } from "./index.mjs"

const { wireOf, modelsFrom, usageFrom, defaultModels, WIRES } = _internal

describe("wireOf", () => {
  test("Claude goes on Anthropic Messages", () => {
    expect(wireOf("claude-opus-5-5", ["anthropic", "openai"])).toBe("anthropic")
    expect(wireOf("anthropic/claude-haiku-5.5", ["anthropic", "openai"])).toBe("anthropic")
    expect(wireOf("claude-opus-5-5")).toBe("anthropic")
  })
  test("Gemini goes on Gemini", () => {
    expect(wireOf("google/gemini-3.1-pro", ["gemini", "openai"])).toBe("gemini")
    expect(wireOf("gemini-3.8-flash")).toBe("gemini")
  })
  test("GPT goes on Responses", () => {
    expect(wireOf("openai/gpt-5.5", ["openai"])).toBe("responses")
    expect(wireOf("gpt-5.5", ["openai"])).toBe("responses")
  })
  test("the rest goes on Chat Completions", () => {
    expect(wireOf("grok-4.7", ["openai"])).toBe("chat")
    expect(wireOf("deepseek-v4.1-flash", ["openai"])).toBe("chat")
    // Qwen and Kimi list anthropic too, but Chat keeps their reasoning_content
    expect(wireOf("qwen3.8-max", ["anthropic", "openai"])).toBe("chat")
    expect(wireOf("kimi-k3", ["anthropic", "openai"])).toBe("chat")
  })
})

test("modelsFrom drops non-chat models and puts known ones first", () => {
  const out = modelsFrom([
    { id: "text-embedding-3-large", supported_endpoint_types: ["openai"] },
    { id: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
    { id: "zzz-unknown", supported_endpoint_types: ["openai"] },
    { id: "claude-sonnet-5-5", supported_endpoint_types: ["anthropic", "openai"] },
    { id: "claude-opus-5-5", supported_endpoint_types: ["anthropic", "openai"] },
  ])
  expect(Object.keys(out)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "zzz-unknown"])
  const opus = out["claude-opus-5-5"]
  expect(opus.api).toEqual({ id: "claude-opus-5-5", url: WIRES.anthropic.api, npm: "@ai-sdk/anthropic" })
  expect(opus.limit).toEqual({ context: 1000000, output: 128000 })
  expect(Object.keys(opus.variants)).toEqual(["low", "medium", "high", "xhigh", "max"])
  expect(out["zzz-unknown"].api.npm).toBe("@ai-sdk/openai-compatible")
})

test("modelsFrom keeps one id per model: known, else bare, else shortest", () => {
  const ids = (list) => Object.keys(modelsFrom(list.map((id) => ({ id, supported_endpoint_types: ["openai"] }))))
  expect(ids([
    "anthropic/claude-opus-5.5", "claude-opus-5-5",
    "openai/gpt-5.5", "gpt-5.5",
    "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6:thinking", "claude-opus-4-6", "claude-opus-4-6-thinking",
    "claude-sonnet-4-5-20250929", "claude-sonnet-4-5-20250929-thinking", "anthropic/claude-sonnet-4.5",
    "gemini-3.1-pro-preview", "gemini-3.1-pro-preview-thinking", "google/gemini-3.1-pro",
    "anthropic/claude-haiku-5.5",
    "gpt-5.5-xhigh",
  ])).toEqual([
    "claude-opus-5-5", "anthropic/claude-haiku-5.5", "gpt-5.5", "google/gemini-3.1-pro",
    "claude-opus-4-6", "claude-sonnet-4-5-20250929", "gpt-5.5-xhigh",
  ])
})

test("defaultModels gives every known model a wire and limits", () => {
  const m = defaultModels()
  expect(m["google/gemini-3.1-pro"].provider).toEqual(WIRES.gemini)
  expect(m["gpt-5.5"].variants.high).toEqual({ reasoningEffort: "high" })
  expect(m["gemini-3.8-flash"].variants.low).toEqual({ thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } })
})

describe("usageFrom", () => {
  test("unlimited key shows what it spent", () => {
    const u = usageFrom({ code: true, data: { name: "magpie", total_used: 1000000, unlimited_quota: true, expires_at: 0 } })
    expect(u.balance).toBe("$2.00 used")
    expect(u.windows).toEqual([])
  })
  test("limited key shows a quota window", () => {
    const u = usageFrom({ code: true, data: { total_used: 250000, total_available: 750000, unlimited_quota: false, expires_at: 0 } })
    expect(u.balance).toBe("$1.50 left")
    expect(u.windows[0].used).toBe(25)
    expect(u.windows[0].display).toBe("$0.50 / $2.00")
  })
  test("an error answer becomes an error", () => {
    expect(usageFrom({ code: false, message: "nope" }).error).toBe("nope")
  })
})

test("config keeps what the user set", async () => {
  const hooks = await AibermAuthPlugin({})
  const cfg = { provider: { aiberm: { name: "Mine", models: { "x-model": { name: "X" } } } } }
  await hooks.config(cfg)
  expect(cfg.provider.aiberm.name).toBe("Mine")
  expect(cfg.provider.aiberm.models["x-model"].name).toBe("X")
  expect(cfg.provider.aiberm.models["claude-opus-5-5"]).toBeDefined()
})

test("loader gives the key, and nothing without one", async () => {
  const hooks = await AibermAuthPlugin({})
  expect(await hooks.auth.loader(async () => ({ type: "api", key: "sk-1" }))).toEqual({ apiKey: "sk-1" })
  expect(await hooks.auth.loader(async () => undefined)).toEqual({})
})
