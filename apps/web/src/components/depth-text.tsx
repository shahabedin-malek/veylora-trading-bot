"use client";

import { useRef } from "react";

export function DepthText({
  text,
  faceColor = "#e5eeeb",
  depthColor = "#a8e4bd",
}: {
  text: string;
  faceColor?: string;
  depthColor?: string;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const stageRef = useRef<HTMLSpanElement>(null);
  const layers = Array.from({ length: 5 }, (_, index) => {
    const layer = 5 - index;
    const faceMix = Math.round(46 - (layer / 5) * 30);
    return {
      layer,
      color: `color-mix(in srgb, ${faceColor} ${faceMix}%, ${depthColor})`,
      transform: `translateZ(${-layer * 0.7}px)`,
    };
  });

  function handlePointerMove(event: React.PointerEvent<HTMLSpanElement>) {
    if (!stageRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const bounds = rootRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return;
    const x = (event.clientX - bounds.left - bounds.width / 2) / bounds.width;
    const y = (event.clientY - bounds.top - bounds.height / 2) / bounds.height;
    const rotateX = Math.max(-1.25, Math.min(1.25, -y * 2.5));
    const rotateY = Math.max(-1.25, Math.min(1.25, x * 2.5));
    stageRef.current.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  }

  function resetPointer() {
    if (stageRef.current) stageRef.current.style.transform = "rotateX(0deg) rotateY(0deg)";
  }

  return (
    <span className="depth-text" ref={rootRef} onPointerMove={handlePointerMove} onPointerLeave={resetPointer}>
      <span className="depth-text__stage" ref={stageRef}>
        {layers.map(({ layer, color, transform }) => (
          <span aria-hidden="true" className="depth-text__layer" key={layer} style={{ color, transform }}>
            {text}
          </span>
        ))}
        <span className="depth-text__face">{text}</span>
      </span>
    </span>
  );
}