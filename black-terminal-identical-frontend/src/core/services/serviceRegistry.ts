export type ServiceFactory<T> = () => T;

export class ServiceRegistry {
  private instances = new Map<string, unknown>();
  private factories = new Map<string, ServiceFactory<unknown>>();

  register<T>(key: string, service: T) {
    const existing = this.instances.get(key);
    if (existing !== undefined && existing !== service) {
      throw new Error(`Black Core service already registered: ${key}`);
    }
    this.instances.set(key, service);
  }

  registerFactory<T>(key: string, factory: ServiceFactory<T>) {
    if (this.factories.has(key) || this.instances.has(key)) {
      throw new Error(`Black Core service already registered: ${key}`);
    }
    this.factories.set(key, factory as ServiceFactory<unknown>);
  }

  get<T>(key: string): T {
    if (this.instances.has(key)) return this.instances.get(key) as T;

    const factory = this.factories.get(key);
    if (!factory) throw new Error(`Black Core service not registered: ${key}`);
    const service = factory();
    this.instances.set(key, service);
    return service as T;
  }

  has(key: string) {
    return this.instances.has(key) || this.factories.has(key);
  }

  clear() {
    this.instances.clear();
    this.factories.clear();
  }
}

export const blackCoreServices = new ServiceRegistry();
