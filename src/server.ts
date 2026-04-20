import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'

import { config } from './config.js'
import agentRoutes from './routes/agent.js'
import runRoutes from './routes/run.js'
import workspaceRoutes from './routes/workspace.js'
import mcpRoutes from './routes/mcp.js'
import healthRoutes from './routes/health.js'
import deployRoutes from './routes/deploy.js'
import providerRoutes from './routes/provider.js'

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: 'info',
    },
  })

  // -- Plugins --
  await app.register(cors, { origin: true })
  await app.register(sensible)

  // -- Content-type parser (10 MB limit) --
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 10 * 1024 * 1024 },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body as string))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // -- Routes (all under /api/v1 to match convengine-demo convention) --
  await app.register(async function apiV1(api) {
    await api.register(agentRoutes)
    await api.register(runRoutes)
    await api.register(workspaceRoutes)
    await api.register(mcpRoutes)
    await api.register(providerRoutes)
    await api.register(deployRoutes)
  }, { prefix: '/api/v1' })

  // Health check stays at root
  await app.register(healthRoutes)

  return app
}

async function start(): Promise<void> {
  const app = await buildServer()

  try {
    await app.listen({ port: config.port, host: config.host })
    app.log.info("Server listening on http://" + config.host + ":" + config.port)
    app.log.info("ConvEngine base URL: " + config.convengineBase)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
