# SYNC_AGENT.md — Block Sync Checklist

---

## Why this monorepo exists

This monorepo (`convengine-ui-builder`) contains **two** packages that share
the same DAG-execution logic:

| Package | Runtime | Role |
|---|---|---|
| `convengine-ui/` | Browser (React + Vite) | Canvas UI + **client-side** graph runner (`graph-runner.js`) |
| `ce-builder-studio/` | Node.js (Fastify) | **Server-side** graph runner (`graph-runner.ts`) + cron scheduler + webhook listener |

A third repo, **convengine-demo** (Spring Boot, separate Git root), provides:
- LLM proxy (`/builder-studio/agent`)
- Postgres persistence (`/builder-studio/workspace/*`)
- MCP server management (`/mcp/servers/*`)
- Chat / FAQ features (`/conversation/message`)

It does **not** contain a graph runner and cannot execute workflows.

### When each runner is used

| Scenario | Executor | ce-builder-studio needed? |
|---|---|---|
| Admin clicks **Run** in browser | Browser `graph-runner.js` | No |
| Cron fires at 2 AM (no browser) | `ce-builder-studio` `graph-runner.ts` | **Yes** |
| External webhook hits | `ce-builder-studio` | **Yes** |
| Another system calls "execute workflow X" via API | `ce-builder-studio` | **Yes** |
| Chat FAQ question/answer | `convengine-demo` (existing) | No — different feature |

### Typical AKS deployment

```
Pod 1: convengine-ui (:5173)
  → Static React app
  → Builder Studio canvas (drag-drop blocks)
  → Browser runs graph-runner.js when admin clicks "Run"

Pod 2: convengine-demo (:8080)
  → Spring Boot
  → LLM calls, Postgres persistence, MCP
  → Does NOT have a graph runner

Pod 3: ce-builder-studio (:3001)
  → Node.js Fastify (~80 MB)
  → Server-side graph runner (walks nodes/edges/branches)
  → Proxies LLM / workspace / MCP calls → convengine-demo
  → Runs cron workflows, webhooks, API-triggered executions
```

### End-to-end flow

1. **Build** — Admin drags blocks, connects edges in the canvas.
2. **Save** — `POST /builder-studio/workspace/{id}/sync` → ce-builder-studio → convengine-demo → Postgres.
3. **Run (interactive)** — Browser `graph-runner.js` walks the DAG locally; `agent` nodes proxy to convengine-demo for LLM calls.
4. **Deploy** — `POST /builder-studio/workflow/{id}/deploy` → ce-builder-studio registers the cron/webhook.
5. **Server execution** — Cron/webhook fires → ce-builder-studio loads the workflow from convengine-demo, walks the DAG server-side, proxies LLM calls back to convengine-demo, logs the result.

---

## Block sync checklist

> **Purpose**: When a new block is added to the **convengine-ui** (frontend) or
> **ce-builder-studio** (backend), the other side must be updated to match.
> This document lists every coupling point so an LLM agent (Claude Opus, Codex,
> etc.) can perform the sync without missing anything.

---

## Architecture overview

```
convengine-ui/src/builder-studio/   ← Frontend (React + ReactFlow)
  blocks/
    blocks/<type>.js                ← Block definition (schema, subBlocks, inputs, outputs)
    blocks/index.js                 ← Barrel export
    registry.js                     ← Runtime registry (maps type string → BlockConfig)
  run/
    graph-runner.js                 ← Client-side executor (switch on blockType)
  panel/
    io-registry.js                  ← Card port overrides & type colors
  docs/
    block-docs-entries.js           ← Help panel content per block
    block-docs-registry.js          ← Doc registration API
  extensions/                       ← Auto-discovered extension blocks (glob)

ce-builder-studio/src/              ← Backend (Fastify + TypeScript)
  engine/
    graph-runner.ts                 ← Server-side executor (switch on blockType)
  routes/
    deploy.ts                       ← Deploy / scheduler / webhook routes
  engine/
    scheduler.ts                    ← Deployment store + execution
```

---

## The 7 touch-points when adding a new block

### Touch-point 1 — Frontend block definition

**File**: `convengine-ui/src/builder-studio/blocks/blocks/<new_type>.js`

Create a new file exporting a `BlockConfig` object. Use an existing block as
a template (e.g. `filter.js` for data blocks, `agent.js` for LLM blocks).

Required fields:
```js
export const MyNewBlock = {
  type: 'my_new',            // MUST match the case label on both graph runners
  name: 'My New Block',
  description: 'One-line summary',
  category: 'blocks',        // or 'tools', 'triggers'
  bgColor: '#hexcolor',
  icon: SomeIcon,            // from components/icons.jsx or inline SVG
  subBlocks: [ ... ],        // sub-block inputs the user configures in the inspector
  inputs:  { ... },          // typed port definitions
  outputs: { ... },          // typed port definitions
}
```

**Key rules**:
- `type` must be a valid JS identifier using `snake_case`.
- Every field in `subBlocks` has an `id` — these become keys in
  `subBlockValues[nodeId]` and are what both graph runners read via
  `values.<id>`.
- `inputs` / `outputs` define the typed ports visible in the inspector.


---

### Touch-point 2 — Frontend barrel export

**File**: `convengine-ui/src/builder-studio/blocks/blocks/index.js`

Add one line:
```js
export { MyNewBlock } from './my_new'
```

Without this, the registry import `* as Core from './blocks'` will not see it.

---

### Touch-point 3 — Frontend registry entry

**File**: `convengine-ui/src/builder-studio/blocks/registry.js`

Add one entry to the `registry` object:
```js
my_new: Core.MyNewBlock,
```

The key **must exactly match** the `type` field from touch-point 1.

---

### Touch-point 4 — Frontend client-side graph runner

**File**: `convengine-ui/src/builder-studio/run/graph-runner.js`

Inside the `runNode()` function there is a `switch (type)` statement.
Add a `case` for the new block type.

Three patterns:

**a) Simple pass-through** (the block just forwards input):
```js
case 'my_new':
  return input
```

**b) Pure JS logic** (runs entirely in the browser):
```js
case 'my_new':
  return runMyNewNode({ values, input })
```
Then define `function runMyNewNode({ values, input }) { ... }` above
`runNode` in the same file.

**c) Server-dependent** (needs LLM, DB, HTTP from server):
```js
case 'my_new':
  return await runMyNewNode({ node, values, input })
```
Where `runMyNewNode` calls the backend via `fetch('/builder-studio/...')`.

> **IMPORTANT**: If you only add the case on the frontend but not the backend,
> the block will work in "Run in browser" mode but fail on deployed workflows.
> If you only add it on the backend, the canvas will show it as pass-through.

---

### Touch-point 5 — Backend server-side graph runner (CRITICAL)

**File**: `ce-builder-studio/src/engine/graph-runner.ts`

This is the **most important sync point**. Inside `async function runNode()`
there is a `switch (blockType)` with ~45 cases.

Add a case for the new block. The pattern mirrors touch-point 4 but in
TypeScript and with access to server-side resources (DB, secrets, HTTP).

**Step-by-step**:

1. Add a handler function above `runNode()`:
```ts
function runMyNewNode(opts: {
  values: Record<string, unknown>
  input: unknown
}): unknown {
  const { values, input } = opts
  // Read sub-block values using the same ids from touch-point 1
  const someSetting = String(values.someSetting ?? '')
  // ... logic ...
  return result
}
```

2. Add the case inside `runNode()`:
```ts
case 'my_new':
  return runMyNewNode({ values, input })
```

**Sub-block value contract**: The keys you read from `values` (e.g.
`values.someSetting`) MUST match the `id` fields in the frontend block's
`subBlocks` array from touch-point 1. This is the data contract between
frontend and backend.

```
Frontend subBlocks:        Backend values access:
  { id: 'expression' }  →   values.expression
  { id: 'mode' }        →   values.mode
  { id: 'template' }    →   values.template
```


---

### Touch-point 6 — Frontend IO registry (optional)

**File**: `convengine-ui/src/builder-studio/panel/io-registry.js`

Only needed if the block needs non-standard card port display. Most blocks
work fine with auto-derivation. Add an override only if:

- The block is a **trigger** (no input ports): `{ inputs: [], outputs: 'auto' }`
- The block has **branching outputs** (like if_else): `{ inputs: 'auto', outputs: [] }`
- You want a **custom port summary**: explicit `[{ key, type }]` arrays.

```js
const cardPortOverrides = {
  // ... existing entries ...
  my_new: { inputs: 'auto', outputs: 'auto' },  // or explicit
}
```

If you skip this, auto-derivation kicks in — which is correct 90% of the time.

---

### Touch-point 7 — Frontend block docs (optional but recommended)

**File**: `convengine-ui/src/builder-studio/docs/block-docs-entries.js`

Register help content so the inspector's "?" icon shows documentation:

```js
registerBlockDocs('my_new', {
  title: 'My New Block',
  icon: '🆕',
  category: 'tool',
  summary: 'One-line description of what this block does.',
  fields: [
    { name: 'someSetting', label: 'Some Setting', type: 'string',
      description: 'What this setting controls.' },
  ],
})
```

---

## Quick-reference: file checklist

When adding block type `xyz`:

| # | File | Action | Required? |
|---|------|--------|-----------|
| 1 | `convengine-ui/.../blocks/blocks/xyz.js` | Create block definition | **YES** |
| 2 | `convengine-ui/.../blocks/blocks/index.js` | Add export line | **YES** |
| 3 | `convengine-ui/.../blocks/registry.js` | Add registry entry | **YES** |
| 4 | `convengine-ui/.../run/graph-runner.js` | Add `case 'xyz'` in `runNode()` | **YES** |
| 5 | `ce-builder-studio/src/engine/graph-runner.ts` | Add `case 'xyz'` in `runNode()` + handler | **YES** |
| 6 | `convengine-ui/.../panel/io-registry.js` | Add card port override | Only if non-standard ports |
| 7 | `convengine-ui/.../docs/block-docs-entries.js` | Add help docs | Recommended |


---

## Verification commands

After adding a new block, run these checks:

### 1. TypeScript compilation (backend)
```bash
cd ce-builder-studio && npx tsc --noEmit
```
Must exit with zero errors. Catches missing imports, type mismatches in the
new handler function, and typos in the switch case.

### 2. Vite build (frontend)
```bash
cd convengine-ui && npm run build
```
Catches missing exports in `index.js`, broken imports in `registry.js`, and
syntax errors in the new block definition.

### 3. Registry parity check (manual or scripted)
Compare the set of keys in:
- `convengine-ui/.../blocks/registry.js` → the `registry` object keys
- `ce-builder-studio/src/engine/graph-runner.ts` → the `case` labels in `runNode()`

Every key in the frontend registry should have a corresponding case in the
backend `runNode()`. The backend may have extra pass-through cases — that is
fine. But any frontend key MISSING from the backend means deployed workflows
will silently skip that block.

Quick one-liner to diff:
```bash
# Extract frontend block types
grep -oP "^\s+(\w+):" convengine-ui/src/builder-studio/blocks/registry.js | \
  sed 's/[: ]//g' | sort > /tmp/fe-blocks.txt

# Extract backend case labels
grep -oP "case '(\w+)'" ce-builder-studio/src/engine/graph-runner.ts | \
  sed "s/case '//;s/'//" | sort -u > /tmp/be-blocks.txt

# Show blocks in frontend but missing from backend
comm -23 /tmp/fe-blocks.txt /tmp/be-blocks.txt
```
This should output nothing. If it outputs block type names, those blocks
need a backend case.


---

## LLM agent prompt template

Copy-paste this prompt to Claude Opus, Codex, or any coding LLM to add a
new block end-to-end:

---

> **Task**: Add a new block type `<BLOCK_TYPE>` to the convengine-ui-builder
> project. The block should: `<DESCRIPTION>`.
>
> Follow SYNC_AGENT.md in the repo root. You must touch all 5 required files
> (and optionally files 6-7). Here are the exact steps:
>
> 1. Create `convengine-ui/src/builder-studio/blocks/blocks/<BLOCK_TYPE>.js`
>    with the full BlockConfig (type, name, description, category, bgColor,
>    icon, subBlocks, inputs, outputs). Use `filter.js` as a template for
>    data-processing blocks or `agent.js` for LLM blocks.
>
> 2. Add `export { <ExportName> } from './<BLOCK_TYPE>'` to
>    `convengine-ui/src/builder-studio/blocks/blocks/index.js`.
>
> 3. Add `<BLOCK_TYPE>: Core.<ExportName>,` to the `registry` object in
>    `convengine-ui/src/builder-studio/blocks/registry.js`.
>
> 4. Add `case '<BLOCK_TYPE>':` to the `switch (type)` in `runNode()` inside
>    `convengine-ui/src/builder-studio/run/graph-runner.js`. If the block
>    needs a handler function, define it above `runNode()`.
>
> 5. Add `case '<BLOCK_TYPE>':` to the `switch (blockType)` in `runNode()`
>    inside `ce-builder-studio/src/engine/graph-runner.ts`. Define a
>    TypeScript handler function above `runNode()`. Read sub-block values
>    using the same `id` strings from step 1's `subBlocks` array.
>
> 6. (Optional) If the block has non-standard ports, add an entry in
>    `convengine-ui/src/builder-studio/panel/io-registry.js`.
>
> 7. (Optional) Add block docs in
>    `convengine-ui/src/builder-studio/docs/block-docs-entries.js`.
>
> After all changes, verify:
> - `cd ce-builder-studio && npx tsc --noEmit` passes
> - `cd convengine-ui && npm run build` passes
> - The `case` label string in both graph runners matches the `type` field
>   in the block definition exactly.
> - The `values.<id>` keys read in both graph runners match the `subBlocks[].id`
>   fields in the block definition.

---

## Common mistakes to avoid

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Block type string mismatch (`my-new` vs `my_new`) | Block appears in palette but does nothing on run | Use `snake_case` everywhere; check `type` field matches both `case` labels |
| Missing `index.js` export | `Core.MyNewBlock is undefined` at startup | Add the export line in `blocks/index.js` |
| Missing registry entry | Block doesn't show in palette | Add to `registry` object in `registry.js` |
| SubBlock `id` mismatch | Block runs but produces wrong/empty output | Compare `subBlocks[].id` in the `.js` definition with `values.xxx` in both graph runners |
| Backend case missing | Works in browser Run but fails on deployed workflow execution | Add the `case` in `ce-builder-studio/src/engine/graph-runner.ts` |
| Frontend case missing | Deployed execution works, but browser Run shows pass-through | Add the `case` in `convengine-ui/src/builder-studio/run/graph-runner.js` |
| Async handler not awaited | Intermittent `[object Promise]` output | Use `return await runMyNewNode(...)` for any handler that does async work |
| Icon not imported | Build error or missing icon on canvas | Import from `components/icons.jsx` or define inline |


---

## Current block inventory (for reference)

Last updated: 2025-07-16

These blocks exist in BOTH frontend registry AND backend graph-runner:

| Block type | Category | Backend handler |
|------------|----------|-----------------|
| `starter` | trigger | pass-through (seeded) |
| `user_input` | trigger | pass-through (seeded) |
| `agent` | AI | `runAgentNode` — LLM call |
| `function` | logic | `runFunctionNode` — sandboxed JS eval |
| `response` | output | interpolate template |
| `if_else` | control | `runIfElseNode` — branching |
| `if_elseif_else` | control | `runIfElseIfElseNode` — multi-branch |
| `switch` | control | `runSwitchNode` — multi-case |
| `condition` | control | `runConditionNode` — boolean conditions |
| `for_loop` | control | pass-through (loop expansion TBD) |
| `for_each` | control | pass-through (loop expansion TBD) |
| `loop` | control | pass-through |
| `parallel` | control | pass-through |
| `variables` | data | `runVariablesNode` — key-value store |
| `json_map` | data | `runJsonMapNode` — field mapping |
| `json_path` | data | `runJsonPathNode` — dot-path extraction |
| `json_validator` | data | `runJsonValidator` — schema validation |
| `text_template` | data | `runTextTemplateNode` — mustache-style |
| `filter` | data | `runFilterNode` — array filter |
| `sort` | data | `runSortNode` — array sort |
| `aggregate` | data | `runAggregateNode` — sum/avg/group |
| `merge` | data | `runMergeNode` — combine arrays/objects |
| `crypto` | data | `runCryptoNode` — hash/encode/decode |
| `api` | integration | `runApiNode` — HTTP request |
| `mcp` | integration | `runMcpNode` — MCP tool call |
| `delay` | utility | `runDelayNode` — sleep |
| `wait` | utility | `runWaitNode` — wait until time |
| `show_preview` | utility | pass-through |
| `save_to_files` | utility | pass-through |
| `table` | utility | pass-through |
| `error_handler` | utility | `runErrorHandlerNode` |
| `http_response` | output | `runHttpResponseNode` |
| `sub_workflow` | advanced | `runSubWorkflowNode` (stub) |
| `ai_classifier` | AI | `runAiClassifierNode` — LLM classification |
| `router_v2` | AI | `runRouterV2Node` — LLM-based routing |
| `schedule` | trigger | returns `{ firedAt }` |
| `webhook_request` | trigger | returns request data |
| `slack` | integration | stub (needs server impl) |
| `smtp` | integration | stub (needs server impl) |
| `postgresql` | integration | stub (needs server impl) |
| `redis` | integration | stub (needs server impl) |
| `mongodb` | integration | stub (needs server impl) |

---

## Extension blocks (auto-discovered)

Frontend blocks dropped into `convengine-ui/src/builder-studio/extensions/*.js`
are auto-discovered by Vite glob import and registered at runtime. These do
NOT need entries in `index.js` or `registry.js`.

However, they still need:
- A `case` in the frontend `graph-runner.js` `runNode()` switch
- A `case` in the backend `graph-runner.ts` `runNode()` switch

The extension glob only handles the block definition and palette registration.
Execution logic must be manually added to both runners.

---

## Route / API sync points

These are less frequent but still important:

| Frontend file | Backend file | Coupling |
|---------------|-------------|----------|
| `api/run-client.js` | `routes/run.ts` | `POST /builder-studio/run` payload shape |
| `api/deploy-client.js` | `routes/deploy.ts` | Deploy/undeploy/list/scheduler payloads |
| `api/workspace-client.js` | `routes/workspace.ts` | Workspace sync/load payloads |
| `mcp/mcp-client.js` | `routes/mcp.ts` | MCP tool proxy payloads |

If you add a new **route** on the backend, add or update the corresponding
client function on the frontend side.

---

## Summary for LLM agents

**When told "add a new block":**
1. Read this file first.
2. Touch ALL 5 required files (touch-points 1-5).
3. The `type` string must be identical across all files.
4. The `subBlocks[].id` values are the data contract — backend reads them as `values.<id>`.
5. Run `tsc --noEmit` and `npm run build` to verify.
6. Use the parity check one-liner to confirm no blocks are missing from either side.
