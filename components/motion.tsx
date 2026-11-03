"use client";

import { LazyMotion, domAnimation, m } from "motion/react";
import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

function subscribeToMotionPolicy(notify: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "data-reduce-motion",
      "data-motion-ready",
      "data-input-method",
    ],
  });
  media.addEventListener("change", notify);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", notify);
  };
}

function motionAllowed() {
  const root = document.documentElement;
  return (
    root.dataset.motionReady === "true" &&
    root.dataset.reduceMotion !== "true" &&
    root.dataset.inputMethod !== "keyboard" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Motion stays off until saved preferences are known; keyboard paths stay instant. */
export function useMotionAllowed() {
  return useSyncExternalStore(
    subscribeToMotionPolicy,
    motionAllowed,
    () => false,
  );
}

export function WorkspaceMotion({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      {children}
    </LazyMotion>
  );
}

/** Only this decorative marker moves. Navigation and page content never remount. */
export function NavigationIndicator({ selected }: { selected: string }) {
  const marker = useRef<HTMLSpanElement>(null);
  const allowed = useMotionAllowed();
  const [position, setPosition] = useState<{
    top: number;
    height: number;
    animate: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const parent = marker.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const active = parent.querySelector<HTMLElement>('[aria-current="page"]');
      if (!active) {
        setPosition(null);
        return;
      }
      const bounds = active.getBoundingClientRect();
      const top = bounds.top - parent.getBoundingClientRect().top;
      setPosition((current) =>
        current?.top === top && current.height === bounds.height
          ? current
          : { top, height: bounds.height, animate: current !== null },
      );
    };
    const frame = requestAnimationFrame(measure);
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [selected]);

  return (
    <m.span
      ref={marker}
      className="nav-selection"
      aria-hidden="true"
      data-ready={allowed && position !== null}
      initial={false}
      animate={{ transform: `translateY(${position?.top ?? 0}px)` }}
      transition={{
        duration: allowed && position?.animate ? 0.18 : 0,
        ease: [0.22, 1, 0.36, 1],
      }}
      style={{ height: position?.height ?? 44 }}
    />
  );
}
