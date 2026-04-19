import type { FastifyInstance, FastifyRequest } from 'fastify'
import { syncWorkspace, loadWorkspace } from '../services/workspace.js'
import type { WorkspaceSnapshot } from '../types/index.js'

export default async function (app: FastifyInstance) {
  app.post(
    '/builder-studio/workspace/:id/sync',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: WorkspaceSnapshot }>,
      reply,
    ) => {
      try {
        await syncWorkspace(req.params.id, req.body)
        return reply.send({ ok: true })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )

  app.get(
    '/builder-studio/workspace/:id',
    async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      try {
        const snapshot = await loadWorkspace(req.params.id)
        if (!snapshot) {
          return reply.status(404).send({ error: 'Workspace not found' })
        }
        return reply.send(snapshot)
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        return reply.status(500).send({ error: message })
      }
    },
  )
}
