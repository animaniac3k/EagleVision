/**
 * Image Filter Pipeline (Brightness, Contrast, Saturation, Invert, Grayscale)
 * Returns 'none' when all adjustments are at default values to avoid any filter overhead.
 */
export function buildCanvasFilterString(state) {
  const isDefault =
    state.brightness === 100 &&
    state.contrast === 100 &&
    state.saturation === 100 &&
    !state.invert &&
    !state.grayscale;

  if (isDefault) {
    return 'none';
  }

  const parts = [
    `brightness(${state.brightness}%)`,
    `contrast(${state.contrast}%)`,
    `saturate(${state.saturation}%)`
  ];
  if (state.invert) parts.push('invert(100%)');
  if (state.grayscale) parts.push('grayscale(100%)');
  return parts.join(' ');
}
