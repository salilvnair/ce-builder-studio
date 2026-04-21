import { createHash, createHmac, randomUUID } from 'node:crypto';
import { callAgent } from '../services/llm.js';
import { callTool } from '../services/mcp.js';

// --- Types -------------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  data?: { blockType?: string; title?: string; [k: string]: unknown };
  position?: { x: number; y: number };
  [k: string]: unknown;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
  [k: string]: unknown;
}

export interface Workflow {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  subBlockValues: Record<string, Record<string, unknown>>;
}

export interface TraceEntry {
  nodeId: string;
  blockType?: string;
  title?: string;
  input: unknown;
  inputsByHandle?: Record<string, unknown>;
  output?: unknown;
  values?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  error?: string;
  errorDetail?: Record<string, unknown>;
  ms: number;
}

export interface RunResult {
  output: unknown;
  trace: TraceEntry[];
  error?: string;
}
// --- Utility Functions -------------------------------------------------------

function groupBy<T>(arr: T[], key: keyof T): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const item of arr) {
    const k = String(item[key]);
    if (!map[k]) map[k] = [];
    map[k].push(item);
  }
  return map;
}

// ─── Runtime type validation helpers ─────────────────────────────────────────
const _compat: Record<string, Set<string>> = {
  string:  new Set(['string', 'any']),
  number:  new Set(['number', 'any']),
  boolean: new Set(['boolean', 'any']),
  json:    new Set(['json', 'array', 'any']),
  array:   new Set(['array', 'any']),
  any:     new Set(['string', 'number', 'boolean', 'json', 'array', 'any']),
};

function isRuntimeTypeCompatible(sourceType: string, targetType: string): boolean {
  const src = sourceType || 'any';
  const tgt = targetType || 'any';
  if (src === 'any' || tgt === 'any') return true;
  return (_compat[src] || _compat.any).has(tgt);
}

function checkValueType(value: unknown, expectedType: string): string | null {
  if (!expectedType || expectedType === 'any') return null;
  if (value == null) return null;
  switch (expectedType) {
    case 'string':  return typeof value !== 'string'  ? `expected string, got ${typeof value}` : null;
    case 'number':  return typeof value !== 'number'  ? `expected number, got ${typeof value}` : null;
    case 'boolean': return typeof value !== 'boolean' ? `expected boolean, got ${typeof value}` : null;
    case 'json':    return (typeof value !== 'object' || Array.isArray(value)) ? `expected json object, got ${Array.isArray(value) ? 'array' : typeof value}` : null;
    case 'array':   return !Array.isArray(value) ? `expected array, got ${typeof value}` : null;
    default:        return null;
  }
}

// ─── Card port defaults (mirrors io-registry cardPortOverrides) ─────────────
// Used for runtime type resolution when _portTypes has no user override.
interface PortDef { key: string; type: string }
const CARD_PORT_DEFAULTS: Record<string, { inputs: PortDef[]; outputs: PortDef[] }> = {
  agent:         { inputs: [{ key: 'input', type: 'json' }], outputs: [{ key: 'data', type: 'string' }, { key: 'status', type: 'number' }, { key: 'headers', type: 'json' }] },
  function:      { inputs: [{ key: 'input', type: 'json' }], outputs: [{ key: 'result', type: 'json' }] },
  response:      { inputs: [{ key: 'data', type: 'json' }, { key: 'status', type: 'number' }, { key: 'headers', type: 'json' }], outputs: [{ key: 'data', type: 'json' }, { key: 'status', type: 'number' }, { key: 'headers', type: 'json' }] },
  api:           { inputs: [{ key: 'input', type: 'json' }], outputs: [{ key: 'data', type: 'json' }, { key: 'status', type: 'number' }, { key: 'headers', type: 'json' }] },
  mapper:        { inputs: [{ key: 'input', type: 'any' }], outputs: [{ key: 'result', type: 'any' }] },
  filter:        { inputs: [{ key: 'input', type: 'json' }], outputs: [{ key: 'kept', type: 'json' }, { key: 'rejected', type: 'json' }] },
  merge:         { inputs: [{ key: 'input1', type: 'any' }, { key: 'input2', type: 'any' }], outputs: [{ key: 'merged', type: 'json' }] },
  error_handler: { inputs: [{ key: 'input', type: 'any' }], outputs: [{ key: 'result', type: 'any' }, { key: 'error', type: 'json' }] },
  ai_classifier: { inputs: [{ key: 'input', type: 'string' }], outputs: [{ key: 'category', type: 'string' }, { key: 'confidence', type: 'number' }] },
  user_input:    { inputs: [], outputs: [{ key: 'value', type: 'string' }] },
};

function resolvePortTypeTS(
  nodeId: string,
  handleId: string,
  side: 'source' | 'target',
  subBlockValues: Record<string, Record<string, unknown>>,
  nodes: WorkflowNode[],
): string {
  const nodeData = nodes.find((nd) => nd.id === nodeId)?.data;
  if (!nodeData) return 'any';
  const blockType = nodeData.blockType as string;
  const portTypes = ((subBlockValues[nodeId] || {})._portTypes || {}) as Record<string, string>;
  const card = CARD_PORT_DEFAULTS[blockType];

  if (side === 'target') {
    if (portTypes[handleId]) return portTypes[handleId];
    const key = handleId.startsWith('in_') ? handleId.slice(3) : null;
    if (key && card) {
      const port = card.inputs.find((p) => p.key === key);
      if (port) return port.type;
    }
    return 'any';
  } else {
    const ptKey = handleId === 'out' ? 'out_out' : (handleId.startsWith('out_') ? handleId : `out_${handleId}`);
    if (portTypes[ptKey]) return portTypes[ptKey];
    const key = handleId === 'out' ? null : (handleId.startsWith('out_') ? handleId.slice(4) : handleId);
    if (key && card) {
      const port = card.outputs.find((p) => p.key === key);
      if (port) return port.type;
    }
    return 'any';
  }
}

function jsonPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function interpolate(
  template: string,
  outputs: Record<string, unknown>,
  input: unknown
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim();
    if (trimmed === 'input') {
      return typeof input === 'object' ? JSON.stringify(input) : String(input ?? '');
    }
    const dotIdx = trimmed.indexOf('.');
    if (dotIdx > -1) {
      const nodeId = trimmed.slice(0, dotIdx);
      const field = trimmed.slice(dotIdx + 1);
      const nodeOutput = outputs[nodeId];
      if (nodeOutput != null && typeof nodeOutput === 'object') {
        const val = (nodeOutput as Record<string, unknown>)[field];
        return typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
      }
      return '';
    }
    if (outputs[trimmed] !== undefined) {
      const val = outputs[trimmed];
      return typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
    }
    return '';
  });
}

function interpolateBag(template: string, bag: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
    const trimmed = key.trim();
    const val = bag[trimmed];
    if (val === undefined) return '';
    return typeof val === 'object' ? JSON.stringify(val) : String(val);
  });
}

function evalSafe(expr: string, input: unknown): unknown {
  try {
    const fn = new Function('input', 'return ' + expr);
    return fn(input);
  } catch {
    return undefined;
  }
}
// --- Block Handlers ----------------------------------------------------------

async function runAgentNode(opts: {
  node: WorkflowNode;
  values: Record<string, unknown>;
  input: unknown;
}): Promise<unknown> {
  const { values, input } = opts;

  // Build bag from input
  const bag: Record<string, unknown> = {};
  if (typeof input === 'string') {
    bag['input'] = input;
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(bag, parsed);
      }
    } catch {
      if (/^https?:\/\//.test(input)) {
        bag['url'] = input;
      }
    }
  } else if (input && typeof input === 'object') {
    Object.assign(bag, input as Record<string, unknown>);
    bag['input'] = JSON.stringify(input);
  } else {
    bag['input'] = String(input ?? '');
  }

  const model = String(values.model || 'gpt-4o-mini');
  const provider = values.provider ? String(values.provider) : undefined;
  const temperature = Number(values.temperature ?? 0.7);
  const systemPrompt = interpolateBag(String(values.systemPrompt || ''), bag);
  const userPrompt = interpolateBag(String(values.userPrompt || '{{input}}'), bag);
  const responseFormat = values.responseFormat ? String(values.responseFormat) : null;
  const strictOutput = values.strictOutput === true;

  const agent = {
    id: String(values.id || opts.node.id),
    provider, model, temperature, systemPrompt, userPrompt,
    responseFormat,
    strictOutput,
  };
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);

  const llmRequest = { agent, input: inputStr };
  const res = await callAgent(llmRequest);

  return {
    __meta: { provider, model, temperature, systemPrompt, userPrompt, rawAgentResponse: res, llmRequest, llmResponse: res },
    value: {
      data: (res as { output?: unknown })?.output ?? res,
      status: 200,
      headers: { 'x-model': model, 'x-duration-ms': (res as { ms?: number })?.ms },
    },
  };
}

async function runMcpNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): Promise<unknown> {
  const { values, input } = opts;
  const serverId = String(values.server || '');
  const tool = String(values.tool || '');

  let args: Record<string, unknown> = {};
  const rawArgs = values.arguments || values.args;
  if (typeof rawArgs === 'string') {
    try {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
      args = JSON.parse(rawArgs.replace(/\{\{input\}\}/g, inputStr));
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs as Record<string, unknown>;
  }

  // Substitute {{input}} in string values
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
      args[k] = v.replace(/\{\{input\}\}/g, inputStr);
    }
  }

  const resp = await callTool(serverId, tool, args);
  return (resp as { result?: unknown })?.result ?? resp;
}

function runFunctionNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): unknown {
  const { values, input } = opts;
  const src = String(values.code || 'return input');
  try {
    // Pass `values` as second arg to match client (allows scripts to read block config)
    const fn = new Function('input', 'values', src);
    return fn(input, values);
  } catch (err) {
    throw new Error('Function node error: ' + (err as Error).message);
  }
}

function runIfElseNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { branch: string; value: unknown } {
  const { values, input } = opts;
  // Support both `expression` (client inspector field) and legacy `condition`
  const expr = String(values.expression || values.condition || 'true');
  const result = evalSafe(expr, input);
  return { branch: result ? 'true' : 'false', value: input };
}

function runIfElseIfElseNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { branch: string; value: unknown } {
  const { values, input } = opts;
  // Matches client format: rows in `values.conditions` ({label, expression} or [label, expression]),
  // count in `values.branches` (number), handles named branch_1, branch_2, ..., else.
  const rows: unknown[] = Array.isArray(values.conditions) ? values.conditions : [];
  const n = Math.max(1, Math.min(8, Number(values.branches) || rows.length || 2));
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    if (!row) continue;
    const expr = (row as Record<string, unknown>).expression ?? (Array.isArray(row) ? (row as unknown[])[1] : undefined);
    if (!expr) continue;
    if (evalSafe(String(expr), input)) {
      return { branch: `branch_${i + 1}`, value: input };
    }
  }
  return { branch: 'else', value: input };
}

function runSwitchNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { branch: string; value: unknown } {
  const { values, input } = opts;
  // Matches client: `values.keyExpr` for the key expression, `case_N` handles.
  const keyVal = values.keyExpr ? evalSafe(String(values.keyExpr), input) : input;
  const key = String(keyVal);

  const cases: unknown[] = Array.isArray(values.cases) ? values.cases : [];
  const n = Math.max(1, Math.min(12, Number(values.caseCount) || cases.length || 3));
  for (let i = 0; i < Math.min(n, cases.length); i++) {
    const c = cases[i] as Record<string, unknown>;
    const match = c.value ?? c.match ?? (Array.isArray(cases[i]) ? (cases[i] as unknown[])[0] : undefined);
    if (match != null && String(match) === key) {
      return { branch: `case_${i + 1}`, value: input };
    }
  }
  return { branch: 'default', value: input };
}

function runJsonValidator(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { valid: boolean; errors: string[]; value: unknown } {
  const { values, input } = opts;

  let parsed: unknown = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); }
    catch { return { valid: false, errors: ['input is not valid JSON'], value: input }; }
  }

  let rules: unknown[] = [];
  if (typeof values.rules === 'string') {
    try { rules = JSON.parse(values.rules); } catch { rules = []; }
  } else if (Array.isArray(values.rules)) {
    rules = values.rules;
  }

  const errors: string[] = [];
  for (const r of rules) {
    // Support both object format { path, rule, value } and positional array [path, rule, value]
    const path     = (r as Record<string, unknown>).path  ?? (Array.isArray(r) ? r[0] : undefined);
    const ruleType = (r as Record<string, unknown>).rule  ?? (Array.isArray(r) ? r[1] : undefined);
    const expected = (r as Record<string, unknown>).value ?? (Array.isArray(r) ? r[2] : undefined);
    if (!path) continue;
    const got = jsonPath(parsed, String(path));
    if (ruleType === 'exists' && got === undefined) errors.push(`${path} missing`);
    if (ruleType === 'equals' && String(got) !== String(expected)) errors.push(`${path} !== ${expected}`);
    if (ruleType === 'type' && typeof got !== String(expected)) errors.push(`${path} not a ${expected}`);
  }

  return { valid: errors.length === 0, errors, value: parsed };
}

function runJsonMapNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): unknown {
  const { values, input } = opts;

  let parsed: unknown = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return input; }
  }

  // Resolve mappings from table rows (mappingPairs) or raw JSON (mappings).
  const mappings = resolveMappings(values.mappingPairs, values.mappings);

  const result: Record<string, unknown> = {};
  for (const m of mappings) {
    result[m.key] = jsonPath(parsed, m.path);
  }
  return result;
}

/**
 * Resolve json_map mappings from either table rows or a raw JSON string/array.
 * Table rows are arrays of [key, path]. JSON can be a string or parsed array
 * of { key, path } objects.
 */
function resolveMappings(
  tableRows: unknown,
  rawMappings: unknown,
): Array<{ key: string; path: string }> {
  // Table rows take precedence when they have content.
  if (Array.isArray(tableRows) && tableRows.length > 0) {
    const fromTable = tableRows
      .map((row: unknown) => {
        if (!Array.isArray(row)) return null;
        const key = String(row[0] ?? '').trim();
        const path = String(row[1] ?? '').trim();
        if (!key) return null;
        return { key, path: path || '$' };
      })
      .filter((m): m is { key: string; path: string } => m !== null);
    if (fromTable.length > 0) return fromTable;
  }

  // Fall back to raw JSON (advanced mode or legacy workflows).
  if (!rawMappings) return [];
  if (typeof rawMappings === 'string') {
    try { return JSON.parse(rawMappings); } catch { return []; }
  }
  if (Array.isArray(rawMappings)) {
    return rawMappings as Array<{ key: string; path: string }>;
  }
  return [];
}

function runTextTemplateNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): string {
  const { values, input } = opts;
  const template = String(values.template || '');

  const bag: Record<string, unknown> = { input };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    Object.assign(bag, input as Record<string, unknown>);
  }

  return interpolateBag(template, bag);
}

function runJsonPathNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): unknown {
  const { values, input } = opts;

  let parsed: unknown = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { return input; }
  }

  const path = String(values.path || '');
  const result = jsonPath(parsed, path);
  // Match client: support fallback value when result is undefined
  if ((result === undefined || result === null) && values.fallback != null && values.fallback !== '') {
    return values.fallback;
  }
  return result !== undefined ? result : null;
}

/* ── Mapper block — type conversion ────────────────────────────────────────── */
function runMapperNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): unknown {
  const { values, input } = opts;
  const mode = String(values.mode || 'json_parse');
  switch (mode) {
    case 'json_parse': {
      if (typeof input === 'object' && input !== null) return input;
      if (typeof input !== 'string') return input;
      try { return JSON.parse(input); } catch { throw new Error('Mapper: input is not valid JSON'); }
    }
    case 'json_stringify':
      return typeof input === 'string' ? input : JSON.stringify(input);
    case 'to_number': {
      const n = Number(input);
      if (Number.isNaN(n)) throw new Error(`Mapper: cannot convert "${String(input).slice(0, 50)}" to number`);
      return n;
    }
    case 'to_boolean':
      if (typeof input === 'boolean') return input;
      if (input === 'true' || input === '1') return true;
      if (input === 'false' || input === '0' || input === '' || input == null) return false;
      return Boolean(input);
    case 'to_string':
      if (typeof input === 'string') return input;
      return input == null ? '' : (typeof input === 'object' ? JSON.stringify(input) : String(input));
    default:
      return input;
  }
}

async function runApiNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): Promise<unknown> {
  const { values, input } = opts;
  const method = String(values.method || 'GET').toUpperCase();
  let url = String(values.url || '');

  // Build query params
  let params: Array<{ Key?: string; Value?: string }> = [];
  if (typeof values.params === 'string') {
    try { params = JSON.parse(values.params); } catch { params = []; }
  } else if (Array.isArray(values.params)) {
    params = values.params as Array<{ Key?: string; Value?: string }>;
  }
  if (params.length > 0) {
    const qs = params
      .filter((p) => p.Key)
      .map((p) => encodeURIComponent(p.Key!) + '=' + encodeURIComponent(String(p.Value ?? '')))
      .join('&');
    url += (url.includes('?') ? '&' : '?') + qs;
  }

  // Build headers
  let headerEntries: Array<{ Key?: string; Value?: string }> = [];
  if (typeof values.headers === 'string') {
    try { headerEntries = JSON.parse(values.headers); } catch { headerEntries = []; }
  } else if (Array.isArray(values.headers)) {
    headerEntries = values.headers as Array<{ Key?: string; Value?: string }>;
  }
  const headers: Record<string, string> = {};
  for (const h of headerEntries) {
    if (h.Key) headers[h.Key] = String(h.Value ?? '');
  }

  // Build body
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const rawBody = values.body;
    if (typeof rawBody === 'string' && rawBody.trim()) {
      body = rawBody;
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  try {
    const resp = await fetch(url, { method, headers, body });
    const contentType = resp.headers.get('content-type') || '';
    let data: unknown;
    if (contentType.includes('application/json')) {
      data = await resp.json();
    } else {
      data = await resp.text();
    }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { data, status: resp.status, headers: respHeaders };
  } catch (err) {
    return { data: null, status: 0, headers: {}, error: (err as Error).message };
  }
}

async function runDelayNode(opts: {
  values: Record<string, unknown>;
}): Promise<{ output: unknown; elapsed: number }> {
  const { values } = opts;
  const duration = Number(values.duration ?? 0);
  const unit = String(values.unit || 'ms');
  let ms = duration;
  if (unit === 's') ms = duration * 1000;
  else if (unit === 'm') ms = duration * 60_000;
  else if (unit === 'h') ms = duration * 3_600_000;
  const t0 = Date.now();
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { output: null, elapsed: Date.now() - t0 };
}

async function runWaitNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): Promise<{ output: unknown; elapsed: number }> {
  const { values, input } = opts;
  const mode = String(values.mode || 'duration');
  const t0 = Date.now();
  if (mode === 'until') {
    const until = new Date(String(values.until || new Date().toISOString())).getTime();
    const now = Date.now();
    const diff = Math.max(0, until - now);
    await new Promise((resolve) => setTimeout(resolve, diff));
  } else {
    const ms = Number(values.duration ?? 0);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  return { output: input, elapsed: Date.now() - t0 };
}

function runFilterNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { kept: unknown[]; rejected: unknown[]; count: number } {
  const { values, input } = opts;
  const mode = String(values.mode || 'keep');
  let arr: unknown[] = [];
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === 'string') {
    try { const p = JSON.parse(input); if (Array.isArray(p)) arr = p; } catch { arr = []; }
  }
  const condSrc = String(values.conditions || 'return true');
  let filterFn: (item: unknown, index: number) => boolean;
  try {
    filterFn = new Function('item', 'index', condSrc) as (item: unknown, index: number) => boolean;
  } catch {
    return { kept: arr, rejected: [], count: arr.length };
  }
  const kept: unknown[] = [];
  const rejected: unknown[] = [];
  for (let i = 0; i < arr.length; i++) {
    const result = filterFn(arr[i], i);
    if ((mode === 'keep' && result) || (mode === 'remove' && !result)) {
      kept.push(arr[i]);
    } else {
      rejected.push(arr[i]);
    }
  }
  return { kept, rejected, count: kept.length };
}

function runSortNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { sorted: unknown[]; count: number } {
  const { values, input } = opts;
  const sortKey = String(values.sortKey || '');
  const order = String(values.order || 'asc');
  let arr: unknown[] = [];
  if (Array.isArray(input)) {
    arr = [...input];
  } else if (typeof input === 'string') {
    try { const p = JSON.parse(input); if (Array.isArray(p)) arr = [...p]; } catch { arr = []; }
  }
  arr.sort((a, b) => {
    let va: unknown = a;
    let vb: unknown = b;
    if (sortKey && typeof a === 'object' && a !== null) va = (a as Record<string, unknown>)[sortKey];
    if (sortKey && typeof b === 'object' && b !== null) vb = (b as Record<string, unknown>)[sortKey];
    if (va === vb) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const cmp = String(va) < String(vb) ? -1 : 1;
    return order === 'desc' ? -cmp : cmp;
  });
  return { sorted: arr, count: arr.length };
}

function runAggregateNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { result: unknown; count: number } {
  const { values, input } = opts;
  const operation = String(values.operation || 'count');
  const field = String(values.field || '');
  let arr: unknown[] = [];
  if (Array.isArray(input)) {
    arr = input;
  } else if (typeof input === 'string') {
    try { const p = JSON.parse(input); if (Array.isArray(p)) arr = p; } catch { arr = []; }
  }
  const extract = (item: unknown): unknown => {
    if (!field) return item;
    if (item && typeof item === 'object') return (item as Record<string, unknown>)[field];
    return item;
  };
  const nums = arr.map(extract).map(Number).filter((n) => !isNaN(n));
  switch (operation) {
    case 'sum':
      return { result: nums.reduce((a, b) => a + b, 0), count: arr.length };
    case 'count':
      return { result: arr.length, count: arr.length };
    case 'avg':
      return { result: nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0, count: arr.length };
    case 'min':
      return { result: nums.length > 0 ? Math.min(...nums) : null, count: arr.length };
    case 'max':
      return { result: nums.length > 0 ? Math.max(...nums) : null, count: arr.length };
    case 'concat':
      return { result: arr.map(extract), count: arr.length };
    case 'group': {
      const groups: Record<string, unknown[]> = {};
      for (const item of arr) {
        const key = String(extract(item) ?? 'undefined');
        if (!groups[key]) groups[key] = [];
        groups[key].push(item);
      }
      return { result: groups, count: arr.length };
    }
    case 'custom': {
      const customSrc = String(values.customFn || 'return input');
      try {
        const fn = new Function('input', customSrc);
        return { result: fn(arr), count: arr.length };
      } catch {
        return { result: null, count: arr.length };
      }
    }
    default:
      return { result: arr.length, count: arr.length };
  }
}

function runMergeNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { merged: unknown; count: number } {
  const { values, input } = opts;
  const mode = String(values.mode || 'append');
  const inputs: unknown[] = Array.isArray(input) ? input : [input];

  switch (mode) {
    case 'append': {
      const merged: unknown[] = [];
      for (const item of inputs) {
        if (Array.isArray(item)) merged.push(...item);
        else merged.push(item);
      }
      return { merged, count: merged.length };
    }
    case 'position': {
      const merged: unknown[] = [];
      for (let i = 0; i < inputs.length; i++) {
        merged[i] = inputs[i];
      }
      return { merged, count: merged.length };
    }
    case 'key': {
      const merged: Record<string, unknown> = {};
      for (const item of inputs) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          Object.assign(merged, item);
        }
      }
      return { merged, count: Object.keys(merged).length };
    }
    case 'match': {
      const merged: Record<string, unknown> = {};
      for (const item of inputs) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          Object.assign(merged, item);
        }
      }
      return { merged, count: Object.keys(merged).length };
    }
    case 'dedupe': {
      const merged: unknown[] = [];
      const seen = new Set<string>();
      for (const item of inputs) {
        const items = Array.isArray(item) ? item : [item];
        for (const i of items) {
          const key = JSON.stringify(i);
          if (!seen.has(key)) { seen.add(key); merged.push(i); }
        }
      }
      return { merged, count: merged.length };
    }
    default: {
      const merged: unknown[] = [];
      for (const item of inputs) {
        if (Array.isArray(item)) merged.push(...item);
        else merged.push(item);
      }
      return { merged, count: merged.length };
    }
  }
}

function runCryptoNode(opts: {
  values: Record<string, unknown>;
}): { result: string } {
  const { values } = opts;
  const operation = String(values.operation || 'sha256');
  const data = String(values.data ?? '');
  const secret = String(values.secret ?? '');

  switch (operation) {
    case 'sha256':
      return { result: createHash('sha256').update(data).digest('hex') };
    case 'md5':
      return { result: createHash('md5').update(data).digest('hex') };
    case 'base64_encode':
      return { result: Buffer.from(data).toString('base64') };
    case 'base64_decode':
      return { result: Buffer.from(data, 'base64').toString('utf-8') };
    case 'url_encode':
      return { result: encodeURIComponent(data) };
    case 'url_decode':
      return { result: decodeURIComponent(data) };
    case 'uuid':
      return { result: randomUUID() };
    case 'hmac_sha256':
      return { result: createHmac('sha256', secret).update(data).digest('hex') };
    default:
      return { result: data };
  }
}

function runErrorHandlerNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { result: unknown; error: null; retryCount: number } {
  const { values, input } = opts;
  const strategy = String(values.strategy || 'fallback');
  if (strategy === 'fallback' && values.fallbackValue !== undefined) {
    return { result: values.fallbackValue, error: null, retryCount: 0 };
  }
  return { result: input, error: null, retryCount: 0 };
}

function runHttpResponseNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { sent: boolean; statusCode: number; body: unknown } {
  const { values, input } = opts;
  const statusCode = Number(values.statusCode ?? 200);
  let body: unknown = input;
  if (values.body !== undefined && values.body !== '') {
    body = values.body;
  }
  return { sent: true, statusCode, body };
}

function runSubWorkflowNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { result: unknown; status: string; duration: number } {
  const { input } = opts;
  // Full sub-workflow execution requires loading the workflow from the workspace
  return { result: input, status: 'pass-through', duration: 0 };
}

async function runAiClassifierNode(opts: {
  node: WorkflowNode;
  values: Record<string, unknown>;
  input: unknown;
}): Promise<{ category: string; confidence: number; allScores: Record<string, number> }> {
  const { values, input } = opts;
  const categories = String(values.categories || '').split(',').map((c) => c.trim()).filter(Boolean);
  const text = String(values.text || (typeof input === 'string' ? input : JSON.stringify(input)));
  const instructions = String(values.instructions || '');
  const model = String(values.model || 'gpt-4o-mini');

  const systemPrompt =
    'You are a text classifier. Classify the given text into exactly one of these categories: ' +
    categories.join(', ') +
    '. ' +
    (instructions ? 'Additional instructions: ' + instructions + '. ' : '') +
    'Respond with ONLY a JSON object in the format: {"category":"<chosen>","confidence":<0_to_1>}';

  const agent = { id: opts.node.id, model, temperature: 0, systemPrompt, userPrompt: text };
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
  try {
    const res = await callAgent({ agent, input: inputStr });
    const raw = String((res as { output?: unknown })?.output ?? res);
    const parsed = JSON.parse(raw);
    const allScores: Record<string, number> = {};
    for (const c of categories) {
      allScores[c] = c === parsed.category ? (parsed.confidence ?? 1) : 0;
    }
    return { category: parsed.category ?? categories[0] ?? '', confidence: parsed.confidence ?? 0, allScores };
  } catch {
    return { category: categories[0] ?? 'unknown', confidence: 0, allScores: {} };
  }
}

function runVariablesNode(opts: {
  values: Record<string, unknown>;
}): Record<string, unknown> {
  const { values } = opts;
  let vars: Array<{ variableName: string; value: unknown }> = [];
  if (typeof values.variables === 'string') {
    try { vars = JSON.parse(values.variables); } catch { vars = []; }
  } else if (Array.isArray(values.variables)) {
    vars = values.variables as Array<{ variableName: string; value: unknown }>;
  }
  const result: Record<string, unknown> = {};
  for (const v of vars) {
    if (v.variableName) result[v.variableName] = v.value;
  }
  return result;
}

function runConditionNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
}): { branch: string; value: unknown } {
  const { values, input } = opts;
  let conditions: Array<{ id: string; expression: string }> = [];
  if (typeof values.conditions === 'string') {
    try { conditions = JSON.parse(values.conditions); } catch { conditions = []; }
  } else if (Array.isArray(values.conditions)) {
    conditions = values.conditions as Array<{ id: string; expression: string }>;
  }
  for (const cond of conditions) {
    const result = evalSafe(cond.expression, input);
    if (result) return { branch: cond.id, value: input };
  }
  return { branch: 'else', value: input };
}

async function runRouterV2Node(opts: {
  node: WorkflowNode;
  values: Record<string, unknown>;
  input: unknown;
}): Promise<{ branch: string; value: unknown }> {
  const { values, input } = opts;
  const context = String(values.context || (typeof input === 'string' ? input : JSON.stringify(input)));
  const model = String(values.model || 'gpt-4o-mini');
  let routes: Array<{ id: string; description: string }> = [];
  if (typeof values.routes === 'string') {
    try { routes = JSON.parse(values.routes); } catch { routes = []; }
  } else if (Array.isArray(values.routes)) {
    routes = values.routes as Array<{ id: string; description: string }>;
  }
  if (routes.length === 0) return { branch: 'default', value: input };

  const routeList = routes.map((r, i) => (i + 1) + '. id=' + r.id + ': ' + r.description).join('\n');
  const systemPrompt =
    'You are a router. Given the context below, choose the best matching route.\n' +
    'Available routes:\n' + routeList + '\n\n' +
    'Respond with ONLY the route id (nothing else).';

  const agent = { id: opts.node.id, model, temperature: 0, systemPrompt, userPrompt: context };
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
  try {
    const res = await callAgent({ agent, input: inputStr });
    const raw = String((res as { output?: unknown })?.output ?? res).trim();
    const matched = routes.find((r) => r.id === raw);
    return { branch: matched ? matched.id : routes[0].id, value: input };
  } catch {
    return { branch: routes[0]?.id ?? 'default', value: input };
  }
}

// --- Node Dispatcher ---------------------------------------------------------

async function runNode(opts: {
  node: WorkflowNode;
  values: Record<string, unknown>;
  input: unknown;
  outputs: Record<string, unknown>;
  inputsByHandle: Record<string, unknown>;
}): Promise<unknown> {
  const { node, values, input, outputs, inputsByHandle } = opts;
  const blockType = node.data?.blockType;

  switch (blockType) {
    case 'starter':
    case 'user_input':
      return outputs[node.id];

    case 'response':
      return runResponseNode({ values, input, inputsByHandle, outputs });

    case 'agent':
      return await runAgentNode({ node, values, input });

    case 'mcp':
      return await runMcpNode({ values, input });

    case 'function':
      return runFunctionNode({ values, input });

    case 'if_else':
      return runIfElseNode({ values, input });

    case 'if_elseif_else':
      return runIfElseIfElseNode({ values, input });

    case 'switch':
      return runSwitchNode({ values, input });

    case 'for_loop':
    case 'for_each':
      return input;

    case 'json_validator':
      return runJsonValidator({ values, input });

    case 'json_map':
      return runJsonMapNode({ values, input });

    case 'text_template':
      return runTextTemplateNode({ values, input });

    case 'json_path':
      return runJsonPathNode({ values, input });

    case 'show_preview':
      return input;


    case 'save_to_files':
      return input;

    case 'api':
      return await runApiNode({ values, input });

    case 'delay':
      return await runDelayNode({ values });

    case 'wait':
      return await runWaitNode({ values, input });

    case 'filter':
      return runFilterNode({ values, input });

    case 'sort':
      return runSortNode({ values, input });

    case 'aggregate':
      return runAggregateNode({ values, input });

    case 'merge':
      return runMergeNode({ values, input });

    case 'crypto':
      return runCryptoNode({ values });

    case 'error_handler':
      return runErrorHandlerNode({ values, input });

    case 'http_response':
      return runHttpResponseNode({ values, input });

    case 'sub_workflow':
      return runSubWorkflowNode({ values, input });

    case 'ai_classifier':
      return await runAiClassifierNode({ node, values, input });

    case 'slack':
      return { ok: false, error: 'Slack integration requires server-side execution via convengine' };

    case 'smtp':
      return { success: false, error: 'SMTP requires server-side execution via convengine' };

    case 'postgresql':
      return { error: 'PostgreSQL requires server-side execution via convengine' };

    case 'redis':
      return { error: 'Redis requires server-side execution via convengine' };

    case 'mongodb':
      return { error: 'MongoDB requires server-side execution via convengine' };

    case 'schedule':
      return { firedAt: new Date().toISOString() };

    case 'webhook_request':
      return { body: input, headers: {}, query: {} };

    case 'variables':
      return runVariablesNode({ values });

    case 'condition':
      return runConditionNode({ values, input });

    case 'router_v2':
      return await runRouterV2Node({ node, values, input });

    case 'loop':
    case 'parallel':
      return input;

    case 'table':
      return input;
    case 'mapper':
      return runMapperNode({ values, input });

    // Skill blocks execute client-side JS — the server cannot run them.
    // Pass the input through so the trace still records this node.
    case 'skill':
      return input;
    default:
      return input;
  }
}
function runResponseNode(opts: {
  values: Record<string, unknown>;
  input: unknown;
  inputsByHandle: Record<string, unknown>;
  outputs: Record<string, unknown>;
}): { data: unknown; status: number; headers: unknown } {
  const { values, input, inputsByHandle, outputs } = opts;
  const data = inputsByHandle?.data ?? (values.data ? interpolate(String(values.data), outputs, input) : input);
  const status = inputsByHandle?.status != null ? Number(inputsByHandle.status) : (values.status ? Number(values.status) : 200);
  let headers: unknown = inputsByHandle?.headers ?? null;
  if (headers == null && values.headers) {
    if (typeof values.headers === 'string') {
      try { headers = JSON.parse(values.headers); } catch { headers = values.headers; }
    } else {
      headers = values.headers;
    }
  }
  return { data, status, headers };
}

// --- GraphValidationError ----------------------------------------------------

export class GraphValidationError extends Error {
  nodeId: string | null;
  nodeTitle: string | null;
  blockType: string | null;
  severity: string;
  hint: string | null;
  affectedNodes: Array<{ id: string; title: string; blockType?: string }>;
  errorDetail: Record<string, unknown>;

  constructor(message: string, details: {
    nodeId?: string; nodeTitle?: string; blockType?: string;
    severity?: string; hint?: string; cause?: string;
    affectedNodes?: Array<{ id: string; title: string; blockType?: string }>;
    extra?: Record<string, unknown>;
  } = {}) {
    super(message);
    this.name = 'GraphValidationError';
    this.nodeId = details.nodeId || null;
    this.nodeTitle = details.nodeTitle || null;
    this.blockType = details.blockType || null;
    this.severity = details.severity || 'error';
    this.hint = details.hint || null;
    this.affectedNodes = details.affectedNodes || [];
    this.errorDetail = {
      message,
      nodeId: this.nodeId,
      nodeTitle: this.nodeTitle,
      blockType: this.blockType,
      cause: details.cause || null,
      stack: this.stack,
      timestamp: new Date().toISOString(),
      ...details.extra,
    };
  }
}

// --- Core Graph Executor -----------------------------------------------------

export async function executeGraph(opts: {
  workflow: Workflow;
  inputs: Record<string, unknown>;
}): Promise<RunResult> {
  const { workflow, inputs } = opts;
  const { nodes: allNodes, edges: allEdges, subBlockValues } = workflow;

  // ── Identify disabled nodes (they will pass-through input as output) ──
  const disabledIds = new Set(allNodes.filter((n) => n.data?.disabled).map((n) => n.id));
  const nodes = allNodes;
  const edges = allEdges;

  // ── Compute reachable nodes from starter/user_input via edges ────────
  const reachable = new Set<string>();
  const outgoingAll: Record<string, WorkflowEdge[]> = {};
  for (const e of edges) {
    if (!outgoingAll[e.source]) outgoingAll[e.source] = [];
    outgoingAll[e.source].push(e);
  }
  const seedIds = nodes
    .filter((n) => n.data?.blockType === 'starter' || n.data?.blockType === 'user_input')
    .map((n) => n.id);
  const bfsQueue = [...seedIds];
  for (const id of bfsQueue) {
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const e of (outgoingAll[id] || [])) {
      if (!reachable.has(e.target)) bfsQueue.push(e.target);
    }
  }

  // Build lookup maps
  const nodesById: Record<string, WorkflowNode> = {};
  for (const n of nodes) {
    nodesById[n.id] = n;
  }

  // ── Validate: non-seed nodes must be reachable from Start ────────────
  const seedTypes = new Set(['starter', 'user_input']);
  for (const n of nodes) {
    if (seedTypes.has(n.data?.blockType as string)) continue;
    if (disabledIds.has(n.id)) continue;
    if (!reachable.has(n.id)) {
      const title = n.data?.title || n.data?.blockType || n.id;
      const allUnconnected = nodes
        .filter((nd) => !seedTypes.has(nd.data?.blockType as string) && !disabledIds.has(nd.id) && !reachable.has(nd.id))
        .map((nd) => ({ id: nd.id, title: (nd.data?.title || nd.data?.blockType || nd.id) as string, blockType: nd.data?.blockType as string }));
      throw new GraphValidationError(
        `"${title}" has no input connection — it is unreachable from any Start or User Input node.`,
        {
          nodeId: n.id,
          nodeTitle: title as string,
          blockType: n.data?.blockType as string,
          cause: 'No incoming edges found. The graph executor can only run nodes that are connected downstream from a Start or User Input node.',
          hint: 'Connect an edge from another block\'s output to this block\'s input, or disable it (right-click → Disable).',
          affectedNodes: allUnconnected,
          extra: {
            totalNodes: nodes.length,
            totalEdges: edges.length,
            reachableCount: reachable.size,
            unreachableNodes: allUnconnected,
          },
        }
      );
    }
  }

  const outgoing = groupBy(edges, 'source' as keyof WorkflowEdge);
  const incoming = groupBy(edges, 'target' as keyof WorkflowEdge);

  // State
  const outputs: Record<string, unknown> = {};
  const trace: TraceEntry[] = [];
  const started = new Set<string>();
  const chosenHandle: Record<string, string | null> = {};

  // Seed starter and user_input nodes.
  // Use key-presence checks so falsy typed values (false, 0, '') are preserved.
  for (const n of nodes) {
    const blockType = n.data?.blockType;
    if (blockType === 'user_input') {
      const hasInput = Object.prototype.hasOwnProperty.call(inputs || {}, n.id);
      outputs[n.id] = hasInput ? inputs[n.id] : null;
      started.add(n.id);
      trace.push({
        nodeId: n.id,
        blockType,
        title: n.data?.title,
        input: hasInput ? inputs[n.id] : null,
        output: outputs[n.id],
        ms: 0,
      });
    } else if (blockType === 'starter') {
      // In chat mode the browser passes inputs.__chat__ = { message, history }.
      // Seed the starter with that payload so downstream nodes receive it as input.
      const chatPayload = (inputs as Record<string, unknown>).__chat__ ?? null;
      outputs[n.id] = chatPayload;
      started.add(n.id);
      trace.push({
        nodeId: n.id,
        blockType,
        title: n.data?.title,
        input: null,
        output: chatPayload,
        ms: 0,
        ...(chatPayload ? { meta: { source: 'chat message' } } : {}),
      });
    }
  }

  // BFS loop with readiness gating
  const edgeIsLive = (e: WorkflowEdge): boolean => {
    if (!started.has(e.source)) return false;
    const chosen = chosenHandle[e.source];
    if (chosen !== undefined) {
      return e.sourceHandle === chosen;
    }
    return true;
  };

  let iterations = 0;
  const maxIterations = nodes.length * 2; // safety bound

  while (iterations++ < maxIterations) {
    // Find ready nodes
    const ready: WorkflowNode[] = [];
    for (const n of nodes) {
      if (started.has(n.id)) continue;
      if (!reachable.has(n.id)) continue;
      const inEdges = incoming[n.id];
      if (!inEdges || inEdges.length === 0) continue;
      const allLive = inEdges.every(edgeIsLive);
      if (allLive) {
        ready.push(n);
      }
    }

    if (ready.length === 0) break;

    // Run all ready nodes in parallel
    await Promise.all(
      ready.map(async (n) => {
        started.add(n.id);
        const blockType = n.data?.blockType;
        const title = n.data?.title;

        // Compute upstream inputs
        const inEdges = incoming[n.id] || [];
        // Resolve per-edge output: if the edge's sourceHandle is a named
        // handle like "out_status", extract just that field from the source
        // node's output object. Legacy "out" on multi-output blocks resolves
        // to the first output port's key.
        const resolveEdgeOutput = (e: { source: string; sourceHandle?: string }) => {
          const full = outputs[e.source];
          const sh = e.sourceHandle || 'out';
          if (sh === 'out' || full == null || typeof full !== 'object') return full;
          const field = sh.startsWith('out_') ? sh.slice(4) : sh;
          return (field in (full as Record<string, unknown>)) ? (full as Record<string, unknown>)[field] : full;
        };
        const upstream = inEdges.map(resolveEdgeOutput);
        const input = upstream.length <= 1 ? upstream[0] : upstream;
        // Build per-handle input map so blocks with multiple typed inputs
        // (e.g. response: data, status, headers) can read from each handle.
        const inputsByHandle: Record<string, unknown> = {};
        for (const e of inEdges) {
          const th = e.targetHandle || 'in';
          // Normalize legacy "in" handle → "input" key (most blocks' first port)
          const key = th === 'in' ? 'input' : (th.startsWith('in_') ? th.slice(3) : th);
          // Skip duplicate: if a proper in_* edge already wrote this key, don't overwrite
          if (key in inputsByHandle) continue;
          inputsByHandle[key] = resolveEdgeOutput(e);
        }

        const values = (subBlockValues[n.id] || {}) as Record<string, unknown>;

        const t0 = Date.now();
        try {
          // ── Disabled node: pass-through input → output (ComfyUI-style) ──
          if (disabledIds.has(n.id)) {
            outputs[n.id] = input;
            trace.push({
              nodeId: n.id,
              blockType: blockType as string,
              title: title as string,
              input,
              output: input,
              ms: Date.now() - t0,
            });
            return;
          }

          // ── Runtime port type validation ──────────────────────────────
          for (const e of inEdges) {
            // If the upstream node is disabled it is a pass-through — trace
            // back to its actual predecessor and use that node's output type,
            // so the real type flowing through is validated correctly.
            let srcType: string;
            if (disabledIds.has(e.source)) {
              const prevEdge = (incoming[e.source] || [])[0];
              srcType = prevEdge
                ? resolvePortTypeTS(prevEdge.source, prevEdge.sourceHandle || 'out', 'source', subBlockValues, nodes)
                : 'any';
            } else {
              srcType = resolvePortTypeTS(e.source, e.sourceHandle || 'out', 'source', subBlockValues, nodes);
            }
            const th = e.targetHandle || 'in';
            const tgtType = resolvePortTypeTS(n.id, th, 'target', subBlockValues, nodes);
            if (!isRuntimeTypeCompatible(srcType, tgtType)) {
              const srcTitle = nodesById[e.source]?.data?.title || e.source;
              const tgtTitle = n.data?.title || n.id;
              throw new Error(
                `Type mismatch: "${srcTitle}" output (${srcType}) is not compatible with "${tgtTitle}" input (${tgtType})`
              );
            }
            const val = resolveEdgeOutput(e);
            const rtErr = checkValueType(val, tgtType);
            if (rtErr) {
              const srcTitle = nodesById[e.source]?.data?.title || e.source;
              const tgtTitle = n.data?.title || n.id;
              throw new Error(
                `Runtime type error: "${srcTitle}" → "${tgtTitle}": ${rtErr}`
              );
            }
          }

          let result = await runNode({ node: n, values, input, outputs, inputsByHandle });

          let meta: Record<string, unknown> | undefined;

          // Handle __meta wrapper
          if (result && typeof result === 'object' && '__meta' in (result as object)) {
            const wrapped = result as { __meta: Record<string, unknown>; value: unknown };
            meta = wrapped.__meta;
            result = wrapped.value;
          }

          // Handle branching
          if (
            result &&
            typeof result === 'object' &&
            'branch' in (result as object) &&
            typeof (result as { branch: unknown }).branch === 'string'
          ) {
            const branched = result as { branch: string; value: unknown };
            chosenHandle[n.id] = branched.branch;
            outputs[n.id] = branched.value;
          } else {
            outputs[n.id] = result;
          }

          // ── Runtime output type validation ──────────────────────────
          const outEdges = outgoing[n.id] || [];
          for (const e of outEdges) {
            const srcHandle = e.sourceHandle || 'out';
            const declaredType = resolvePortTypeTS(n.id, srcHandle, 'source', subBlockValues, nodes);
            const outVal = resolveEdgeOutput(e);
            const rtErr = checkValueType(outVal, declaredType);
            if (rtErr) {
              const srcTitle = n.data?.title || n.id;
              throw new GraphValidationError(
                `Output type error on "${srcTitle}": ${rtErr}`,
                {
                  nodeId: n.id,
                  nodeTitle: srcTitle as string,
                  blockType: n.data?.blockType as string,
                  cause: `Port "${srcHandle}" produced a value that doesn't match its declared type "${declaredType}".`,
                  hint: `Check the output of "${srcTitle}" — the port expects ${declaredType}.`,
                }
              );
            }
          }

          const ms = Date.now() - t0;
          trace.push({
            nodeId: n.id,
            blockType,
            title,
            input,
            inputsByHandle,
            output: outputs[n.id],
            values,
            meta,
            ms,
          });
        } catch (err) {
          const ms = Date.now() - t0;
          const errorMsg = (err as Error).message || String(err);
          trace.push({
            nodeId: n.id,
            blockType,
            title,
            input,
            inputsByHandle,
            error: errorMsg,
            errorDetail: { stack: (err as Error).stack },
            ms,
          });
          throw err;
        }
      })
    );
  }

  // Determine final output
  let output: unknown;
  const responseNode = nodes.find((n) => n.data?.blockType === 'response');
  if (responseNode && outputs[responseNode.id] !== undefined) {
    output = outputs[responseNode.id];
  } else if (trace.length > 0) {
    output = trace[trace.length - 1].output;
  } else {
    output = null;
  }

  return { output, trace };
}
