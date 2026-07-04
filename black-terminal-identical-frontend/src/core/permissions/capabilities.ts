export type ProductTier = "retail" | "professional" | "enterprise" | "admin";

export type TerminalCapability =
  | "execution.connectBroker"
  | "execution.connectWallet"
  | "execution.managePositions"
  | "portfolio.retailAnalytics"
  | "portfolio.investmentGroupDiscovery"
  | "portfolio.enterpriseCapital"
  | "portfolio.followers"
  | "portfolio.executionMatrix"
  | "portfolio.audit"
  | "portfolio.permissions"
  | "admin.override";

export type CapabilityUser = {
  username: string;
  role: "admin" | "user";
  productTier?: ProductTier;
  permissions?: TerminalCapability[];
};

const tierCapabilities: Record<ProductTier, TerminalCapability[]> = {
  retail: [
    "execution.connectBroker",
    "execution.connectWallet",
    "execution.managePositions",
    "portfolio.retailAnalytics",
    "portfolio.investmentGroupDiscovery"
  ],
  professional: [
    "execution.connectBroker",
    "execution.connectWallet",
    "execution.managePositions",
    "portfolio.retailAnalytics",
    "portfolio.investmentGroupDiscovery"
  ],
  enterprise: [
    "execution.connectBroker",
    "execution.connectWallet",
    "execution.managePositions",
    "portfolio.retailAnalytics",
    "portfolio.investmentGroupDiscovery",
    "portfolio.enterpriseCapital",
    "portfolio.followers",
    "portfolio.executionMatrix",
    "portfolio.audit",
    "portfolio.permissions"
  ],
  admin: [
    "execution.connectBroker",
    "execution.connectWallet",
    "execution.managePositions",
    "portfolio.retailAnalytics",
    "portfolio.investmentGroupDiscovery",
    "portfolio.enterpriseCapital",
    "portfolio.followers",
    "portfolio.executionMatrix",
    "portfolio.audit",
    "portfolio.permissions",
    "admin.override"
  ]
};

export function resolveProductTier(user: CapabilityUser | null | undefined): ProductTier {
  if (!user) return "retail";
  if (user.role === "admin" || user.username.toLowerCase() === "black_terminal_admin") return "admin";
  return user.productTier ?? "retail";
}

export function getCapabilities(user: CapabilityUser | null | undefined): Set<TerminalCapability> {
  const tier = resolveProductTier(user);
  return new Set([...tierCapabilities[tier], ...(user?.permissions ?? [])]);
}

export function hasCapability(user: CapabilityUser | null | undefined, capability: TerminalCapability) {
  return getCapabilities(user).has(capability);
}
