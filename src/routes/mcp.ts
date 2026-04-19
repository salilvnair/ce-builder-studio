import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  listServers,
  upsertServer,
  deleteServer,
  listTools,
  callTool,
} from '../services/mcp.js'

export default async function (app: FastifyInstance) {
  app.get('/mcp/servers', async (_req, reply) => {
    try {
      const data = await listServers()
      return reply.send(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: message })
    }
  })

  app.post('/mcp/servers', async (req, reply) => {
    try {
      const data = await upsertServer(req.body)
      return reply.send(data)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: message })
    }
  })

  app.delete(
    '/mcp/servers/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        const data = await deleteServer(req.params.id)
        return reply.send(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )

  app.get(
    '/mcp/servers/:id/tools',
    async (
      req: FastifyRequest<{
        Params: { id: string }
        Querystring: { refresh?: string }
      }>,
      reply,
    ) => {
      try {
        const refresh = req.query.refresh === 'true'
        const data = await listTools(req.params.id, refresh)
        return reply.send(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )

  app.post(
    '/mcp/servers/:id/tools/:tool/call',
    async (
      req: FastifyRequest<{
        Params: { id: string; tool: string }
        Body: { arguments: Record<string, unknown> }
      }>,
      reply,
    ) => {
      try {
        const data = await callTool(req.params.id, req.params.tool, req.body.arguments)
        return reply.send(data)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )
}
