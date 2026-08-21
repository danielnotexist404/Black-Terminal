/// <reference lib="webworker" />
import { BCTERAWorkerRuntime } from "./runtime.ts";
import type { BCTERAWorkerRequest } from "./protocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = new BCTERAWorkerRuntime((message) => workerScope.postMessage(message));
workerScope.onmessage = (event: MessageEvent<BCTERAWorkerRequest>) => runtime.handle(event.data);
