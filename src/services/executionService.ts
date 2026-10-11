import { invoke } from "./secureInvoke";
import type {
  ExecutionJob,
  ExecutionSummary,
  StartExecutionRequest,
} from "../types/execution";

export function startExecution(req: StartExecutionRequest): Promise<string> {
  return invoke("execution_start", { req });
}

export function getExecution(jobId: string): Promise<ExecutionJob> {
  return invoke("execution_get", { jobId });
}

export function listExecutions(limit = 50, offset = 0): Promise<ExecutionSummary[]> {
  return invoke("execution_list", { limit, offset });
}

export function cancelExecution(jobId: string): Promise<void> {
  return invoke("execution_cancel", { jobId });
}
