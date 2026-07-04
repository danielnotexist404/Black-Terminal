export type ServiceFactory<T> = () => T;

export class ServiceRegistry {
  private instances = new Map<string, unknown>();
  private factories = new Map<string, ServiceFactory<unknown>>();

  register<T>(key: string, service: T) {
    this.instances.set(key, service);
  }

  registerFactory<T>(key: string, factory: ServiceFactory<T>) {
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
