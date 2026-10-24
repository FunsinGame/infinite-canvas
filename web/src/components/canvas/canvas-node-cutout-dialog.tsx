import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Modal, Select, Slider, Switch, Tooltip } from "antd";
import { Brush, Check, LoaderCircle, Move, RotateCcw, ScrollText, SquareDashed, ZoomIn, ZoomOut } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { CanvasDecomposeRequestLog, type DecomposeRequestLog } from "@/components/canvas/canvas-decompose-request-log";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildCutoutAiReferenceDataUrl, cutoutMaskDataUrl, cutoutRectDataUrl, flattenImageDataUrl, trimTransparentDataUrl, type ImageCropRect } from "@/lib/canvas/canvas-image-data";
import { readImageMeta } from "@/lib/image-utils";
import { requestEdit } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionLabel, resolveModelForCapability, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasImageCutoutPayload = {
    dataUrl: string;
};

type CutoutMode = "rect" | "brush";
type Point = { x: number; y: number };
type Stroke = { size: number; points: Point[] };
type BrushPreview = { x: number; y: number; size: number };
type RectDragMode = "move" | "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

const defaultBrushRatio = 0.08;
const maskColor = "#2563eb";

export function CanvasNodeCutoutDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageCutoutPayload) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const imageModelOptions = selectableModelsByCapability(effectiveConfig, "image");
    const preferredImageModel = resolveModelForCapability(effectiveConfig, undefined, "image");
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const interactionRef = useRef<HTMLDivElement>(null);
    const drawingRef = useRef<Stroke | null>(null);
    const rectStartRef = useRef<Point | null>(null);
    const dragAbortRef = useRef<AbortController | null>(null);
    const requestAbortRef = useRef<AbortController | null>(null);
    const closedRef = useRef(false);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [mode, setMode] = useState<CutoutMode>("rect");
    const [rect, setRect] = useState<ImageCropRect | null>(null);
    const [creating, setCreating] = useState(false);
    const [hasBrush, setHasBrush] = useState(false);
    const [brushSize, setBrushSize] = useState(80);
    const [aiRepair, setAiRepair] = useState(true);
    const [transparentBackground, setTransparentBackground] = useState(true);
    const [brushPreview, setBrushPreview] = useState<BrushPreview | null>(null);
    const [selectedImageModel, setSelectedImageModel] = useState("");
    const [logs, setLogs] = useState<DecomposeRequestLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [completed, setCompleted] = useState<string | null>(null);
    const [completedFailed, setCompletedFailed] = useState(false);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const viewport = useImageEditorViewport(image, open);
    const maxBrushSize = image ? Math.max(40, Math.round(Math.min(image.width, image.height) * 0.5)) : 200;
    const rectSize = image && rect ? `${Math.max(1, Math.round(rect.width * image.width))} × ${Math.max(1, Math.round(rect.height * image.height))}` : "";
    const imageModel =
        (selectedImageModel && imageModelOptions.includes(selectedImageModel) ? selectedImageModel : "") ||
        (imageModelOptions.includes(preferredImageModel) && isAiConfigReady(effectiveConfig, preferredImageModel) ? preferredImageModel : "") ||
        imageModelOptions.find((model) => isAiConfigReady(effectiveConfig, model)) ||
        (imageModelOptions.includes(preferredImageModel) ? preferredImageModel : imageModelOptions[0]) ||
        "";
    const imageReady = Boolean(imageModel) && isAiConfigReady(effectiveConfig, imageModel);
    // The selection lives in the zoomed media layer, so counter-scale its chrome to keep a constant screen size.
    const overlayScale = 1 / viewport.zoom;
    const locked = processing || Boolean(completed);

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setMode("rect");
        setRect(null);
        setCreating(false);
        setHasBrush(false);
        setAiRepair(true);
        setTransparentBackground(true);
        setSelectedImageModel("");
        setLogs([]);
        setLogsOpen(false);
        setProcessing(false);
        setCompleted(null);
        setCompletedFailed(false);
        setBrushPreview(null);
        setError("");
        setBusy(false);
        drawingRef.current = null;
        rectStartRef.current = null;
        dragAbortRef.current?.abort();
        requestAbortRef.current?.abort();
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        if (!open) return;
        closedRef.current = false;
        return () => {
            closedRef.current = true;
            dragAbortRef.current?.abort();
            requestAbortRef.current?.abort();
        };
    }, [open]);

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

    const readClientPoint = (clientX: number, clientY: number): Point => {
        const box = interactionRef.current?.getBoundingClientRect();
        if (!box) return { x: 0, y: 0 };
        return {
            x: clamp((clientX - box.left) / Math.max(1, box.width), 0, 1),
            y: clamp((clientY - box.top) / Math.max(1, box.height), 0, 1),
        };
    };

    const startRectDrag = (dragMode: RectDragMode, event: ReactPointerEvent) => {
        if (!rect || !image || event.button !== 0 || viewport.spacePressed) return;
        event.preventDefault();
        event.stopPropagation();
        dragAbortRef.current?.abort();
        const controller = new AbortController();
        dragAbortRef.current = controller;
        const start = readClientPoint(event.clientX, event.clientY);
        const startRect = { ...rect };
        const pointerId = event.pointerId;
        const move = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            setRect(computeRectDrag(startRect, dragMode, start, readClientPoint(moveEvent.clientX, moveEvent.clientY), image));
        };
        const stop = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            controller.abort();
            if (dragAbortRef.current === controller) dragAbortRef.current = null;
        };
        document.addEventListener("pointermove", move, { signal: controller.signal });
        document.addEventListener("pointerup", stop, { signal: controller.signal });
        document.addEventListener("pointercancel", stop, { signal: controller.signal });
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
        const point = readClientPoint(event.clientX, event.clientY);
        if (mode === "rect") {
            rectStartRef.current = point;
            setRect({ x: point.x, y: point.y, width: 0, height: 0 });
            setCreating(true);
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
            const imagePoint = toImagePoint(readClientPoint(event.clientX, event.clientY), image);
            const previous = stroke.points.at(-1) || imagePoint;
            drawStroke(previous, imagePoint, stroke.size);
            stroke.points.push(imagePoint);
            return;
        }
        const start = rectStartRef.current;
        if (!start) return;
        event.preventDefault();
        const current = readClientPoint(event.clientX, event.clientY);
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
        setCreating(false);
        setRect((current) => (current && image && current.width * image.width >= 8 && current.height * image.height >= 8 ? current : null));
    };

    const resetSelection = () => {
        rectStartRef.current = null;
        drawingRef.current = null;
        dragAbortRef.current?.abort();
        setRect(null);
        setCreating(false);
        setHasBrush(false);
        setError("");
        clearCanvas(maskCanvasRef.current);
        clearCanvas(overlayCanvasRef.current);
    };

    const submit = async () => {
        if (!image || busy || locked) return;
        if (mode === "rect" && !rect) {
            setError(t("canvas.editors.cutoutRectRequired"));
            return;
        }
        if (mode === "brush" && !hasBrush) {
            setError(t("canvas.editors.cutoutBrushRequired"));
            return;
        }
        if (aiRepair && !imageReady) {
            setError(t("canvas.editors.cutoutModelRequired"));
            return;
        }
        setBusy(true);
        setError("");
        try {
            const maskDataUrl = mode === "brush" ? maskCanvasRef.current?.toDataURL("image/png") : undefined;
            const cutout =
                mode === "rect" && rect
                    ? await cutoutRectDataUrl(dataUrl, rect, transparentBackground)
                    : maskDataUrl
                      ? await cutoutMaskDataUrl(dataUrl, maskDataUrl, transparentBackground)
                      : null;
            if (!cutout) throw new Error(t("canvas.editors.cutoutEmpty"));
            if (closedRef.current) return;
            if (!aiRepair) {
                onConfirm({ dataUrl: cutout });
                onClose();
                return;
            }

            const aiDataUrl = await buildCutoutAiReferenceDataUrl(dataUrl, mode === "rect" && rect ? { rect } : { maskDataUrl });
            const localMeta = await readImageMeta(cutout);
            if (closedRef.current) return;
            const startedAt = Date.now();
            const logId = nanoid();
            const prompt = t("canvas.projectPage.cutoutRepairPrompt");
            const requestConfig = { ...effectiveConfig, model: imageModel, count: "1", size: "auto", background: "transparent" };
            setLogs((current) => [
                ...current,
                {
                    id: logId,
                    elementId: logId,
                    elementName: t("canvas.editors.cutoutTitle"),
                    box: {
                        x: 0,
                        y: 0,
                        width: localMeta.width,
                        height: localMeta.height,
                    },
                    model: modelOptionLabel(effectiveConfig, imageModel),
                    size: "auto",
                    quality: requestConfig.quality || "",
                    background: "transparent",
                    count: 1,
                    prompt,
                    systemPrompt: requestConfig.systemPrompt || "",
                    input: aiDataUrl,
                    status: "loading",
                    createdAt: startedAt,
                },
            ]);
            setProcessing(true);
            const controller = new AbortController();
            requestAbortRef.current = controller;
            try {
                const result = await requestEdit(requestConfig, prompt, [{ id: logId, name: "cutout.png", type: "image/png", dataUrl: aiDataUrl }], { signal: controller.signal }).then((items) => items[0]);
                if (controller.signal.aborted || closedRef.current) return;
                const rawOutput = await imageToDataUrl({ dataUrl: result.dataUrl }, { signal: controller.signal });
                setLogs((current) => current.map((item) => (item.id === logId ? { ...item, status: "success", output: rawOutput, durationMs: Date.now() - startedAt } : item)));
                const trimmedDataUrl = await trimTransparentDataUrl(rawOutput);
                if (!trimmedDataUrl) throw new Error(t("canvas.editors.cutoutEmpty"));
                const finalDataUrl = transparentBackground ? trimmedDataUrl : await flattenImageDataUrl(trimmedDataUrl);
                if (closedRef.current) return;
                onConfirm({ dataUrl: finalDataUrl });
                setCompleted(finalDataUrl);
                setCompletedFailed(false);
            } catch (requestError) {
                if (controller.signal.aborted || closedRef.current) return;
                const errorMessage = requestError instanceof Error ? requestError.message : t("canvas.editors.cutoutAiFailed");
                setLogs((current) => current.map((item) => (item.id === logId ? { ...item, status: "error", error: errorMessage, durationMs: Date.now() - startedAt } : item)));
                onConfirm({ dataUrl: cutout });
                setCompleted(cutout);
                setCompletedFailed(true);
            } finally {
                if (requestAbortRef.current === controller) requestAbortRef.current = null;
                setProcessing(false);
            }
        } catch (submitError) {
            setError(submitError instanceof Error ? submitError.message : t("canvas.editors.cutoutEmpty"));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1060} centered destroyOnHidden transitionName="" maskTransitionName="" maskClosable={!processing} keyboard={!processing}>
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
                                        {mode === "rect" && rect && rect.width > 0 && rect.height > 0 ? (
                                            <div
                                                className={`absolute z-20 touch-none border-sky-400 bg-sky-400/10 ${creating || locked ? "pointer-events-none" : "cursor-move"}`}
                                                style={{ borderWidth: 2 / viewport.zoom, borderStyle: creating ? "dashed" : "solid", left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }}
                                                onPointerDown={creating ? undefined : (event) => startRectDrag("move", event)}
                                            >
                                                {creating || locked ? null : (
                                                    <>
                                                        <span
                                                            className="pointer-events-none absolute left-0 max-w-full truncate bg-sky-500 text-white"
                                                            style={{ bottom: "100%", fontSize: 10 * overlayScale, lineHeight: `${16 * overlayScale}px`, padding: `${2 * overlayScale}px ${6 * overlayScale}px` }}
                                                        >
                                                            {rectSize}
                                                        </span>
                                                        <span
                                                            className="pointer-events-auto absolute left-1/2 z-10 flex -translate-x-1/2 cursor-move items-center justify-center rounded-full border border-white bg-sky-500 text-white shadow"
                                                            style={{ top: 14 * overlayScale, width: 16 * overlayScale, height: 16 * overlayScale, borderWidth: overlayScale }}
                                                            title={t("canvas.editors.cutoutMoveRect")}
                                                            onPointerDown={(event) => startRectDrag("move", event)}
                                                        >
                                                            <Move style={{ width: 10 * overlayScale, height: 10 * overlayScale }} />
                                                        </span>
                                                        <span className="pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 20 * overlayScale, height: 8 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("n", event)} />
                                                        <span className="pointer-events-auto absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 20 * overlayScale, height: 8 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("s", event)} />
                                                        <span className="pointer-events-auto absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 8 * overlayScale, height: 20 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("w", event)} />
                                                        <span className="pointer-events-auto absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 8 * overlayScale, height: 20 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("e", event)} />
                                                        <span className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("nw", event)} />
                                                        <span className="pointer-events-auto absolute left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("ne", event)} />
                                                        <span className="pointer-events-auto absolute left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("sw", event)} />
                                                        <span className="pointer-events-auto absolute left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag("se", event)} />
                                                    </>
                                                )}
                                            </div>
                                        ) : null}
                                        <div
                                            ref={interactionRef}
                                            className={`absolute inset-0 z-10 touch-none ${locked ? "pointer-events-none" : ""}`}
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

                {completed ? (
                    <div className="flex min-h-[360px] flex-col gap-4">
                        <div>
                            <h2 className="text-xl font-semibold">{t("canvas.editors.cutoutDone")}</h2>
                            <div className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.cutoutDoneHint")}</div>
                        </div>
                        {completedFailed ? (
                            <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                                {t("canvas.editors.cutoutAiFallback")}
                            </div>
                        ) : null}
                        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-black/5 p-2 dark:border-white/10">
                            <img src={completed} alt="" className="max-h-[48vh] max-w-full object-contain" />
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2">
                            <Button icon={<ScrollText className="size-4" />} disabled={!logs.length} onClick={() => setLogsOpen(true)}>
                                {t("decompose.logs.button", { count: logs.length })}
                            </Button>
                            <Button type="primary" onClick={onClose}>
                                {t("canvas.editors.cutoutDoneAction")}
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-h-[360px] flex-col gap-4">
                        <div>
                            <h2 className="text-xl font-semibold">{t("canvas.editors.cutoutTitle")}</h2>
                            <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                            <div className="mt-2 text-xs leading-5 opacity-55">{t(mode === "rect" ? "canvas.editors.cutoutRectHint" : "canvas.editors.cutoutBrushHint")}</div>
                            {logs.length ? (
                                <Button type="link" size="small" className="!mt-1 !h-auto !px-0" icon={<ScrollText className="size-3.5" />} onClick={() => setLogsOpen(true)}>
                                    {t("decompose.logs.button", { count: logs.length })}
                                </Button>
                            ) : null}
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <Button type={mode === "rect" ? "primary" : "default"} icon={<SquareDashed className="size-4" />} onClick={() => { dragAbortRef.current?.abort(); rectStartRef.current = null; setCreating(false); setMode("rect"); setBrushPreview(null); setError(""); }} disabled={!image || locked}>
                                {t("canvas.editors.cutoutRect")}
                            </Button>
                            <Button type={mode === "brush" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => { dragAbortRef.current?.abort(); setCreating(false); setMode("brush"); setError(""); }} disabled={!image || locked}>
                                {t("canvas.editors.cutoutBrush")}
                            </Button>
                        </div>

                        {mode === "brush" ? (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-sm">
                                    <span className="font-medium opacity-75">{t("canvas.editors.brushSize")}</span>
                                    <span className="font-semibold">{brushSize}px</span>
                                </div>
                                <Slider min={8} max={maxBrushSize} step={2} value={brushSize} disabled={!image || locked} onChange={(value) => setBrushSize(clampBrushSize(value, image))} />
                            </div>
                        ) : null}

                        <div className="space-y-2">
                            <label className="flex items-start justify-between gap-3 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium">{t("canvas.editors.cutoutAiRepair")}</span>
                                    <span className="mt-0.5 block text-xs leading-5 opacity-55">{t("canvas.editors.cutoutAiRepairHint")}</span>
                                </span>
                                <Switch size="small" checked={aiRepair} onChange={setAiRepair} disabled={locked} />
                            </label>
                            {aiRepair ? (
                                <div className="space-y-2 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                                    <div className="text-sm font-medium">{t("canvas.editors.cutoutModel")}</div>
                                    <Select
                                        className="w-full"
                                        value={imageModelOptions.includes(imageModel) ? imageModel : undefined}
                                        options={imageModelOptions.map((model) => ({ value: model, label: modelOptionLabel(effectiveConfig, model) }))}
                                        placeholder={t("canvas.editors.cutoutModelPlaceholder")}
                                        disabled={locked}
                                        onChange={setSelectedImageModel}
                                    />
                                    {imageReady ? null : (
                                        <div className="flex items-center justify-between gap-2 text-xs text-amber-600 dark:text-amber-400">
                                            <span>{t("canvas.editors.cutoutModelNotReady")}</span>
                                            <Button type="link" size="small" className="!px-0" onClick={() => openConfigDialog(true)}>
                                                {t("decompose.openConfig")}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="rounded-lg border border-black/10 px-3 py-2 text-xs leading-5 opacity-55 dark:border-white/10">{t("canvas.editors.cutoutLocalHint")}</div>
                            )}
                            <label className="flex items-start justify-between gap-3 rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                                <span className="min-w-0">
                                    <span className="block text-sm font-medium">{t("canvas.editors.cutoutTransparent")}</span>
                                    <span className="mt-0.5 block text-xs leading-5 opacity-55">{t("canvas.editors.cutoutTransparentHint")}</span>
                                </span>
                                <Switch size="small" checked={transparentBackground} onChange={setTransparentBackground} disabled={locked} />
                            </label>
                        </div>

                        <div className="mt-auto space-y-3">
                            <div className="text-xs leading-5 opacity-55">{t("canvas.editors.cropHint")}</div>
                            {processing ? (
                                <div className="flex items-center gap-2 text-sm opacity-70">
                                    <LoaderCircle className="size-4 animate-spin" />
                                    {t("canvas.editors.cutoutProcessing")}
                                </div>
                            ) : null}
                            {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                            <div className="flex items-center justify-between gap-2">
                                <Button icon={<RotateCcw className="size-4" />} onClick={resetSelection} disabled={locked}>
                                    {t("canvas.editors.reset")}
                                </Button>
                                <div className="flex items-center gap-2">
                                    <Button onClick={onClose}>{t("canvas.editors.cancel")}</Button>
                                    <Button type="primary" icon={<Check className="size-4" />} loading={busy} disabled={!image || locked} onClick={() => void submit()}>
                                        {t("canvas.editors.cutoutConfirm")}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
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

            <CanvasDecomposeRequestLog
                open={logsOpen}
                logs={logs}
                fileBase={t("canvas.editors.cutoutTitle")}
                title={t("canvas.editors.cutoutLogTitle")}
                emptyText={t("canvas.editors.cutoutLogEmpty")}
                boxLabel={t("canvas.editors.cutoutLogSelection")}
                onClose={() => setLogsOpen(false)}
            />
        </Modal>
    );
}

function computeRectDrag(startRect: ImageCropRect, mode: RectDragMode, start: Point, current: Point, image: { width: number; height: number }): ImageCropRect {
    const dx = current.x - start.x;
    const dy = current.y - start.y;
    const minWidth = 8 / image.width;
    const minHeight = 8 / image.height;
    if (mode === "move") {
        return {
            x: clamp(startRect.x + dx, 0, 1 - startRect.width),
            y: clamp(startRect.y + dy, 0, 1 - startRect.height),
            width: startRect.width,
            height: startRect.height,
        };
    }
    let x = startRect.x;
    let y = startRect.y;
    let width = startRect.width;
    let height = startRect.height;
    if (mode === "nw" || mode === "w" || mode === "sw") {
        const right = startRect.x + startRect.width;
        x = clamp(startRect.x + dx, 0, Math.max(0, right - minWidth));
        width = right - x;
    } else if (mode === "ne" || mode === "e" || mode === "se") {
        width = clamp(startRect.width + dx, minWidth, 1 - startRect.x);
    }
    if (mode === "nw" || mode === "n" || mode === "ne") {
        const bottom = startRect.y + startRect.height;
        y = clamp(startRect.y + dy, 0, Math.max(0, bottom - minHeight));
        height = bottom - y;
    } else if (mode === "sw" || mode === "s" || mode === "se") {
        height = clamp(startRect.height + dy, minHeight, 1 - startRect.y);
    }
    return { x, y, width, height };
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
