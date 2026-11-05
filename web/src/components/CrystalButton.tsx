import { type HTMLMotionProps, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createMetal, type Metal } from '@/lib/metal';
import { SPRING } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** Twice the ring's 180px square, which keeps the metal sharp on a high-density screen. */
const CANVAS_SIZE = 360;

const INVERT = { duration: 0.32, ease: [0.2, 0.8, 0.3, 1], scale: SPRING } as const;

/**
 * A pill inside a ring of liquid metal, inside a glass shell.
 *
 * The ring's spin is a CSS animation, which the compositor runs without touching the GPU's shader
 * or the main thread. The shader draws one still frame and only runs live while the pointer is on
 * the button, because this sits on screen for as long as the app is open.
 */
export function CrystalButton({ className, children, ...props }: Omit<HTMLMotionProps<'button'>, 'children'> & { children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const metal = useRef<Metal | null>(null);
  const clock = useRef(0);
  const [hovered, setHovered] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!canvas.current) return;
    const created = createMetal(canvas.current);
    metal.current = created;
    created?.draw(clock.current);
    return () => {
      created?.destroy();
      metal.current = null;
    };
  }, []);

  useEffect(() => {
    if (!hovered || reducedMotion) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      clock.current += (now - last) / 1000;
      last = now;
      metal.current?.draw(clock.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [hovered, reducedMotion]);

  return (
    <motion.button
      type="button"
      {...props}
      className={cn('crystal', className)}
      initial={false}
      animate={{ '--crystal-hover': 0 }}
      whileHover={{ '--crystal-hover': 1 }}
      whileTap={{ '--crystal-hover': 1, scale: 0.96 }}
      transition={INVERT}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
    >
      <span className="crystal__shell" />
      <span className="crystal__ring">
        <span className="crystal__orbit">
          <canvas ref={canvas} width={CANVAS_SIZE} height={CANVAS_SIZE} aria-hidden="true" />
        </span>
      </span>
      <span className="crystal__pill" />
      <span className="crystal__label">{children}</span>
    </motion.button>
  );
}
