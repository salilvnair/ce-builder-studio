/**
 * MCP proxy — forwards tool calls to ConvEngine's MCP surface.
 */
import { config } from '../config.js'

async function jsonOrThrow(res: Response): Promise<unknown> {
  const text = await res.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) : null } catch { /* non-json */ }
  if (!res.ok) {
    const msg = (body as { error?: string })?.error || text || `HTTP ${res.status}`
    throw new Error(msg)
  }
  return body
}

export async function listServers(): Promise<unknown> {
  return jsonOrThrow(await fetch(`${config.convengineBase}/mcp/servers`))
}

export async function upsertServer(cfg: unknown): Promise<unknown> {
  return jsonOrThrow(
    await fetch(`${config.convengineBase}/mcp/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
  )
}

export async function deleteServer(id: string): Promise<unknown> {
  return jsonOrThrow(
    await fetch(`${config.convengineBase}/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  )
}

export async function listTools(id: string, refresh = false): Promise<unknown> {
  const q = refresh ? '?refresh=true' : ''
  return jsonOrThrow(await fetch(`${config.convengineBase}/mcp/servers/${encodeURIComponent(id)}/tools${q}`))
}

export async function callTool(id: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return jsonOrThrow(
    await fetch(`${config.convengineBase}/mcp/servers/${encodeURIComponent(id)}/tools/${encodeURIComponent(tool)}/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ arguments: args }),
    })
  )
}
