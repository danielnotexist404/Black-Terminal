import type { CapabilityUser } from "../../../core/permissions/capabilities";
import type { DBUser } from "../../../lib/supabase";
import { ProfessionalCenterPage } from "../../professional-network/ProfessionalCenterPage";

type ProfilePageProps = {
  currentUser: CapabilityUser;
  onClose: () => void;
  onOpenInvestmentGroups: () => void;
  onProfileUpdated?: (profile: DBUser) => void;
};

export function ProfilePage({ currentUser, onClose, onOpenInvestmentGroups, onProfileUpdated }: ProfilePageProps) {
  return <ProfessionalCenterPage currentUser={currentUser} initialSection="profile" preferInitialSection onClose={onClose} onOpenInvestmentGroups={onOpenInvestmentGroups} onAccountProfileUpdated={onProfileUpdated} />;
}
