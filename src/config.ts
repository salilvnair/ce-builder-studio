/** Centralised config — reads env vars with sane defaults. */
export const config = {
  port: Number(process.env.PORT) || 3001,
  host: process.env.HOST || '0.0.0.0',

  /** ConvEngine backend base (for proxying agent + MCP calls) */
  convengineBase: (process.env.CONVENGINE_BASE || 'http://localhost:8080/api/v1').replace(/\/$/, ''),

  /** Direct LLM keys (optional — falls back to proxying through ConvEngine) */
  openaiKey: process.env.OPENAI_API_KEY || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',

  /** Postgres connection string */
  databaseUrl: process.env.DATABASE_URL || '',

  /**
   * In-process cron scheduler (setInterval-based).
   * Disabled by default — not safe for multi-replica AKS deployments.
   * Use Azure AKS CronJob -> POST /builder-studio/scheduler/start instead.
   * Set USE_IN_PROCESS_CRON=true only for single-instance / local dev.
   */
  useInProcessCron: process.env.USE_IN_PROCESS_CRON === 'true',
}
