const LEVEL_ORDER: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };
const DEFAULT_LEVEL = 20;
const SECRET_KEY = /(authorization|token|secret|password|credential|service.?role|api.?key|signing|vault)/i;

export interface BclifLoggerContext {
  nodeId: string;
  instanceId: string;
  modelVersion: string;
}

export class BclifStructuredLogger {
  private readonly minimum: number;
  private readonly context: BclifLoggerContext;
  constructor(context: BclifLoggerContext, level = "INFO") {
    this.context = context;
    this.minimum = LEVEL_ORDER[level] ?? DEFAULT_LEVEL;
  }

  debug(event: string, fields: Record<string, unknown> = {}) { this.write("DEBUG", event, fields); }
  info(event: string, fields: Record<string, unknown> = {}) { this.write("INFO", event, fields); }
  warn(event: string, fields: Record<string, unknown> = {}) { this.write("WARNING", event, fields); }
  error(event: string, fields: Record<string, unknown> = {}) { this.write("ERROR", event, fields); }

  private write(level: string, event: string, fields: Record<string, unknown>) {
    if ((LEVEL_ORDER[level] ?? DEFAULT_LEVEL) < this.minimum) return;
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...this.context,
      ...redactRecord(fields)
    }));
  }
}

function redactRecord(value: Record<string, unknown>) {
  return redact(value) as Record<string, unknown>;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[DEPTH_LIMIT]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1);
  }
  return output;
}
