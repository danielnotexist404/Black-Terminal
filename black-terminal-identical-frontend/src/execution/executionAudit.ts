import type { ExecutionReport, ExecutionRequest } from "./types";

export type ExecutionAuditRecord = {
  id: string;
  userId?: string;
  source: string;
  orderId: string;
  exchange: string;
  destinations: string[];
  executionTime: number;
  latencyMs?: number;
  result: string;
  riskDecision?: string;
  allocationDecision?: string;
  errors?: string[];
  diagnosticContext?: Record<string, unknown>;
};

class ExecutionAuditBuffer {
  private records: ExecutionAuditRecord[] = [];

  append(record: ExecutionAuditRecord) {
    this.records = [record, ...this.records].slice(0, 500);
  }

  list() {
    return [...this.records];
  }
}

export const blackCoreExecutionAudit = new ExecutionAuditBuffer();

export function auditExecutionRequest(request: ExecutionRequest, result: string, patch: Partial<ExecutionAuditRecord> = {}) {
  blackCoreExecutionAudit.append({
    id: `${request.internalOrderId}-${Date.now()}`,
    userId: request.userId,
    source: request.source,
    orderId: request.internalOrderId,
    exchange: request.exchange,
    destinations: request.destinations,
    executionTime: Date.now(),
    result,
    ...patch
  });
}

export function auditExecutionReport(report: ExecutionReport, request: ExecutionRequest, patch: Partial<ExecutionAuditRecord> = {}) {
  auditExecutionRequest(request, report.status, {
    latencyMs: report.latencyMs,
    errors: report.reason ? [report.reason] : undefined,
    diagnosticContext: report.diagnosticContext,
    ...patch
  });
}
