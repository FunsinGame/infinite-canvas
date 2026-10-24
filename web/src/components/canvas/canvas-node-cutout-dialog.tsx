import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Modal, Slider, Switch, Tooltip } from "antd";
import { Brush, Check, RotateCcw, SquareDashed, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { canvasThemes } from "@/lib/canvas-theme";
import { cutoutMaskDataUrl, cutoutRectDataUrl, type ImageCropRect } from "@/lib/canvas/canvas-image-data";
import { readImageMeta } from "@/lib/image-utils";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasImageCutoutPayload = {
    dataUrl: string;
    aiRepair: boolean;
    transparentBackground: boolean;
};

type CutoutMode = "rect" | "brush";
type Point = { x: number; y: number };
type Stroke = { size: number; points: Point[] };
type BrushPreview = { x: number; y: number; size: number };

const defaultBrushRatio = 0.08;
const minRectSize = 0.01;
const maskColor = "#2563eb";

export function CanvasNodeCutoutDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageCutoutPayload) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const drawingRef = useRef<Stroke | null>(null);
    const rectStartRef = useRef<Point | null>(null);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [mode, setMode] = useState<CutoutMode>("rect");
    const [rect, setRect] = useState<ImageCropRect | null>(null);
    const [hasBrush, setHasBrush] = useState(false);
    const [brushSize, setBrushSize] = useState(80);
    const [aiRepair, setAiRepair] = useState(true);
    const [transparentBackground, setTransparentBackground] = useState(true);
    const [brushPreview, setBrushPreview] = useState<BrushPreview | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const viewport = useImageEditorViewport(image, open);
    const maxBrushSize = image ? Math.max(40, Math.round(Math.min(image.width, image.height) * 0.5)) : 200;
    const rectSize = image && rect ? `${Math.max(1, Math.round(rect.width * image.width))} × ${Math.max(1, Math.round(rect.height * image.height))}` : "";

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setMode("rect");
        setRect(null);
        setHasBrush(false);
        setAiRepair(true);
        setTransparentBackground(true);
        setBrushPreview(null);
        setError("");
        setBusy(false);
        drawingRef.current = null;
        rectStartRef.current = null;
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(overlayCanvasRef.current);
        drawingRef.current = null;
        setHasBrush(false);
        if (image) setBrushSize(clampBrushSize(Math.round(Math.min(image.width, image.height) * defaultBrushRatio), image));
    }, [image]);

    const updateBrushPreview = (event: ReactPointerEvent<HTMLDivElement>) => {
        setBrushPreview({ x: event.clientX, y: event.clientY, size: brushSize });
    };

    const readPoint = (event: ReactPointerEvent<HTMLDivElement>): Point => {
        const box = event.currentTarget.getBoundingClientRect();
        return {
            x: clamp((event.clientX - box.left) / Math.max(1, box.width), 0, 1),
            y: clamp((event.clientY - box.top) / Math.max(1, box.height), 0, 1),
        };
    };

    const drawStroke = (from: Point, to: Point, size: number) => {
        for (const [canvas, color] of [
            [maskCanvasRef.current, "#000000"],
            [overlayCanvasRef.current, maskColor],
        ] as const) {
            const context = canvas?.getContext("2d");
            if (!context) continue;
            context.lineCap = "round";
            context.lineJoin = "round";
            context.lineWidth = size;
            context.strokeStyle = color;
            context.fillStyle = color;
            if (from.x === to.x && from.y === to.y) {
                context.beginPath();
                context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
                context.fill();
                continue;
            }
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.stroke();
        }
    };

    const startDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!image || event.button !== 0 || viewport.spacePressed) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = readPoint(event);
        if (mode === "rect") {
            rectStartRef.current = point;
            setRect({ x: point.x, y: point.y, width: 0, height: 0 });
            setError("");
            return;
        }
        const imagePoint = toImagePoint(point, image);
        const stroke: Stroke = { size: brushSize, points: [imagePoint] };
        drawingRef.current = stroke;
        drawStroke(imagePoint, imagePoint, stroke.size);
        setHasBrush(true);
        setError("");
        updateBrushPreview(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!image) return;
        if (mode === "brush") {
            if (event.pointerType !== "touch") updateBrushPreview(event);
            const stroke = drawingRef.current;
            if (!stroke) return;
            event.preventDefault();
            const imagePoint = toImagePoint(readPoint(event), image);
            const previous = stroke.points.at(-1) || imagePoint;
            drawStroke(previous, imagePoint, stroke.size);
            stroke.points.push(imagePoint);
            return;
        }
        const start = rectStartRef.current;
        if (!start) return;
        event.preventDefault();
        const current = readPoint(event);
        setRect({
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
        });
    };

    const stopDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (mode === "brush") {
            drawingRef.current = null;
            return;
        }
        rectStartRef.current = null;
        setRect((current) => (current && current.width >= minRectSize && current.height >= minRectSize ? current : null));
    };

    const resetSelection = () => {
        rectStartRef.current = null;
        drawingRef.current = null;
        setRect(null);
        setHasBrush(false);
        setError("");
        clearCanvas(maskCanvasRef.current);
        clearCanvas(overlayCanvasRef.current);
    };

    const submit = async () => {
        if (!image || busy) return;
        if (mode === "rect" && !rect) {
            setError(t("canvas.editors.cutoutRectRequired"));
            return;
        }
        if (mode === "brush" && !hasBrush) {
            setError(t("canvas.editors.cutoutBrushRequired"));
            return;
        }
        setBusy(true);
        setError("");
        try {
            const maskDataUrl = maskCanvasRef.current?.toDataURL("image/png");
            const cutout =
                mode === "rect" && rect
                    ? await cutoutRectDataUrl(dataUrl, rect, transparentBackground)
                    : maskDataUrl
                      ? await cutoutMaskDataUrl(dataUrl, maskDataUrl, transparentBackground)
                      : null;
            if (!cutout) throw new Error(t("canvas.editors.cutoutEmpty"));
            onConfirm({ dataUrl: cutout, aiRepair, transparentBackground });
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : t("canvas.editors.cutoutEmpty"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1060} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(400px,1fr)_320px]" data-canvas-no-zoom>
                <div className="relative">
                    <div
                        ref={viewport.viewportRef}
                        {...viewport.panHandlers}
                        className={`relative h-[min(68vh,720px)] min-h-[360px] rounded-xl border border-black/10 bg-black/5 dark:border-white/10 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                    >
                        <div className="relative" style={viewport.contentStyle}>
                            <div ref={viewport.stageRef} className="absolute isolate overflow-hidden rounded-lg bg-transparent select-none [backface-visibility:hidden] [contain:layout_paint] [transform:translateZ(0)]" style={viewport.stageStyle}>
                                {image ? (
                                    <div className="absolute inset-0 [backface-visibility:hidden]" style={viewport.mediaStyle}>
                                        <img src={dataUrl} alt="" className="absolute inset-0 block size-full object-contain" draggable={false} />
                                        <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                        <canvas
                                            ref={overlayCanvasRef}
                                            width={image.width}
                                            height={image.height}
                                            className="pointer-events-none absolute inset-0 size-full"
                                            style={{ opacity: mode === "brush" ? 0.42 : 0, transition: "opacity 120ms" }}
                                        />
                                        <RectSelection rect={mode === "rect" ? rect : null} label={rectSize} />
                                        <div
                                            className="absolute inset-0 touch-none"
                                            style={{ cursor: mode === "brush" ? "none" : "crosshair" }}
                                            onPointerDown={startDraw}
                                            onPointerMove={moveDraw}
                                            onPointerUp={stopDraw}
                                            onPointerCancel={stopDraw}
                                            onPointerLeave={(event) => {
                                                if (!drawingRef.current && !rectStartRef.current) setBrushPreview(null);
                                                else if (mode === "brush" && drawingRef.current) updateBrushPreview(event);
                                            }}
                                            onContextMenu={(event) => event.preventDefault()}
                                        />
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                        <div className="pointer-events-auto flex items-center gap-1 rounded-lg border px-1.5 py-0.5 backdrop-blur" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}>
                            <Tooltip title={t("canvas.editors.zoomOut")}>
                                <Button type="text" size="small" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut} />
                            </Tooltip>
                            <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Tooltip title={t("canvas.editors.zoomIn")}>
                                <Button type="text" size="small" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn} />
                            </Tooltip>
                        </div>
                    </div>
                </div>

                <div className="flex min-h-[360px] flex-col gap-4">
                    <div>
                        <h2 className="text-xl font-semibold">{t("canvas.editors.cutoutTitle")}</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                        <div className="mt-2 text-xs leading-5 opacity-55">{t(mode === "rect" ? "canvas.editors.cutoutRectHint" : "canvas.editors.cutoutBrushHint")}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <Button type={mode === "rect" ? "primary" : "default"} icon={<SquareDashed className="size-4" />} onClick={() => { setMode("rect"); setBrushPreview(null); setError(""); }} disabled={!image}>
                            {t("canvas.editors.cutoutRect")}
                        </Button>
                        <Button type={mode === "brush" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => { setMode("brush"); setError(""); }} disabled={!image}>
                            {t("canvas.editors.cutoutBrush")}
                        </Button>
                    </div>

                    {mode === "brush" ? (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-sm">
                                <span className="font-medium opacity-75">{t("canvas.editors.brushSize")}</span>
                                <span className="font-semibold">{brushSize}px</span>
                            </div>
                            <Slider min={8} max={maxBrushSize} step={2} value={brushSize} disabled={!image} onChange={(value) => setBrushSize(clampBrushSize(value, image))} />
                        </div>
                    ) : null}

                    <div className="space-y-2">
                        <label className="flex items-start justify-between gap-3 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                            <span className="min-w-0">
                                <span className="block text-sm font-medium">{t("canvas.editors.cutoutAiRepair")}</span>
                                <span className="mt-0.5 block text-xs leading-5 opacity-55">{t("canvas.editors.cutoutAiRepairHint")}</span>
                            </span>
                            <Switch size="small" checked={aiRepair} onChange={setAiRepair} />
                        </label>
                        <label className="flex items-start justify-between gap-3 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                            <span className="min-w-0">
                                <span className="block text-sm font-medium">{t("canvas.editors.cutoutTransparent")}</span>
                                <span className="mt-0.5 block text-xs leading-5 opacity-55">{t("canvas.editors.cutoutTransparentHint")}</span>
                            </span>
                            <Switch size="small" checked={transparentBackground} onChange={setTransparentBackground} />
                        </label>
                    </div>

                    <div className="mt-auto space-y-3">
                        <div className="text-xs leading-5 opacity-55">{t("canvas.editors.cropHint")}</div>
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                        <div className="flex items-center justify-between gap-2">
                            <Button icon={<RotateCcw className="size-4" />} onClick={resetSelection}>
                                {t("canvas.editors.reset")}
                            </Button>
                            <div className="flex items-center gap-2">
                                <Button onClick={onClose}>{t("canvas.editors.cancel")}</Button>
                                <Button type="primary" icon={<Check className="size-4" />} loading={busy} disabled={!image} onClick={() => void submit()}>
                                    {t("canvas.editors.cutoutConfirm")}
                                </Button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {brushPreview && mode === "brush"
                ? createPortal(
                      <div
                          className="pointer-events-none fixed z-[1100] rounded-full border-2 border-white/90 bg-black/5 shadow-[0_0_0_1px_rgba(0,0,0,.8)]"
                          style={{ left: brushPreview.x, top: brushPreview.y, width: Math.max(4, brushPreview.size * viewport.imageScale), aspectRatio: 1, transform: "translate(-50%, -50%)" }}
                      />,
                      document.body,
                  )
                : null}
        </Modal>
    );
}

function RectSelection({ rect, label }: { rect: ImageCropRect | null; label: string }) {
    if (!rect) return null;
    return (
        <>
            <div className="pointer-events-none absolute inset-x-0 top-0 bg-black/50" style={{ height: `${rect.y * 100}%` }} />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/50" style={{ height: `${(1 - rect.y - rect.height) * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/50" style={{ left: 0, top: `${rect.y * 100}%`, width: `${rect.x * 100}%`, height: `${rect.height * 100}%` }} />
            <div className="pointer-events-none absolute bg-black/50" style={{ right: 0, top: `${rect.y * 100}%`, width: `${(1 - rect.x - rect.width) * 100}%`, height: `${rect.height * 100}%` }} />
            <div className="pointer-events-none absolute border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.3),0_0_24px_rgba(0,0,0,.24)]" style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}>
                {rect.width > 0.06 && rect.height > 0.04 ? <span className="absolute left-1 top-1 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white">{label}</span> : null}
            </div>
        </>
    );
}

function toImagePoint(point: Point, image: { width: number; height: number }): Point {
    return { x: point.x * image.width, y: point.y * image.height };
}

function clampBrushSize(value: number, image: { width: number; height: number } | null) {
    const max = image ? Math.max(40, Math.round(Math.min(image.width, image.height) * 0.5)) : 200;
    return Math.min(max, Math.max(8, Math.round(value / 2) * 2));
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
