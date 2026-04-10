import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/**
 * A lightweight (no extra deps) crayon-like drawing app built on HTML canvas.
 * Features:
 * - Crayon + eraser tools
 * - Undo/redo (snapshot-based)
 * - Clear
 * - Export PNG
 * - Optional paper textures (procedural)
 * - Autosave to localStorage
 * - Keyboard shortcuts
 */

const STORAGE_KEY = "crayon_canvas_v1";

const TOOLS = {
  CRAYON: "crayon",
  ERASER: "eraser",
};

const PAPER = {
  NONE: "none",
  WHITE: "white",
  WARM: "warm",
  BLUE: "blue",
  RECYCLED: "recycled",
};

// PUBLIC_INTERFACE
function App() {
  /** Canvas refs (two-layer approach: background and drawing). */
  const containerRef = useRef(null);
  const bgCanvasRef = useRef(null);
  const drawCanvasRef = useRef(null);

  /** Internal pointer tracking. */
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef(null);
  const lastTsRef = useRef(0);

  /** History state stored as dataURLs to keep implementation dependency-free. */
  const historyRef = useRef({
    undoStack: [],
    redoStack: [],
    lastSavedDataUrl: null,
  });

  /** Autosave debounce timer. */
  const autosaveTimerRef = useRef(null);

  /** UI state. */
  const [tool, setTool] = useState(TOOLS.CRAYON);
  const [color, setColor] = useState("#2563eb"); // blue-600-ish
  const [size, setSize] = useState(18);
  const [paper, setPaper] = useState(PAPER.WHITE);
  const [showGridHelp, setShowGridHelp] = useState(false); // small UX hint toggle on mobile

  /** Derived flags. */
  const canUndo = historyRef.current.undoStack.length > 0;
  const canRedo = historyRef.current.redoStack.length > 0;

  const sizeLabel = useMemo(() => {
    if (size <= 8) return "Small";
    if (size <= 18) return "Medium";
    if (size <= 32) return "Large";
    return "XL";
  }, [size]);

  const toolLabel = tool === TOOLS.CRAYON ? "Crayon" : "Eraser";

  const getCanvas2d = useCallback((ref) => {
    const canvas = ref.current;
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    return ctx || null;
  }, []);

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const dprScaleCanvases = useCallback(() => {
    const container = containerRef.current;
    const bgCanvas = bgCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!container || !bgCanvas || !drawCanvas) return;

    const rect = container.getBoundingClientRect();
    // Ensure non-zero dimensions
    const cssW = Math.max(320, Math.floor(rect.width));
    const cssH = Math.max(320, Math.floor(rect.height));
    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));

    // Helper to set up a canvas with DPR scaling while keeping CSS size stable.
    const setup = (canvas) => {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Make strokes look more natural.
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };

    setup(bgCanvas);
    setup(drawCanvas);

    // Repaint background and then rehydrate drawing from autosave if we had one.
    paintBackground(paper);
    restoreFromLocalStorageIfPresent(/* allowNoop */ true);
  }, [paper]);

  const paintBackground = useCallback(
    (paperKind) => {
      const ctx = getCanvas2d(bgCanvasRef);
      const bgCanvas = bgCanvasRef.current;
      if (!ctx || !bgCanvas) return;

      const w = bgCanvas.clientWidth;
      const h = bgCanvas.clientHeight;

      // Base color.
      let base = "#ffffff";
      if (paperKind === PAPER.WARM) base = "#fff7ed"; // warm
      if (paperKind === PAPER.BLUE) base = "#eff6ff"; // blue tint
      if (paperKind === PAPER.RECYCLED) base = "#faf5e6"; // recycled-ish

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = paperKind === PAPER.NONE ? "#ffffff" : base;
      ctx.fillRect(0, 0, w, h);

      if (paperKind === PAPER.NONE) return;

      // Procedural subtle paper texture: tiny speckles + faint fibers.
      // This keeps us dependency-free and avoids shipping binary assets.
      const rng = mulberry32(hashStringToUint32(`${paperKind}:${w}x${h}`));
      const speckles = Math.floor((w * h) / 900); // density
      for (let i = 0; i < speckles; i++) {
        const x = Math.floor(rng() * w);
        const y = Math.floor(rng() * h);
        const r = rng() * 1.6 + 0.2;

        let alpha = 0.06 + rng() * 0.08;
        let c = "17,24,39"; // slate-900
        if (paperKind === PAPER.WARM) c = "120,53,15"; // amber-ish
        if (paperKind === PAPER.BLUE) c = "30,64,175"; // indigo-ish
        if (paperKind === PAPER.RECYCLED) c = "63,63,70"; // zinc-ish

        ctx.fillStyle = `rgba(${c},${alpha})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Fibers
      const fibers = Math.floor((w * h) / 50000);
      for (let i = 0; i < fibers; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const len = 30 + rng() * 120;
        const angle = rng() * Math.PI;
        ctx.strokeStyle = `rgba(0,0,0,${0.02 + rng() * 0.03})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
        ctx.stroke();
      }

      // A tiny vignette to make it feel less flat.
      const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.75);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(1, "rgba(0,0,0,0.04)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    },
    [getCanvas2d]
  );

  const clearDrawing = useCallback(() => {
    const ctx = getCanvas2d(drawCanvasRef);
    const canvas = drawCanvasRef.current;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }, [getCanvas2d]);

  const loadDataUrlToDrawingCanvas = useCallback(
    async (dataUrl) => {
      const ctx = getCanvas2d(drawCanvasRef);
      const canvas = drawCanvasRef.current;
      if (!ctx || !canvas) return;

      clearDrawing();
      if (!dataUrl) return;

      await drawImageToCanvas(ctx, dataUrl, canvas.clientWidth, canvas.clientHeight);
    },
    [clearDrawing, getCanvas2d]
  );

  const snapshot = useCallback(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;
    try {
      return canvas.toDataURL("image/png");
    } catch {
      return null;
    }
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const snap = snapshot();
    if (!snap) return;
    historyRef.current.undoStack.push(snap);
    // Any new stroke invalidates redo history.
    historyRef.current.redoStack = [];
  }, [snapshot]);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = window.setTimeout(() => {
      const drawData = snapshot();
      if (!drawData) return;
      const payload = {
        v: 1,
        paper,
        drawDataUrl: drawData,
        ts: Date.now(),
      };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        historyRef.current.lastSavedDataUrl = drawData;
      } catch {
        // If storage is full or blocked, silently ignore; user can still export.
      }
    }, 350);
  }, [paper, snapshot]);

  const restoreFromLocalStorageIfPresent = useCallback(
    (allowNoop) => {
      // Only restore if we don't already have a different drawing rendered.
      const existingSnap = snapshot();
      const lastSaved = historyRef.current.lastSavedDataUrl;

      if (!allowNoop && existingSnap && lastSaved && existingSnap !== lastSaved) {
        return;
      }

      let raw = null;
      try {
        raw = localStorage.getItem(STORAGE_KEY);
      } catch {
        raw = null;
      }
      if (!raw) return;

      try {
        const payload = JSON.parse(raw);
        if (!payload || payload.v !== 1) return;

        // Restore paper selection first (background repainted by effect).
        if (payload.paper && Object.values(PAPER).includes(payload.paper)) {
          setPaper(payload.paper);
        }

        if (payload.drawDataUrl) {
          // Set lastSaved before loading to avoid re-restore loops.
          historyRef.current.lastSavedDataUrl = payload.drawDataUrl;
          // Load on next tick (ensures canvas size is set).
          window.setTimeout(() => {
            loadDataUrlToDrawingCanvas(payload.drawDataUrl);
          }, 0);
        }
      } catch {
        // Ignore corrupted storage.
      }
    },
    [loadDataUrlToDrawingCanvas, snapshot]
  );

  const exportPng = useCallback(() => {
    const bgCanvas = bgCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!bgCanvas || !drawCanvas) return;

    // Compose background + drawing into a new canvas.
    const w = drawCanvas.clientWidth;
    const h = drawCanvas.clientHeight;
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(bgCanvas, 0, 0, w, h);
    ctx.drawImage(drawCanvas, 0, 0, w, h);

    const url = out.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `crayon-canvas-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
    a.click();
  }, []);

  const undo = useCallback(async () => {
    const { undoStack, redoStack } = historyRef.current;
    if (undoStack.length === 0) return;

    const current = snapshot();
    const prev = undoStack.pop();
    if (current) redoStack.push(current);

    await loadDataUrlToDrawingCanvas(prev);
    scheduleAutosave();
  }, [loadDataUrlToDrawingCanvas, scheduleAutosave, snapshot]);

  const redo = useCallback(async () => {
    const { undoStack, redoStack } = historyRef.current;
    if (redoStack.length === 0) return;

    const current = snapshot();
    const next = redoStack.pop();
    if (current) undoStack.push(current);

    await loadDataUrlToDrawingCanvas(next);
    scheduleAutosave();
  }, [loadDataUrlToDrawingCanvas, scheduleAutosave, snapshot]);

  const clearAll = useCallback(() => {
    pushUndoSnapshot();
    clearDrawing();
    scheduleAutosave();
  }, [clearDrawing, pushUndoSnapshot, scheduleAutosave]);

  const setCrayonTool = useCallback(() => setTool(TOOLS.CRAYON), []);
  const setEraserTool = useCallback(() => setTool(TOOLS.ERASER), []);

  const beginStroke = useCallback(
    (pt, ts) => {
      const ctx = getCanvas2d(drawCanvasRef);
      const canvas = drawCanvasRef.current;
      if (!ctx || !canvas) return;

      pushUndoSnapshot();

      isDrawingRef.current = true;
      lastPointRef.current = pt;
      lastTsRef.current = ts;

      // For immediate dot on tap/click.
      drawCrayonSegment(ctx, pt, pt, 0, {
        tool,
        color,
        size,
        seed: ts,
      });
    },
    [color, getCanvas2d, pushUndoSnapshot, size, tool]
  );

  const moveStroke = useCallback(
    (pt, ts) => {
      if (!isDrawingRef.current) return;

      const ctx = getCanvas2d(drawCanvasRef);
      if (!ctx) return;

      const last = lastPointRef.current;
      const lastTs = lastTsRef.current;

      if (!last) {
        lastPointRef.current = pt;
        lastTsRef.current = ts;
        return;
      }

      // Pointer speed -> "pressure" simulation (faster => lighter).
      const dx = pt.x - last.x;
      const dy = pt.y - last.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const dt = Math.max(1, ts - lastTs);
      const speed = dist / dt; // px per ms

      drawCrayonSegment(ctx, last, pt, speed, {
        tool,
        color,
        size,
        seed: ts,
      });

      lastPointRef.current = pt;
      lastTsRef.current = ts;
    },
    [color, getCanvas2d, size, tool]
  );

  const endStroke = useCallback(() => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPointRef.current = null;
    lastTsRef.current = 0;

    scheduleAutosave();
  }, [scheduleAutosave]);

  const canvasPointFromEvent = useCallback((evt) => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return null;

    // PointerEvent and TouchEvent support
    const rect = canvas.getBoundingClientRect();
    const clientX = evt.clientX ?? (evt.touches && evt.touches[0] ? evt.touches[0].clientX : null);
    const clientY = evt.clientY ?? (evt.touches && evt.touches[0] ? evt.touches[0].clientY : null);
    if (clientX == null || clientY == null) return null;

    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  const onPointerDown = useCallback(
    (e) => {
      // Prevent page scroll on touch while drawing.
      e.preventDefault();

      const pt = canvasPointFromEvent(e);
      if (!pt) return;

      // Capture pointer so we keep getting events if pointer leaves canvas.
      if (drawCanvasRef.current?.setPointerCapture && e.pointerId != null) {
        try {
          drawCanvasRef.current.setPointerCapture(e.pointerId);
        } catch {
          // Ignore capture failures.
        }
      }

      beginStroke(pt, performance.now());
    },
    [beginStroke, canvasPointFromEvent]
  );

  const onPointerMove = useCallback(
    (e) => {
      if (!isDrawingRef.current) return;
      e.preventDefault();
      const pt = canvasPointFromEvent(e);
      if (!pt) return;
      moveStroke(pt, performance.now());
    },
    [canvasPointFromEvent, moveStroke]
  );

  const onPointerUp = useCallback(
    (e) => {
      e.preventDefault();
      endStroke();
    },
    [endStroke]
  );

  const onPointerCancel = useCallback(
    (e) => {
      e.preventDefault();
      endStroke();
    },
    [endStroke]
  );

  // Keyboard shortcuts:
  // - C: Crayon
  // - E: Eraser
  // - Ctrl/Cmd+Z: Undo
  // - Ctrl/Cmd+Shift+Z OR Ctrl/Cmd+Y: Redo
  // - Backspace/Delete: Clear
  // - Ctrl/Cmd+S: Export PNG
  useEffect(() => {
    const handler = (e) => {
      const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Avoid capturing keystrokes while focusing inputs (color/slider/select).
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;

      if (e.key === "c" || e.key === "C") {
        setCrayonTool();
        return;
      }
      if (e.key === "e" || e.key === "E") {
        setEraserTool();
        return;
      }

      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        clearAll();
        return;
      }

      if (mod && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        exportPng();
      }
    };

    window.addEventListener("keydown", handler, { passive: false });
    return () => window.removeEventListener("keydown", handler);
  }, [clearAll, exportPng, redo, setCrayonTool, setEraserTool, undo]);

  // Resize handling.
  useEffect(() => {
    const onResize = () => dprScaleCanvases();
    window.addEventListener("resize", onResize);
    dprScaleCanvases();
    return () => window.removeEventListener("resize", onResize);
  }, [dprScaleCanvases]);

  // When paper changes, repaint background (drawing preserved).
  useEffect(() => {
    paintBackground(paper);
    scheduleAutosave();
  }, [paintBackground, paper, scheduleAutosave]);

  // Initial restore from local storage once.
  useEffect(() => {
    restoreFromLocalStorageIfPresent(/* allowNoop */ true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const helpText = useMemo(() => {
    return [
      "Shortcuts:",
      "C = Crayon, E = Eraser",
      "Ctrl/Cmd+Z = Undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = Redo",
      "Delete/Backspace = Clear",
      "Ctrl/Cmd+S = Export PNG",
    ].join("  •  ");
  }, []);

  return (
    <div className="cc-App">
      <header className="cc-Topbar" role="banner">
        <div className="cc-Brand">
          <div className="cc-LogoMark" aria-hidden="true">
            <span className="cc-LogoDot" />
          </div>
          <div className="cc-BrandText">
            <div className="cc-Title">Crayon Canvas</div>
            <div className="cc-SubTitle">Draw with a crayon-like texture</div>
          </div>
        </div>

        <div className="cc-Actions" role="toolbar" aria-label="Drawing toolbar">
          <div className="cc-ToolGroup" aria-label="Tools">
            <button
              type="button"
              className={`cc-ToolBtn ${tool === TOOLS.CRAYON ? "isActive" : ""}`}
              onClick={setCrayonTool}
              aria-pressed={tool === TOOLS.CRAYON}
              title="Crayon (C)"
            >
              Crayon
            </button>
            <button
              type="button"
              className={`cc-ToolBtn ${tool === TOOLS.ERASER ? "isActive" : ""}`}
              onClick={setEraserTool}
              aria-pressed={tool === TOOLS.ERASER}
              title="Eraser (E)"
            >
              Eraser
            </button>
          </div>

          <div className="cc-ToolGroup" aria-label="Color and size">
            <label className="cc-Field">
              <span className="cc-FieldLabel">Color</span>
              <input
                className="cc-ColorInput"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                disabled={tool !== TOOLS.CRAYON}
                aria-label="Crayon color"
              />
            </label>

            <label className="cc-Field cc-SizeField">
              <span className="cc-FieldLabel">
                Size <span className="cc-FieldHint">({sizeLabel})</span>
              </span>
              <input
                className="cc-Range"
                type="range"
                min={4}
                max={56}
                step={1}
                value={size}
                onChange={(e) => setSize(parseInt(e.target.value, 10))}
                aria-label="Brush size"
              />
            </label>
          </div>

          <div className="cc-ToolGroup" aria-label="Background">
            <label className="cc-Field">
              <span className="cc-FieldLabel">Paper</span>
              <select className="cc-Select" value={paper} onChange={(e) => setPaper(e.target.value)} aria-label="Paper texture">
                <option value={PAPER.NONE}>None</option>
                <option value={PAPER.WHITE}>White</option>
                <option value={PAPER.WARM}>Warm</option>
                <option value={PAPER.BLUE}>Blue</option>
                <option value={PAPER.RECYCLED}>Recycled</option>
              </select>
            </label>
          </div>

          <div className="cc-ToolGroup" aria-label="History and export">
            <button type="button" className="cc-ActionBtn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl/Cmd+Z)">
              Undo
            </button>
            <button type="button" className="cc-ActionBtn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl/Cmd+Y)">
              Redo
            </button>
            <button type="button" className="cc-ActionBtn danger" onClick={clearAll} title="Clear (Delete/Backspace)">
              Clear
            </button>
            <button type="button" className="cc-ActionBtn primary" onClick={exportPng} title="Export PNG (Ctrl/Cmd+S)">
              Export PNG
            </button>
          </div>
        </div>
      </header>

      <main className="cc-Main" role="main">
        <section className="cc-CanvasCard" aria-label="Drawing canvas">
          <div className="cc-CanvasMeta">
            <div className="cc-CanvasMetaLeft">
              <span className="cc-Pill">{toolLabel}</span>
              {tool === TOOLS.CRAYON ? <span className="cc-Pill subtle">Color {color.toUpperCase()}</span> : <span className="cc-Pill subtle">Erase</span>}
              <span className="cc-Pill subtle">Size {size}</span>
              <span className="cc-Pill subtle">Paper {paper}</span>
            </div>
            <div className="cc-CanvasMetaRight">
              <button type="button" className="cc-LinkBtn" onClick={() => setShowGridHelp((v) => !v)}>
                {showGridHelp ? "Hide tips" : "Tips"}
              </button>
            </div>
          </div>

          <div className="cc-CanvasContainer" ref={containerRef}>
            <canvas className="cc-Canvas cc-CanvasBg" ref={bgCanvasRef} aria-hidden="true" />
            <canvas
              className="cc-Canvas cc-CanvasDraw"
              ref={drawCanvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              // critical for touch drawing: disable browser gestures on canvas
              style={{ touchAction: "none" }}
              role="application"
              aria-label="Drawing surface"
            />
            {showGridHelp && (
              <div className="cc-Tips" role="note">
                <div className="cc-TipsTitle">Tips</div>
                <ul className="cc-TipsList">
                  <li>Draw slower for a heavier crayon look.</li>
                  <li>Use the eraser for broad strokes, then reduce size for detail.</li>
                  <li>Export saves a PNG with the selected paper background.</li>
                  <li>Autosave is enabled (stored locally in your browser).</li>
                </ul>
              </div>
            )}
          </div>

          <div className="cc-FooterHelp" aria-label="Keyboard shortcuts help">
            {helpText}
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;

/** ---------- Drawing Engine (crayon simulation) ---------- **/

function drawCrayonSegment(ctx, a, b, speed, opts) {
  const { tool, color, size, seed } = opts;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(1, Math.floor(dist / 2)); // high frequency for texture

  const rng = mulberry32(hashStringToUint32(`${seed}:${Math.floor(a.x)}:${Math.floor(a.y)}`));

  // Speed-based "pressure": slower => more opaque; faster => more transparent.
  // Clamp range to keep it controllable.
  const pressure = clamp01(1 - speed * 0.9); // tune feel
  const baseAlpha = tool === TOOLS.ERASER ? 1 : 0.25 + pressure * 0.55;

  ctx.save();

  if (tool === TOOLS.ERASER) {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = hexToRgba(color, baseAlpha);
  }

  // A "waxy" crayon look: layered micro-strokes with jitter + speckle.
  // We render several sub-strokes per segment to emulate paper grain.
  const layers = tool === TOOLS.ERASER ? 1 : 3;
  const jitter = tool === TOOLS.ERASER ? 0.35 : 0.9;
  const grain = tool === TOOLS.ERASER ? 0 : 0.45;

  for (let l = 0; l < layers; l++) {
    const layerAlpha = tool === TOOLS.ERASER ? 1 : baseAlpha * (0.72 + rng() * 0.35);
    if (tool !== TOOLS.ERASER) ctx.strokeStyle = hexToRgba(color, layerAlpha);

    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = a.x + dx * t;
      const y = a.y + dy * t;

      const jx = (rng() - 0.5) * size * jitter * 0.15;
      const jy = (rng() - 0.5) * size * jitter * 0.15;

      if (i === 0) ctx.moveTo(x + jx, y + jy);
      else ctx.lineTo(x + jx, y + jy);

      // Speckle: small dots near the path create crayon grain.
      if (tool !== TOOLS.ERASER && rng() < 0.12 + grain * 0.08) {
        const r = 0.3 + rng() * 1.2;
        ctx.fillStyle = hexToRgba(color, layerAlpha * (0.25 + rng() * 0.35));
        ctx.beginPath();
        ctx.arc(x + (rng() - 0.5) * size * 0.25, y + (rng() - 0.5) * size * 0.25, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.lineWidth = tool === TOOLS.ERASER ? size * 0.95 : size * (0.75 + rng() * 0.25);
    ctx.stroke();
  }

  // Extra waxy "overdraw" at slow speeds.
  if (tool !== TOOLS.ERASER && pressure > 0.7) {
    ctx.globalAlpha = 0.12;
    ctx.lineWidth = size * 0.35;
    ctx.strokeStyle = hexToRgba(color, 0.25);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.restore();
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function hexToRgba(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

function hexToRgb(hex) {
  const clean = (hex || "").replace("#", "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return { r, g, b };
  }
  // fallback
  return { r: 0, g: 0, b: 0 };
}

async function drawImageToCanvas(ctx, dataUrl, w, h) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Contain without distortion (but saved images should match same size).
      ctx.drawImage(img, 0, 0, w, h);
      resolve();
    };
    img.onerror = () => resolve();
    img.src = dataUrl;
  });
}

/** ---------- Deterministic RNG helpers for procedural textures ---------- **/

function hashStringToUint32(str) {
  // Simple FNV-1a variant
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
