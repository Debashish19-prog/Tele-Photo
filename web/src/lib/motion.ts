import type { Transition } from 'motion/react';

/** Critically damped, so controls settle fast with no wobble. The default for everything. */
export const SPRING: Transition = { type: 'spring', stiffness: 420, damping: 40, mass: 0.9 };

/** A little softer, for a photo travelling across the screen. */
export const FLIGHT: Transition = { type: 'spring', stiffness: 340, damping: 37 };

export const QUICK: Transition = { duration: 0.16, ease: [0.2, 0.8, 0.3, 1] };

/**
 * Closing is a fixed length rather than a spring, because the viewer has to know when it is safe to
 * disappear, and because leaving should feel prompt.
 */
export const CLOSE_MS = 260;
export const CLOSE: Transition = { duration: CLOSE_MS / 1000, ease: [0.32, 0.72, 0, 1] };

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Size {
  left: number;
  top: number;
}

/** Where a photo of this shape sits when it fills the stage without being cropped. */
export function fitBox(aspect: number, stage: Size): Box {
  const width = Math.min(stage.width, stage.height * aspect);
  const height = width / aspect;
  return { left: (stage.width - width) / 2, top: (stage.height - height) / 2, width, height };
}

export type Pose = {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  clipPath: string;
};

/** The clip keeps the same shape as the one in poseFromTile, because Motion animates between its numbers. */
export const REST: Pose = { x: 0, y: 0, scale: 1, opacity: 1, clipPath: 'inset(0px 0px 0px 0px round 0px)' };

/**
 * The pose that makes the viewer's photo line up exactly with its tile in the grid.
 *
 * A tile crops its photo to fill the tile, so the scale is the larger of the two ratios and the
 * clip trims what the tile hides and rounds the corners to match. Going from this pose to REST is
 * what makes a photo appear to grow out of the grid. Returns null when the tile is not on screen to
 * fly to or from.
 */
export function poseFromTile(photoId: number, box: Box, stage: HTMLElement): Pose | null {
  const tile = document.querySelector(`.tile[data-photo-id="${photoId}"]`);
  if (!tile) return null;
  const t = tile.getBoundingClientRect();
  if (t.width === 0 || t.bottom <= 0 || t.top >= window.innerHeight) return null;

  const s = stage.getBoundingClientRect();
  const scale = Math.max(t.width / box.width, t.height / box.height);
  const insetX = Math.max(0, (box.width - t.width / scale) / 2);
  const insetY = Math.max(0, (box.height - t.height / scale) / 2);
  // The clip is applied before the scale, so it needs a bigger radius to come out the tile's size.
  const radius = Number.parseFloat(getComputedStyle(tile).borderTopLeftRadius) / scale;
  return {
    x: t.left + t.width / 2 - (s.left + box.left + box.width / 2),
    y: t.top + t.height / 2 - (s.top + box.top + box.height / 2),
    scale,
    opacity: 1,
    clipPath: `inset(${insetY}px ${insetX}px ${insetY}px ${insetX}px round ${radius}px)`,
  };
}
