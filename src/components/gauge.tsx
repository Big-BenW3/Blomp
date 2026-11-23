import { scoreZone } from "@/lib/kane/score";

const CX = 130;
const CY = 120;
const R = 100;
const START = 135; // degrees clockwise from the right; the ring sweeps 270 degrees with its gap at the bottom

function arc(from: number, to: number): string {
  const p = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(CX + R * Math.cos(a)).toFixed(2)} ${(CY + R * Math.sin(a)).toFixed(2)}`;
  };
  return `M${p(from)}A${R} ${R} 0 ${to - from > 180 ? 1 : 0} 1 ${p(to)}`;
}

/** The score ring. `score` null means Kane could not decide any flow, so it draws an empty ring and a dash. */
export function Gauge({ score, label = "KANE SCORE" }: { score: number | null; label?: string }) {
  const color = score === null ? "var(--muted)" : `var(--${scoreZone(score)})`;
  return (
    <div className="flex justify-center">
      <svg
        viewBox="0 0 260 200"
        width={190}
        height={146}
        role="img"
        aria-label={score === null ? "No score" : `Kane score ${score} out of 100`}
      >
        <path d={arc(START, START + 269.9)} stroke="var(--fill)" strokeWidth={14} fill="none" strokeLinecap="round" />
        {score !== null && score > 0 ? (
          <path d={arc(START, START + Math.max(0.5, 2.7 * score - 0.1))} stroke={color} strokeWidth={14} fill="none" strokeLinecap="round" />
        ) : null}
        <text
          x={130}
          y={132}
          textAnchor="middle"
          fill="var(--text)"
          style={{ fontSize: 76, fontWeight: 700, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}
        >
          {score ?? "–"}
        </text>
        <text x={130} y={162} textAnchor="middle" fill="var(--muted)" style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.1em" }}>
          {label}
        </text>
      </svg>
    </div>
  );
}
