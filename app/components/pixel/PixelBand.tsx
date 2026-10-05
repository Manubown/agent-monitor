"use client";

import { useEffect, useRef } from "react";
import { createPixelField, type PixelField } from "./field";
import "../../pixel.css";

interface Props {
  /** Skyline data: event counts per time bin, oldest first. */
  counts: number[];
  /** What the skyline shows, e.g. "skyline = agent events per hour, last 7 days". */
  legend: string;
  /** Page title and headline figure; mark text blocks with `data-quiet` so the field dims under them. */
  children: React.ReactNode;
  className?: string;
}

/**
 * Full-width animated pixel band under the top bar. The canvas is created once per mount: live refreshes and
 * same-page navigations only hand it new skyline data, so the animation never restarts.
 */
export function PixelBand({ counts, legend, children, className }: Props) {
  const bandRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const field = useRef<PixelField | null>(null);

  useEffect(() => {
    if (!bandRef.current || !canvasRef.current) return;
    const f = createPixelField(bandRef.current, canvasRef.current);
    field.current = f;
    return () => {
      f.destroy();
      field.current = null;
    };
  }, []);

  useEffect(() => {
    field.current?.setData(counts);
  }, [counts]);

  // Text inside the band may have changed width (a new cost, a renamed session): move the quiet zones with it.
  useEffect(() => {
    field.current?.measure();
  });

  return (
    <div ref={bandRef} className={className ? `band ${className}` : "band"}>
      <canvas ref={canvasRef} className="band-canvas" aria-hidden="true" />
      <div className="band-inner">{children}</div>
      <span className="band-key">{legend}</span>
    </div>
  );
}
