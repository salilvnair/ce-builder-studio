import type { FastifyInstance, FastifyRequest } from 'fastify'
import { callAgent } from '../services/llm.js'
import type { AgentRequest } from '../types/index.js'

export default async function (app: FastifyInstance) {
  app.post(
    '/builder-studio/agent',
    async (req: FastifyRequest<{ Body: AgentRequest }>, reply) => {
      try {
        const result = await callAgent(req.body)
        return reply.send({
          output: result.output,
          model: result.model,
          ms: result.ms,
        })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )
}
