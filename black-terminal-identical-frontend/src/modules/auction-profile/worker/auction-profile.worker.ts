/// <reference lib="webworker" />
import { AuctionProfileWorkerRuntime } from "./auctionProfileWorker.ts";
import type { AuctionProfileWorkerRequest } from "./protocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const runtime = new AuctionProfileWorkerRuntime({
  postMessage(message) {
    workerScope.postMessage(message);
  }
});

workerScope.onmessage = (event: MessageEvent<AuctionProfileWorkerRequest>) => runtime.handle(event.data);
