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

  // -- Routes (registered at root; route files already define full paths) --
  await app.register(agentRoutes)
  await app.register(runRoutes)
  await app.register(workspaceRoutes)
  await app.register(mcpRoutes)
  await app.register(healthRoutes)
  await app.register(deployRoutes)

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
