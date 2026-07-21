export type NotificationSeverity = "info" | "success" | "warning" | "error";

export type BlackTerminalNotification = {
  id: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  createdAt: number;
};

export class NotificationCenter {
  private notifications: BlackTerminalNotification[] = [];

  push(notification: Omit<BlackTerminalNotification, "id" | "createdAt">) {
    const item = {
      ...notification,
      id: crypto.randomUUID?.() ?? `notification-${Date.now()}`,
      createdAt: Date.now()
    };
    this.notifications = [item, ...this.notifications].slice(0, 250);
    return item;
  }

  list() {
    return this.notifications;
  }

  clear() {
    this.notifications = [];
  }
}

export const blackCoreNotificationCenter = new NotificationCenter();
