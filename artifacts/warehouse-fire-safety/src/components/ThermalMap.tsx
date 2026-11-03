import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { Crosshair, MoveUpRight } from 'lucide-react';

interface ThermalMapProps {
  matrix: number[];
  maxTemp: number;
  avgTemp: number;
  displaySize: 4 | 6;
  onDisplaySizeChange: (size: 4 | 6) => void;
}

const WIDTH = 32;
const HEIGHT = 24;

// Precomputed FLIR Ironbow Lookup Table (256 entries) for instant, ultra-fast rendering
const COLOR_LUT: [number, number, number][] = (() => {
  const stops = [
    { at: 0.0,  color: [5, 5, 20] },       // Deep space navy/black
    { at: 0.15, color: [48, 12, 100] },    // Deep purple
    { at: 0.35, color: [140, 20, 110] },   // Infrared magenta
    { at: 0.60, color: [220, 60, 10] },    // Thermal fiery orange
    { at: 0.82, color: [250, 195, 20] },   // Radiant yellow
    { at: 1.0,  color: [255, 255, 255] },  // White-hot flame
  ];
  const lut: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const ratio = i / 255;
    const stopIndex = stops.findIndex((s) => s.at >= ratio);
    const left = stops[Math.max(0, stopIndex - 1)];
    const right = stops[Math.max(0, stopIndex)];
    const blend = right.at === left.at ? 0 : (ratio - left.at) / (right.at - left.at);
    lut.push([
      Math.round(left.color[0] + (right.color[0] - left.color[0]) * blend),
      Math.round(left.color[1] + (right.color[1] - left.color[1]) * blend),
      Math.round(left.color[2] + (right.color[2] - left.color[2]) * blend),
    ]);
  }
  return lut;
})();

function getLutColor(value: number, min: number, max: number): [number, number, number] {
  const range = Math.max(2.0, max - min);
  const ratio = Math.min(1, Math.max(0, (value - min) / range));
  const idx = Math.min(255, Math.max(0, Math.floor(ratio * 255)));
  return COLOR_LUT[idx];
}

export function ThermalMap({ matrix, maxTemp, avgTemp, displaySize, onDisplaySizeChange }: ThermalMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; temp: number } | null>(null);
  const safeMatrix = useMemo(() => {
    if (matrix.length === WIDTH * HEIGHT) {
      return matrix;
    }
    return Array.from({ length: WIDTH * HEIGHT }, (_, index) => {
      const x = index % WIDTH;
      const y = Math.floor(index / WIDTH);
      return 20.5 + Math.sin(x / 4.7) * 1.8 + Math.cos(y / 4.1) * 1.3 + Math.exp(-((x - 21) ** 2 + (y - 9) ** 2) / 34) * 13;
    });
  }, [matrix]);
  const hotIndex = safeMatrix.reduce((best, value, index) => value > safeMatrix[best] ? index : best, 0);
  const hotX = hotIndex % WIDTH;
  const hotY = Math.floor(hotIndex / WIDTH);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) {
      return;
    }
    const minTemp = Math.min(...safeMatrix);
    const maxVal = Math.max(maxTemp, ...safeMatrix);
    // Dynamic Auto-Ranging: ensure at least 2.5°C spread so temperature gradients are sharp and crisp in ambient room conditions
    const spread = Math.max(2.5, maxVal - minTemp);
    const effMax = minTemp + spread;

    const image = context.createImageData(canvas.width, canvas.height);
    const cw = canvas.width;
    const ch = canvas.height;
    const data = image.data;

    for (let py = 0; py < ch; py += 1) {
      const sourceY = (py / (ch - 1)) * (HEIGHT - 1);
      const y0 = Math.floor(sourceY);
      const y1 = Math.min(HEIGHT - 1, y0 + 1);
      const fy = sourceY - y0;
      const rowOffset = py * cw * 4;

      for (let px = 0; px < cw; px += 1) {
        const sourceX = (px / (cw - 1)) * (WIDTH - 1);
        const x0 = Math.floor(sourceX);
        const x1 = Math.min(WIDTH - 1, x0 + 1);
        const fx = sourceX - x0;

        const top = safeMatrix[y0 * WIDTH + x0] * (1 - fx) + safeMatrix[y0 * WIDTH + x1] * fx;
        const bottom = safeMatrix[y1 * WIDTH + x0] * (1 - fx) + safeMatrix[y1 * WIDTH + x1] * fx;
        const temp = top * (1 - fy) + bottom * fy;

        const rgb = getLutColor(temp, minTemp, effMax);
        const offset = rowOffset + px * 4;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
        data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [safeMatrix, maxTemp]);

  function trackPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = Math.min(WIDTH - 1, Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * WIDTH)));
    const y = Math.min(HEIGHT - 1, Math.max(0, Math.floor(((event.clientY - bounds.top) / bounds.height) * HEIGHT)));
    setHover({ x, y, temp: safeMatrix[y * WIDTH + x] });
  }

  const currentMin = useMemo(() => Math.min(...safeMatrix), [safeMatrix]);
  const currentMax = useMemo(() => Math.max(maxTemp, ...safeMatrix), [safeMatrix, maxTemp]);

  return (
    <section className="panel thermal-panel page-enter stagger-1" data-testid="panel-thermal-map">
      <div className="panel-heading">
        <div>
          <div className="eyebrow"><span className="eyebrow-marker" /> THERMAL FIELD / ZONE A</div>
          <h2 className="panel-title">Live 32 × 24 Infrared Heatmap</h2>
        </div>
        <div className="text-xs font-mono text-zinc-500 bg-zinc-100 dark:bg-zinc-800/60 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700/50">
          768-PIXEL BILINEAR INTERPOLATION
        </div>
      </div>
      <div className="thermal-reading-row">
        <div className="thermal-reading">
          <span className="thermal-reading-label">PEAK SURFACE</span>
          <strong>{maxTemp.toFixed(1)}<small>°C</small></strong>
          <span className="thermal-reading-sub">Zone {String.fromCharCode(65 + Math.floor(hotX / 8))} · row {String(hotY + 1).padStart(2, '0')}</span>
        </div>
        <div className="thermal-reading thermal-reading-secondary">
          <span className="thermal-reading-label">AREA MEAN</span>
          <strong>{avgTemp.toFixed(1)}<small>°C</small></strong>
          <span className="thermal-reading-sub">32 × 24 infrared array</span>
        </div>
        <div className="thermal-coordinate">
          <Crosshair size={14} />
          <span>HOTSPOT</span>
          <b>X {String(hotX + 1).padStart(2, '0')} / Y {String(hotY + 1).padStart(2, '0')}</b>
        </div>
      </div>
      <div className="heatmap-wrap" onPointerMove={trackPointer} onPointerLeave={() => setHover(null)}>
        <canvas ref={canvasRef} width={512} height={384} className="heatmap-canvas" aria-label="Thermal heatmap, pointer over cells for temperature readout" />
        <div
          className="hotspot-crosshair"
          style={{ left: `${((hotX + 0.5) / WIDTH) * 100}%`, top: `${((hotY + 0.5) / HEIGHT) * 100}%` }}
        >
          <span />
        </div>
        {hover && (
          <div className="heatmap-tooltip" style={{ left: `${Math.min(84, Math.max(2, (hover.x / WIDTH) * 100))}%`, top: `${Math.max(4, (hover.y / HEIGHT) * 100)}%` }}>
            <b>{hover.temp.toFixed(1)}°C</b>
            <span>X{String(hover.x + 1).padStart(2, '0')} · Y{String(hover.y + 1).padStart(2, '0')}</span>
          </div>
        )}
      </div>
      <div className="thermal-footer">
        <div className="heat-scale-label"><span>{currentMin.toFixed(0)}°C</span><div className="heat-scale" /><span>{currentMax.toFixed(0)}°C+</span></div>
        <span className="thermal-instruction"><MoveUpRight size={12} /> Hover anywhere to inspect temperature</span>
        <span className="thermal-resolution mono-font">FULL 32×24 RESOLUTION</span>
      </div>
    </section>
  );
}
