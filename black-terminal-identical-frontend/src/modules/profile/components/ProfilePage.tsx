import type { CapabilityUser } from "../../../core/permissions/capabilities";
import { ProfessionalCenterPage } from "../../professional-network/ProfessionalCenterPage";

type ProfilePageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenInvestmentGroups: () => void;
};

export function ProfilePage({ currentUser, onClose, onOpenInvestmentGroups }: ProfilePageProps) {
  return <ProfessionalCenterPage currentUser={currentUser} onClose={onClose} onOpenInvestmentGroups={onOpenInvestmentGroups} />;
}
