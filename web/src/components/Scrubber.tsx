import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import type { Layout } from '@/lib/layout';

const MIN_LABEL_SPACING = 24;

interface ScrubberProps {
  layout: Layout;
  container: RefObject<HTMLDivElement | null>;
}

/** The timeline strip on the right: years at a glance, and a fast way to jump through them. */
export function Scrubber(props: ScrubberProps) {
  // Not worth showing for a library that fits in a few screens.
  if (props.layout.markers.length < 2 || props.layout.height < 2400) return null;
  return <ScrubberTrack {...props} />;
}

function ScrubberTrack({ layout, container }: ScrubberProps) {
  const track = useRef<HTMLDivElement>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [position, setPosition] = useState(0);
  const [hover, setHover] = useState<{ y: number; label: string } | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setTrackHeight(el.clientHeight));
    observer.observe(el);
    setTrackHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const scrollable = () => Math.max(1, layout.height - window.innerHeight + (container.current?.getBoundingClientRect().top ?? 0) + window.scrollY);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setPosition(Math.min(1, window.scrollY / scrollable()));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
    };
  });

  const labels = useMemo(() => {
    if (trackHeight === 0 || layout.height === 0) return [];
    const placed: { y: number; text: string }[] = [];
    let lastYear = '';
    for (const marker of layout.markers) {
      if (marker.year === lastYear) continue;
      lastYear = marker.year;
      const y = (marker.y / layout.height) * trackHeight;
      const previous = placed.at(-1);
      if (!previous || y - previous.y >= MIN_LABEL_SPACING) placed.push({ y, text: marker.year });
    }
    return placed;
  }, [layout, trackHeight]);

  const monthAt = (fraction: number) => {
    const target = fraction * layout.height;
    let label = layout.markers[0]?.label ?? '';
    for (const marker of layout.markers) {
      if (marker.y > target) break;
      label = marker.label;
    }
    return label;
  };

  const fractionFrom = (clientY: number) => {
    const rect = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  };

  return (
    <div
      className="fixed top-[var(--top-h)] right-1 bottom-3 z-20 hidden w-14 touch-none select-none min-[720px]:block"
      ref={track}
      role="slider"
      aria-label="Jump through your timeline"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position * 100)}
      aria-valuetext={monthAt(position)}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowDown' || event.key === 'PageDown' ? 1 : event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        window.scrollBy({ top: step * window.innerHeight * (event.key.startsWith('Page') ? 3 : 1) });
      }}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        window.scrollTo({ top: fractionFrom(event.clientY) * scrollable() });
      }}
      onPointerMove={(event) => {
        const fraction = fractionFrom(event.clientY);
        setHover({ y: fraction * trackHeight, label: monthAt(fraction) });
        if (dragging.current) window.scrollTo({ top: fraction * scrollable() });
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerLeave={() => {
        if (!dragging.current) setHover(null);
      }}
    >
      {labels.map((label) => (
        <span
          key={label.text}
          className="absolute right-1.5 text-[11px] font-semibold text-[var(--lq-text-dim)] [text-shadow:0_0_6px_var(--app-bg),0_0_2px_var(--app-bg)]"
          style={{ top: label.y }}
        >
          {label.text}
        </span>
      ))}
      <div className="absolute right-0 h-[3px] w-9 rounded-full bg-[var(--lq-accent)] shadow-sm" style={{ top: position * trackHeight }} />
      {hover ? (
        <div
          className="pointer-events-none absolute right-11 -translate-y-1/2 rounded-full bg-[var(--lq-accent)] px-3 py-1 text-xs font-semibold whitespace-nowrap text-white shadow-lg"
          style={{ top: hover.y }}
        >
          {hover.label}
        </div>
      ) : null}
    </div>
  );
}
