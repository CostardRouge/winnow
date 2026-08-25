"use client";

import { useRef, type MouseEvent, type PointerEvent } from "react";

// Backdrop props that dismiss a modal only when the *press* started on the
// backdrop itself. A plain onClick on the overlay also fires when a drag that
// began inside the dialog ends outside of it — selecting text in a form field,
// or panning the map of the geotag picker, and releasing past the modal's edge
// — because the browser dispatches the click on the nearest common ancestor of
// press and release, i.e. the overlay. That closed the modal mid-edit.
export function useOverlayDismiss<T extends Element>(onDismiss: () => void) {
  const pressedBackdrop = useRef(false);

  return {
    onPointerDown: (e: PointerEvent<T>) => {
      pressedBackdrop.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent<T>) => {
      const fromBackdrop = pressedBackdrop.current;
      pressedBackdrop.current = false;
      // Both ends of the gesture have to be the backdrop: the press (tracked
      // above) and the release (the click's own target).
      if (fromBackdrop && e.target === e.currentTarget) onDismiss();
    },
  };
}
