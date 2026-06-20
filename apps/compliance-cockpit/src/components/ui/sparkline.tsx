/**
 * Inline-SVG sparkline — used under stat-card numbers.
 * Tiny, no Recharts overhead, no axes / labels / tooltips.
 * Renders a smooth area under a stroke; 0-data renders a flat hairline.
 */

interface Props {
  data: number[]
  width?: number
  height?: number
  color?: string
  fillOpacity?: number
  className?: string
}

export function Sparkline({
  data,
  width = 96,
  height = 22,
  color = 'hsl(22 22% 24%)',
  fillOpacity = 0.12,
  className,
}: Props) {
  // Guard rails: empty / degenerate input → flat baseline.
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden="true">
        <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke={color} strokeWidth="1" opacity="0.25" />
      </svg>
    )
  }

  const n = data.length
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const step = width / (n - 1)
  const pad = 2  // top + bottom padding so the stroke doesn't clip

  const y = (v: number) => height - pad - ((v - min) / range) * (height - 2 * pad)

  let line = ''
  let area = ''
  data.forEach((v, i) => {
    const x = i * step
    line += (i === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y(v).toFixed(1)}`
  })
  area = line + ` L${(width).toFixed(1)},${height} L0,${height} Z`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={area} fill={color} fillOpacity={fillOpacity} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
