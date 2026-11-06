// Long-content clamp shared by the tool-call viewer and the trace sidebar.
// Contents over `threshold` characters start clamped behind a Show more /
// Show less toggle; the collapsed height is configurable because the trace
// sidebar uses a shorter viewport than tool-call arguments.

import { useState } from 'react';

export function Clamp({
  len,
  children,
  maxHeight = '16em',
  threshold = 600,
}: {
  len: number;
  children: React.ReactNode;
  maxHeight?: string;
  threshold?: number;
}) {
  const [clamped, setClamped] = useState(len > threshold);
  return (
    <>
      <div
        className={
          clamped ? 'overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : undefined
        }
        style={clamped ? { maxHeight } : undefined}
      >
        {children}
      </div>
      {len > threshold && (
        <button
          type="button"
          className="mt-1 text-xs text-[#58a6ff] hover:underline"
          onClick={() => setClamped((v) => !v)}
        >
          {clamped ? 'Show more' : 'Show less'}
        </button>
      )}
    </>
  );
}
