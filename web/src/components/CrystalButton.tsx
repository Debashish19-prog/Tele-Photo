import { type HTMLMotionProps, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createMetal, type DrawMetal } from '@/lib/metal';
import { SPRING } from '@/lib/motion';
import { cn } from '@/lib/utils';

const INVERT = { duration: 0.32, ease: [0.2, 0.8, 0.3, 1], scale: SPRING } as const;

/**
 * A pill inside a ring of liquid metal, inside a glass shell.
 *
 * The ring's spin is a CSS animation, which the compositor runs without touching the GPU's shader
 * or the main thread. The shader draws one still frame and only runs live while the pointer is on
 * the button, because these sit on screen for as long as the app is open.
 */
function useCrystal() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const draw = useRef<DrawMetal | null>(null);
  const clock = useRef(0);
  const [hovered, setHovered] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!canvas.current) return;
    draw.current = createMetal(canvas.current);
    draw.current?.(clock.current);
  }, []);

  useEffect(() => {
    if (!hovered || reducedMotion) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      clock.current += (now - last) / 1000;
      last = now;
      draw.current?.(clock.current);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [hovered, reducedMotion]);

  return {
    canvas,
    gestures: {
      initial: false,
      animate: { '--crystal-hover': 0 },
      whileHover: { '--crystal-hover': 1 },
      whileTap: { '--crystal-hover': 1, scale: 0.96 },
      transition: INVERT,
      onHoverStart: () => setHovered(true),
      onHoverEnd: () => setHovered(false),
    },
  };
}

function CrystalFace({ canvas, children }: { canvas: RefObject<HTMLCanvasElement | null>; children: ReactNode }) {
  return (
    <>
      <span className="crystal__shell" />
      <span className="crystal__ring">
        <span className="crystal__orbit">
          <canvas ref={canvas} aria-hidden="true" />
        </span>
      </span>
      <span className="crystal__pill" />
      <span className="crystal__label">{children}</span>
    </>
  );
}

export function CrystalButton({ className, children, ...props }: Omit<HTMLMotionProps<'button'>, 'children'> & { children?: ReactNode }) {
  const { canvas, gestures } = useCrystal();
  return (
    <motion.button type="button" {...props} {...gestures} className={cn('crystal', className)}>
      <CrystalFace canvas={canvas}>{children}</CrystalFace>
    </motion.button>
  );
}

export function CrystalLink({ className, children, ...props }: Omit<HTMLMotionProps<'a'>, 'children'> & { children?: ReactNode }) {
  const { canvas, gestures } = useCrystal();
  return (
    <motion.a {...props} {...gestures} className={cn('crystal', className)}>
      <CrystalFace canvas={canvas}>{children}</CrystalFace>
    </motion.a>
  );
}
