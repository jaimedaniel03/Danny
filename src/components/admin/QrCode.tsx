import { encode } from 'uqr';

/**
 * A QR code as plain SVG (one path, no inline styles, no script), so it
 * renders under the strict CSP and scales crisply.
 */
export function QrCode({ value, label, size = 208 }: { readonly value: string; readonly label: string; readonly size?: number }) {
  const { data, size: modules } = encode(value, { ecc: 'M', border: 2 });
  let d = '';
  data.forEach((row, y) => {
    row.forEach((on, x) => {
      if (on) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      className="qr"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={d} fill="#17323a" />
    </svg>
  );
}
