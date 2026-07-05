export const activeExecutionVenueStorageKey = "bt_active_execution_venue_v1";
const activeExecutionVenueEvent = "black-terminal-active-execution-venue";

export function readActiveExecutionVenueId() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(activeExecutionVenueStorageKey);
}

export function setActiveExecutionVenueId(venueId: string | null) {
  if (typeof window === "undefined") return;
  if (venueId) {
    localStorage.setItem(activeExecutionVenueStorageKey, venueId);
  } else {
    localStorage.removeItem(activeExecutionVenueStorageKey);
  }
  window.dispatchEvent(new CustomEvent(activeExecutionVenueEvent, { detail: { venueId } }));
}

export function subscribeActiveExecutionVenue(listener: (venueId: string | null) => void) {
  if (typeof window === "undefined") return () => undefined;
  const handleCustom = (event: Event) => {
    listener((event as CustomEvent<{ venueId: string | null }>).detail?.venueId ?? readActiveExecutionVenueId());
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === activeExecutionVenueStorageKey) listener(event.newValue);
  };
  window.addEventListener(activeExecutionVenueEvent, handleCustom);
  window.addEventListener("storage", handleStorage);
  listener(readActiveExecutionVenueId());
  return () => {
    window.removeEventListener(activeExecutionVenueEvent, handleCustom);
    window.removeEventListener("storage", handleStorage);
  };
}
