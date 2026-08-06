/**
 * Colour derivation for application names.
 *
 * One source, because an application has to look the same everywhere it is
 * drawn: the flow map, the timeline lanes and the chips in the event list
 * are three views of the same thing, and a reader who learns that
 * payments-api is teal in one of them should not have to relearn it in the
 * next. This lived twice with two different lightness values before, which
 * is exactly the drift this file exists to prevent.
 *
 * The hue is derived from the name rather than assigned from a palette, so
 * it is stable across sessions and needs no registry of known applications —
 * the app has no idea which names it will meet.
 */

/** Stable hue in [0, 360) for an application name. */
export function applicationHue(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

/** Solid colour for lines, nodes and labels. */
export function applicationColor(name: string): string {
  return `hsl(${applicationHue(name)} 55% 46%)`;
}

/** Tinted background and darker text, for chips set on the page background. */
export function applicationChipStyle(name: string): {
  readonly color: string;
  readonly background: string;
} {
  const hue = applicationHue(name);
  return {
    color: `hsl(${hue} 60% 38%)`,
    background: `hsl(${hue} 55% 46% / 0.14)`,
  };
}
