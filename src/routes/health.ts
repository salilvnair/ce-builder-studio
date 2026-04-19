import type { FastifyInstance } from 'fastify'

export default async function (app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    return reply.send({ status: 'ok', uptime: process.uptime() })
  })
}
