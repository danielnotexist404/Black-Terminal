export type DomWallLabelLayout = {
  visible: boolean;
  compact: boolean;
  x: number;
  y: number;
  clipX: number;
  clipY: number;
  clipWidth: number;
  clipHeight: number;
};

export function computeDomWallLabelLayout(input: { top: number; height: number; width: number; measuredWidth: number }): DomWallLabelLayout {
  const clipY = Math.max(0, input.top);
  const clipHeight = Math.max(0, input.height);
  const padding = 8;
  const availableWidth = Math.max(0, input.width - padding * 2);
  const compact = clipHeight < 12 || input.measuredWidth > availableWidth;
  return {
    visible: clipHeight >= 5 && availableWidth >= 14,
    compact,
    x: padding,
    y: clipY + clipHeight / 2,
    clipX: 0,
    clipY,
    clipWidth: Math.max(0, input.width),
    clipHeight
  };
}
