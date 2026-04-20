import type { FastifyInstance, FastifyRequest } from 'fastify'
import { changeProvider, getAvailableProviders } from '../services/provider.js'

type ChangeProviderBody = {
  provider?: string
  model?: string
  temperature?: number
}

export default async function (app: FastifyInstance) {
  app.get('/builder-studio/llm/providers', async (_req, reply) => {
    try {
      return reply.send(await getAvailableProviders())
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: message })
    }
  })

  app.post(
    '/builder-studio/llm/provider',
    async (req: FastifyRequest<{ Body: ChangeProviderBody }>, reply) => {
      try {
        return reply.send(await changeProvider(req.body || {}))
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )
}