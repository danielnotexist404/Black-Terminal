export type PopoverPlacement = { top: number; left: number };

export function placePanelPopover(
  anchor: { left: number; bottom: number; width: number },
  viewport: { width: number; height: number },
  popover: { width: number; height: number } = { width: 340, height: 430 }
): PopoverPlacement {
  const width = Math.min(popover.width, viewport.width - 20);
  return {
    top: Math.max(10, Math.min(viewport.height - popover.height - 10, anchor.bottom + 6)),
    left: Math.max(10, Math.min(viewport.width - width - 10, anchor.left - width + anchor.width))
  };
}

export function shouldClosePanelPopover(reason: "escape" | "outside" | "inside" | "anchor") {
  return reason === "escape" || reason === "outside";
}
