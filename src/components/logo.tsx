import { useId } from "react";

// The Blomp mark: the score ring, left open, with a dot popping out of the gap. Geometry is in a 96 x 96 box.
const C = 48;
const R = 22;

function pt(deg: number, r = R): [number, number] {
  const a = (deg * Math.PI) / 180; // 0deg = top, clockwise
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
}
const [x0, y0] = pt(72);
const [x1, y1] = pt(346);
const [dx, dy] = pt(29);
const ARC = `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 1 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;

export function Logo({ size = 88, className }: { size?: number; className?: string }) {
  const id = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-label="Blomp"
      className={className}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "var(--logo-a)" }} />
          <stop offset="1" style={{ stopColor: "var(--logo-b)" }} />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="26" fill={`url(#${id})`} />
      <path d={ARC} stroke="var(--logo-ink)" strokeWidth="9" strokeLinecap="round" />
      <circle cx={dx.toFixed(2)} cy={dy.toFixed(2)} r="5.6" fill="var(--logo-ink)" />
    </svg>
  );
}
