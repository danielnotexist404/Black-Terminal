import type { CapabilityUser } from "../../../core/permissions/capabilities";
import { ProfessionalCenterPage } from "../../professional-network/ProfessionalCenterPage";

export function PublicProfessionalProfilePage({ username, currentUser, onClose, onOpenInvestmentGroups }: {
  username: string;
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenInvestmentGroups: () => void;
}) {
  return <ProfessionalCenterPage currentUser={currentUser} initialHandle={username} initialSection="profile" onClose={onClose} onOpenInvestmentGroups={onOpenInvestmentGroups} />;
}
