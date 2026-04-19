import type { FastifyInstance, FastifyRequest } from 'fastify'
import { executeGraph } from '../engine/graph-runner.js'
import type { Workflow } from '../types/index.js'

interface RunBody {
  workflow: Workflow
  inputs: Record<string, unknown>
}

export default async function (app: FastifyInstance) {
  app.post(
    '/builder-studio/run',
    async (req: FastifyRequest<{ Body: RunBody }>, reply) => {
      try {
        const { workflow, inputs } = req.body

        if (!workflow?.nodes || !workflow?.edges) {
          return reply.status(400).send({ error: 'workflow must include nodes and edges' })
        }

        const result = await executeGraph({ workflow, inputs: inputs || {} })
        return reply.send({ output: result.output, trace: result.trace })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )
}
