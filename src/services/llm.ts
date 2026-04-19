/**
 * LLM service — calls the LLM for agent nodes.
 *
 * Strategy (proxy-first):
 *  1. DEFAULT: proxy through ConvEngine's /builder-studio/agent endpoint.
 *     This lets the organisation use its own LLM gateway / custom models
 *     configured in ConvEngine (convengine-demo).
 *  2. FALLBACK: if DIRECT_LLM=true AND the matching API key is set,
 *     call OpenAI / Anthropic directly (useful for local dev without ConvEngine).
 */
import { config } from '../config.js'
import type { AgentRequest, AgentResponse } from '../types/index.js'

const useDirectLlm = process.env.DIRECT_LLM === 'true'

export async function callAgent(req: AgentRequest): Promise<AgentResponse> {
  // Direct mode — only when explicitly opted in
  if (useDirectLlm) {
    const model = req.agent.model || 'gpt-4o-mini'
    if (config.openaiKey && (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3'))) {
      return callOpenAI(req, model)
    }
    if (config.anthropicKey && model.startsWith('claude-')) {
      return callAnthropic(req, model)
    }
  }

  // Default — always proxy through ConvEngine
  return proxyToConvEngine(req)
}

/* ── Direct OpenAI ────────────────────────────────────────────────────── */

async function callOpenAI(req: AgentRequest, model: string): Promise<AgentResponse> {
  const t0 = Date.now()
  const messages: Array<{ role: string; content: string }> = []
  if (req.agent.systemPrompt) messages.push({ role: 'system', content: req.agent.systemPrompt })
  messages.push({ role: 'user', content: req.agent.userPrompt || req.input })

  const body: Record<string, unknown> = { model, messages }
  if (req.agent.temperature != null) body.temperature = req.agent.temperature

  if (req.agent.responseFormat && req.agent.strictOutput) {
    try {
      const schema = typeof req.agent.responseFormat === 'string'
        ? JSON.parse(req.agent.responseFormat)
        : req.agent.responseFormat
      body.response_format = { type: 'json_schema', json_schema: { name: 'response', strict: true, schema } }
    } catch { /* ignore parse errors, send without format */ }
  } else if (req.agent.responseFormat) {
    body.response_format = { type: 'json_object' }
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`OpenAI ${res.status}: ${text}`)
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> }
  const output = data.choices?.[0]?.message?.content ?? ''
  return { output, model, ms: Date.now() - t0 }
}

/* ── Direct Anthropic ───────────────────────────────────────────────────── */

async function callAnthropic(req: AgentRequest, model: string): Promise<AgentResponse> {
  const t0 = Date.now()
  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: req.agent.userPrompt || req.input }],
  }
  if (req.agent.systemPrompt) body.system = req.agent.systemPrompt
  if (req.agent.temperature != null) body.temperature = req.agent.temperature

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic ${res.status}: ${text}`)
  }
  const data = await res.json() as { content: Array<{ text: string }> }
  const output = data.content?.map((c) => c.text).join('') ?? ''
  return { output, model, ms: Date.now() - t0 }
}

/* ── Proxy to ConvEngine ──────────────────────────────────────────────────── */

async function proxyToConvEngine(req: AgentRequest): Promise<AgentResponse> {
  const url = `${config.convengineBase}/builder-studio/agent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`ConvEngine agent proxy ${res.status}: ${text}`)
  }
  return await res.json() as AgentResponse
}
