/// <reference lib="webworker" />
import { DDAProWorkerRuntime } from "./runtime.ts";
import type { DDAProWorkerRequest } from "./protocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = new DDAProWorkerRuntime((message) => workerScope.postMessage(message));
workerScope.onmessage = (event: MessageEvent<DDAProWorkerRequest>) => runtime.handle(event.data);
