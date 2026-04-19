import { executeGraph } from './graph-runner.js'
import { config } from '../config.js'

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TriggerConfig {
  type: 'cron' | 'webhook' | 'manual'
  cron?: string
  timezone?: string
  webhookPath?: string
}

interface DeployedWorkflow {
  workflowId: string
  workflow: { nodes: any[]; edges: any[]; subBlockValues: Record<string, Record<string, unknown>> }
  trigger?: TriggerConfig
  deployedAt: string
  cronTimer?: ReturnType<typeof setInterval> // only when useInProcessCron = true
  lastRun?: string
  lastResult?: { success: boolean; error?: string }
}

interface WebhookInput {
  method: string
  headers: Record<string, string>
  query: Record<string, string>
  body: Record<string, unknown>
}

interface ExecutionResult {
  output: unknown
  trace: unknown[]
  durationMs: number
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const deployments = new Map<string, DeployedWorkflow>()

function parseCronToMs(cron: string): number | null {
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return null

  const [min, hour, dom] = parts

  if (min.startsWith('*/') && hour === '*' && dom === '*') {
    const n = parseInt(min.slice(2), 10)
    if (!isNaN(n) && n > 0) return n * 60 * 1000
  }
  if (min === '0' && hour.startsWith('*/') && dom === '*') {
    const n = parseInt(hour.slice(2), 10)
    if (!isNaN(n) && n > 0) return n * 60 * 60 * 1000
  }
  if (min === '0' && hour === '*') return 60 * 60 * 1000
  if (min === '0' && !hour.includes('*') && !hour.includes('/') && dom === '*') {
    return 24 * 60 * 60 * 1000
  }

  console.warn('[scheduler] Complex cron "' + cron + '" not fully parsed; defaulting to hourly')
  return 60 * 60 * 1000
}

/* ------------------------------------------------------------------ */
/*  Scheduler                                                          */
/* ------------------------------------------------------------------ */

class Scheduler {

  /* ---- Deploy --------------------------------------------------- */

  deploy(workflowId: string, workflow: any, trigger?: TriggerConfig) {
    this.undeploy(workflowId)

    const deployed: DeployedWorkflow = {
      workflowId,
      workflow,
      trigger,
      deployedAt: new Date().toISOString(),
    }

    // In-process cron (opt-in fallback, single-instance / dev only).
    // Disabled by default.  Enable with  USE_IN_PROCESS_CRON=true.
    // For production AKS multi-replica pods use the
    //   POST /builder-studio/scheduler/start
    // endpoint via an Azure AKS CronJob instead.
    if (config.useInProcessCron && trigger?.type === 'cron' && trigger.cron) {
      const intervalMs = parseCronToMs(trigger.cron)
      if (intervalMs) {
        console.log(
          '[scheduler] In-process cron ON for ' + workflowId + ': "' + trigger.cron + '" (every ' + intervalMs + 'ms)',
        )
        deployed.cronTimer = setInterval(async () => {
          console.log('[scheduler] In-process cron firing for ' + workflowId)
          try {
            const result = await executeGraph({ workflow, inputs: {} })
            deployed.lastRun = new Date().toISOString()
            deployed.lastResult = { success: true }
            console.log('[scheduler] Cron run completed for ' + workflowId, {
              output:
                typeof result.output === 'string'
                  ? result.output.slice(0, 200)
                  : JSON.stringify(result.output)?.slice(0, 200),
              traceLength: result.trace?.length,
            })
          } catch (err) {
            deployed.lastRun = new Date().toISOString()
            deployed.lastResult = { success: false, error: String(err) }
            console.error('[scheduler] Cron run failed for ' + workflowId + ':', err)
          }
        }, intervalMs)
      }
    } else if (trigger?.type === 'cron' && trigger.cron) {
      console.log(
        '[scheduler] Workflow ' + workflowId + ' deployed with cron "' + trigger.cron + '". ' +
          'In-process cron is OFF. Use AKS CronJob -> POST /builder-studio/scheduler/start',
      )
    }

    deployments.set(workflowId, deployed)

    return {
      trigger: trigger?.type || 'manual',
      cron: trigger?.cron,
      timezone: trigger?.timezone,
      webhookUrl: trigger?.type === 'webhook' ? '/hook/' + workflowId : undefined,
      cronInterval:
        trigger?.type === 'cron' && trigger.cron ? parseCronToMs(trigger.cron) : undefined,
    }
  }

  /* ---- Undeploy ------------------------------------------------- */

  undeploy(workflowId: string) {
    const existing = deployments.get(workflowId)
    if (existing?.cronTimer) {
      clearInterval(existing.cronTimer)
      console.log('[scheduler] Stopped in-process cron for ' + workflowId)
    }
    deployments.delete(workflowId)
  }

  /* ---- List ----------------------------------------------------- */

  listDeployments() {
    return Array.from(deployments.values()).map((d) => ({
      workflowId: d.workflowId,
      trigger: d.trigger,
      deployedAt: d.deployedAt,
      lastRun: d.lastRun,
      lastResult: d.lastResult,
    }))
  }

  /* ---- Execute one workflow (AKS CronJob / manual / tests) ------ */

  async execute(
    workflowId: string,
    inputs?: Record<string, unknown>,
  ): Promise<ExecutionResult> {
    const deployed = deployments.get(workflowId)
    if (!deployed) {
      throw new Error('Workflow ' + workflowId + ' is not deployed')
    }

    console.log('[scheduler] Executing workflow ' + workflowId)
    const t0 = Date.now()

    try {
      const result = await executeGraph({
        workflow: deployed.workflow,
        inputs: inputs || {},
      })
      deployed.lastRun = new Date().toISOString()
      deployed.lastResult = { success: true }
      const durationMs = Date.now() - t0
      console.log('[scheduler] Workflow ' + workflowId + ' completed in ' + durationMs + 'ms')
      return { output: result.output, trace: result.trace, durationMs }
    } catch (err) {
      deployed.lastRun = new Date().toISOString()
      deployed.lastResult = { success: false, error: String(err) }
      console.error('[scheduler] Workflow ' + workflowId + ' failed:', err)
      throw err
    }
  }

  /* ---- Execute ALL cron-deployed workflows ---------------------- */
  /*  Called by  POST /builder-studio/scheduler/start               */
  /*  (the endpoint that AKS CronJob hits)                          */

  async executeAllCron(): Promise<
    { workflowId: string; ok: boolean; durationMs?: number; error?: string }[]
  > {
    const cronDeployments = Array.from(deployments.values()).filter(
      (d) => d.trigger?.type === 'cron',
    )

    if (cronDeployments.length === 0) {
      console.log('[scheduler] scheduler/start called but no cron workflows deployed')
      return []
    }

    console.log(
      '[scheduler] scheduler/start — executing ' + cronDeployments.length + ' cron workflow(s)',
    )

    const results: { workflowId: string; ok: boolean; durationMs?: number; error?: string }[] = []

    for (const d of cronDeployments) {
      try {
        const r = await this.execute(d.workflowId)
        results.push({ workflowId: d.workflowId, ok: true, durationMs: r.durationMs })
      } catch (err) {
        results.push({
          workflowId: d.workflowId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return results
  }

  /* ---- Webhook trigger ------------------------------------------ */

  async triggerWebhook(workflowId: string, webhookInput: WebhookInput) {
    const deployed = deployments.get(workflowId)
    if (!deployed) {
      throw new Error('Workflow ' + workflowId + ' is not deployed')
    }

    const inputs: Record<string, unknown> = {}
    for (const node of deployed.workflow.nodes) {
      if (node.data?.blockType === 'webhook_request') {
        inputs[node.id] = webhookInput.body
      }
    }

    console.log('[scheduler] Webhook triggered for ' + workflowId)
    const result = await executeGraph({ workflow: deployed.workflow, inputs })
    deployed.lastRun = new Date().toISOString()
    deployed.lastResult = { success: true }
    return result
  }

  /* ---- Lookup --------------------------------------------------- */

  getDeployment(workflowId: string) {
    return deployments.get(workflowId)
  }
}

/* ------------------------------------------------------------------ */
/*  Singleton                                                          */
/* ------------------------------------------------------------------ */

let scheduler: Scheduler | null = null

export function getScheduler(): Scheduler {
  if (!scheduler) scheduler = new Scheduler()
  return scheduler
}
