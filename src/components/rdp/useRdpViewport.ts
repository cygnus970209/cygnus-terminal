import { useEffect, useState, type RefObject } from "react";

/** Recompute for tab/window resize and monitor/DPI changes without changing remote resolution. */
export default function useRdpViewport(surface: RefObject<HTMLDivElement | null>, enabled: boolean) {
  const [viewport, setViewport] = useState({ width: 1, height: 1, pixelRatio: 1 });
  useEffect(() => {
    const element = surface.current;
    if (!enabled || !element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight, pixelRatio: window.devicePixelRatio || 1 });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    let media: MediaQueryList;
    let observedDpi = window.devicePixelRatio || 1;
    const watchDpi = () => {
      media?.removeEventListener("change", watchDpi);
      observedDpi = window.devicePixelRatio || 1;
      update();
      media = window.matchMedia(`(resolution: ${observedDpi}dppx)`);
      media.addEventListener("change", watchDpi);
    };
    watchDpi();
    // Some WebViews change devicePixelRatio without a resize/media-query event.
    // Only the active connected tab checks; unchanged DPI causes no React update.
    const dpiTimer = window.setInterval(() => { if ((window.devicePixelRatio || 1) !== observedDpi) watchDpi(); }, 500);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); clearInterval(dpiTimer); media.removeEventListener("change", watchDpi); window.removeEventListener("resize", update); };
  }, [surface, enabled]);
  return viewport;
}
