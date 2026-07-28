/// <reference lib="webworker" />
import { installKioseffWorker } from "./KioseffWorker.ts";

installKioseffWorker(self);
