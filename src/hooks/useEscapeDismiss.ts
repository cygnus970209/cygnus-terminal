import { useEffect, useRef } from "react";

type Layer = { dismiss: () => void; priority: number };
const layers: Layer[] = [];

// One capture listener prevents an Escape from reaching a terminal or dismissing
// several dialogs. Priorities follow the overlays' CSS stacking order.
export function dismissTopLayer(event: KeyboardEvent, stack = layers) {
  if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
  const top = stack.reduce<Layer | undefined>((current, layer) =>
    !current || layer.priority >= current.priority ? layer : current, undefined);
  if (!top) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (!event.repeat) top.dismiss();
}

export function useEscapeDismiss(onDismiss: () => void, enabled = true, priority = 100) {
  const callback = useRef(onDismiss);
  callback.current = onDismiss;
  useEffect(() => {
    if (!enabled) return;
    const layer = { dismiss: () => callback.current(), priority };
    if (!layers.length) window.addEventListener("keydown", dismissTopLayer, true);
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) window.removeEventListener("keydown", dismissTopLayer, true);
    };
  }, [enabled, priority]);
}
