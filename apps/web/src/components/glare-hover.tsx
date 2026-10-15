import type { CSSProperties, ReactNode } from "react";

export function GlareHover({
  children,
  className = "",
  opacity = 0.1,
}: {
  children: ReactNode;
  className?: string;
  opacity?: number;
}) {
  const style = { "--reactbits-glare-opacity": Math.min(Math.max(opacity, 0), 0.2) } as CSSProperties;
  return (
    <div className={`reactbits-glare ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}