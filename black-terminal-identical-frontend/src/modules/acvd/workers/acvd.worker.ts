/// <reference lib="webworker" />
import { AcvdWorkerRuntime } from "./runtime.ts";
import type { AcvdWorkerRequest } from "./protocol.ts";

const runtime = new AcvdWorkerRuntime((message) => self.postMessage(message));
self.onmessage = (event: MessageEvent<AcvdWorkerRequest>) => runtime.handle(event.data);
