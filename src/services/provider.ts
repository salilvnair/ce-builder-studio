import { config } from '../config.js'

type ChangeProviderBody = {
  provider?: string
  model?: string
  temperature?: number
}

export async function getAvailableProviders() {
  const res = await fetch(`${config.convengineBase}/builder-studio/llm/providers`)
  if (!res.ok) {
    throw new Error(`ConvEngine provider proxy ${res.status}: ${await res.text()}`)
  }
  return await res.json() as Record<string, unknown>
}

export async function changeProvider(body: ChangeProviderBody) {
  const res = await fetch(`${config.convengineBase}/builder-studio/llm/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ConvEngine provider proxy ${res.status}: ${await res.text()}`)
  }
  return await res.json() as Record<string, unknown>
}