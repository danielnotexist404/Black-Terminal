import type { SyntheticEvent } from "react";

type InteractionShieldProps = {
  variant: "workspace" | "dialog";
  testId?: string;
};

function isolateEvent(event: SyntheticEvent<HTMLDivElement>) {
  event.stopPropagation();
}

function suppressBrowserAction(event: SyntheticEvent<HTMLDivElement>) {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * A real hit-test boundary between a foreground surface and the live chart.
 * It deliberately owns pointer, touch, wheel and context-menu input so chart
 * canvases and draggable broker lines can never receive an event through it.
 */
export function InteractionShield({ variant, testId }: InteractionShieldProps) {
  return (
    <div
      aria-hidden="true"
      className={`interaction-shield interaction-shield--${variant}`}
      data-testid={testId}
      onClick={isolateEvent}
      onDoubleClick={isolateEvent}
      onMouseDown={isolateEvent}
      onMouseMove={isolateEvent}
      onMouseUp={isolateEvent}
      onPointerCancel={isolateEvent}
      onPointerDown={isolateEvent}
      onPointerMove={isolateEvent}
      onPointerUp={isolateEvent}
      onContextMenu={suppressBrowserAction}
      onTouchMove={suppressBrowserAction}
      onTouchStart={suppressBrowserAction}
      onWheel={suppressBrowserAction}
    />
  );
}
