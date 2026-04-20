/* ── Workflow types — mirrors the front-end canvas structures ── */

export interface WorkflowNode {
  id: string
  data?: {
    blockType?: string
    title?: string
    [k: string]: unknown
  }
  position?: { x: number; y: number }
  [k: string]: unknown
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  [k: string]: unknown
}

export interface Workflow {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  subBlockValues: Record<string, Record<string, unknown>>
}

export interface RunRequest {
  workflow: Workflow
  inputs: Record<string, unknown>
  /** Optional: workspace skills for client-side-style skill execution */
  skills?: Skill[]
}

export interface TraceEntry {
  nodeId: string
  blockType?: string
  title?: string
  input: unknown
  output?: unknown
  values?: Record<string, unknown>
  meta?: Record<string, unknown>
  error?: string
  errorDetail?: Record<string, unknown>
  ms: number
}

export interface RunResult {
  output: unknown
  trace: TraceEntry[]
  error?: string
}

/* ── Agent types ── */

export interface AgentRequest {
  agent: {
    id: string
    provider?: string
    model?: string
    temperature?: number
    systemPrompt?: string
    userPrompt?: string
    responseFormat?: string | null
    strictOutput?: boolean
    skills?: string[]
  }
  input: string
}

export interface AgentResponse {
  output: string
  model: string
  ms: number
}

/* ── Skill ── */

export interface Skill {
  id: string
  name: string
  language?: string
  source: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/* ── Workspace persistence ── */

export interface WorkspaceSnapshot {
  activeWorkspaceId?: string
  activeWorkflowId?: string
  workspaces?: unknown[]
  teams?: unknown[]
  agentPools?: unknown[]
  agents?: unknown[]
  skills?: Skill[]
  workflows?: unknown[]
  llmConfig?: Record<string, unknown> | null
}

/* ── MCP ── */

export interface McpToolCallRequest {
  arguments: Record<string, unknown>
}
