export type DomVisualQuality = "full" | "balanced" | "degraded";

export class DomAdaptiveQualityController {
  private quality: DomVisualQuality = "full";
  private pressure = 0;
  private healthySamples = 0;

  update(workMs: number, queueDepth: number, interacting: boolean) {
    const overloaded = workMs > (interacting ? 22 : 35) || queueDepth > 1;
    this.pressure = overloaded ? Math.min(12, this.pressure + 2) : Math.max(0, this.pressure - 1);
    this.healthySamples = overloaded ? 0 : this.healthySamples + 1;
    if (this.pressure >= 8) this.quality = "degraded";
    else if (this.pressure >= 3 || interacting) this.quality = "balanced";
    else if (this.healthySamples >= 8) this.quality = "full";
    return this.quality;
  }

  current() { return this.quality; }
}
