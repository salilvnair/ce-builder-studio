import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getScheduler } from '../engine/scheduler.js'

interface DeployBody {
  workflowId: string
  workflow: {
    nodes: any[]
    edges: any[]
    subBlockValues: Record<string, Record<string, unknown>>
  }
  trigger?: {
    type: 'cron' | 'webhook' | 'manual'
    cron?: string
    timezone?: string
  }
}

interface UndeployBody {
  workflowId: string
}

export default async function (app: FastifyInstance) {

  // ────────────────────────────────────────────────────────────────
  //  PRIMARY — AKS CronJob target
  //
  //  POST /builder-studio/scheduler/start
  //
  //  Executes every deployed workflow whose trigger.type === 'cron'.
  //  Configure an Azure AKS CronJob to hit this endpoint on schedule.
  //
  //  Optional body: { workflowId: "wf_xxx" }
  //    — when present, only that single workflow is executed.
  //    — when absent, ALL cron-deployed workflows are executed.
  //
  //  AKS CronJob YAML example:
  //
  //    apiVersion: batch/v1
  //    kind: CronJob
  //    metadata:
  //      name: ce-scheduler-tick
  //    spec:
  //      schedule: "*/5 * * * *"
  //      timeZone: "Asia/Kolkata"
  //      concurrencyPolicy: Forbid
  //      jobTemplate:
  //        spec:
  //          template:
  //            spec:
  //              containers:
  //              - name: trigger
  //                image: curlimages/curl:latest
  //                command:
  //                - curl
  //                - -sf
  //                - -X
  //                - POST
  //                - -H
  //                - "Content-Type: application/json"
  //                - http://ce-builder-studio:3001/builder-studio/scheduler/start
  //              restartPolicy: Never
  //          backoffLimit: 1
  //
  // ────────────────────────────────────────────────────────────────
  app.post(
    '/builder-studio/scheduler/start',
    async (req: FastifyRequest<{ Body?: { workflowId?: string } }>, reply) => {
      try {
        const scheduler = getScheduler()
        const body = (req.body || {}) as { workflowId?: string }

        // If a specific workflowId is given, execute only that one
        if (body.workflowId) {
          const result = await scheduler.execute(body.workflowId)
          return reply.send({
            ok: true,
            workflowId: body.workflowId,
            output: result.output,
            trace: result.trace,
            durationMs: result.durationMs,
          })
        }

        // Otherwise execute ALL cron-deployed workflows
        const results = await scheduler.executeAllCron()
        return reply.send({
          ok: true,
          executed: results.length,
          results,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const status = message.includes('not deployed') ? 404 : 500
        return reply.status(status).send({ error: message })
      }
    },
  )

  // ── Deploy a workflow ──────────────────────────────────────────
  app.post('/builder-studio/deploy', async (req: FastifyRequest<{ Body: DeployBody }>, reply) => {
    try {
      const { workflowId, workflow, trigger } = req.body
      if (!workflowId || !workflow) {
        return reply.status(400).send({ error: 'workflowId and workflow are required' })
      }
      const scheduler = getScheduler()
      const result = scheduler.deploy(workflowId, workflow, trigger)
      return reply.send({ ok: true, workflowId, ...result })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: message })
    }
  })

  // ── Execute a single deployed workflow (by path param) ─────────
  // Kept for convenience / backward compat — also usable by AKS CronJob
  app.post(
    '/builder-studio/execute/:workflowId',
    async (req: FastifyRequest<{ Params: { workflowId: string }; Body?: Record<string, unknown> }>, reply) => {
      try {
        const scheduler = getScheduler()
        const inputs = (req.body as Record<string, unknown>) || {}
        const result = await scheduler.execute(req.params.workflowId, inputs)
        return reply.send({
          ok: true,
          workflowId: req.params.workflowId,
          output: result.output,
          trace: result.trace,
          durationMs: result.durationMs,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        const status = message.includes('not deployed') ? 404 : 500
        return reply.status(status).send({ error: message })
      }
    },
  )

  // ── Undeploy a workflow ────────────────────────────────────────
  app.post('/builder-studio/undeploy', async (req: FastifyRequest<{ Body: UndeployBody }>, reply) => {
    try {
      const { workflowId } = req.body
      if (!workflowId) return reply.status(400).send({ error: 'workflowId is required' })
      const scheduler = getScheduler()
      scheduler.undeploy(workflowId)
      return reply.send({ ok: true, workflowId })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: message })
    }
  })

  // ── List all deployed workflows ────────────────────────────────
  app.get('/builder-studio/deployments', async (_req, reply) => {
    const scheduler = getScheduler()
    return reply.send({ deployments: scheduler.listDeployments() })
  })

  // ── Webhook trigger endpoint ───────────────────────────────────
  app.all('/hook/:workflowId', async (req: FastifyRequest<{ Params: { workflowId: string } }>, reply) => {
    try {
      const scheduler = getScheduler()
      const result = await scheduler.triggerWebhook(req.params.workflowId, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        query: req.query as Record<string, string>,
        body: (req.body as Record<string, unknown>) || {},
      })
      const output = result?.output as Record<string, unknown> | undefined
      if (output?.statusCode) {
        return reply.status(Number(output.statusCode) || 200).send(output.body ?? output)
      }
      return reply.send({ ok: true, output: result?.output, trace: result?.trace })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const status = message.includes('not deployed') ? 404 : 500
      return reply.status(status).send({ error: message })
    }
  })
}
