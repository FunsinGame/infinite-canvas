import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Modal, Select, Slider, Switch, Tooltip } from "antd";
import { Brush, Check, Eraser, LoaderCircle, Move, RotateCcw, ScrollText, SquareDashed, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { CanvasDecomposeRequestLog, type DecomposeRequestLog } from "@/components/canvas/canvas-decompose-request-log";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { canvasThemes } from "@/lib/canvas-theme";
import { buildCutoutRepairReferences, cutoutMattes, type CutoutMatte, type CutoutRegion } from "@/lib/canvas/canvas-cutout-matting";
import { trimTransparentDataUrl, type ImageCropRect } from "@/lib/canvas/canvas-image-data";
import { readImageMeta } from "@/lib/image-utils";
import { requestEdit } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionLabel, resolveModelForCapability, selectableModelsByCapability, useConfigStore, useEffectiveConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";

export type CanvasImageCutoutPayload = {
    dataUrls: string[];
};

type CutoutMode = "rect" | "brush";
type BrushTarget = "foreground" | "background";
type Point = { x: number; y: number };
type Stroke = { size: number; points: Point[] };
type BrushPreview = { x: number; y: number; size: number };
type RectDragMode = "move" | "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";
type CutoutResult = { dataUrl: string; failed: boolean };

const defaultBrushRatio = 0.08;
const foregroundMaskColor = "#2563eb";
const backgroundMaskColor = "#ef4444";

export function CanvasNodeCutoutDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageCutoutPayload) => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const imageModelOptions = selectableModelsByCapability(effectiveConfig, "image");
    const preferredImageModel = resolveModelForCapability(effectiveConfig, undefined, "image");
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const backgroundMaskCanvasRef = useRef<HTMLCanvasElement>(null);
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    const interactionRef = useRef<HTMLDivElement>(null);
    const drawingRef = useRef<Stroke | null>(null);
    const rectStartRef = useRef<Point | null>(null);
    const draftRectRef = useRef<ImageCropRect | null>(null);
    const dragAbortRef = useRef<AbortController | null>(null);
    const requestAbortRef = useRef<AbortController | null>(null);
    const closedRef = useRef(false);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [mode, setMode] = useState<CutoutMode>("rect");
    const [brushTarget, setBrushTarget] = useState<BrushTarget>("foreground");
    const [rects, setRects] = useState<ImageCropRect[]>([]);
    const [activeRectIndex, setActiveRectIndex] = useState<number | null>(null);
    const [draftRect, setDraftRect] = useState<ImageCropRect | null>(null);
    const [hasForegroundBrush, setHasForegroundBrush] = useState(false);
    const [hasBackgroundBrush, setHasBackgroundBrush] = useState(false);
    const [brushSize, setBrushSize] = useState(80);
    const [aiRepair, setAiRepair] = useState(false);
    const [brushPreview, setBrushPreview] = useState<BrushPreview | null>(null);
    const [selectedImageModel, setSelectedImageModel] = useState("");
    const [logs, setLogs] = useState<DecomposeRequestLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [phase, setPhase] = useState<"matting" | "repair" | null>(null);
    const [completed, setCompleted] = useState<string[] | null>(null);
    const [completedFailed, setCompletedFailed] = useState(false);
    const [completedSkipped, setCompletedSkipped] = useState(0);
    const [error, setError] = useState("");
    const viewport = useImageEditorViewport(image, open);
    const maxBrushSize = image ? Math.max(40, Math.round(Math.min(image.width, image.height) * 0.5)) : 200;
    const activeRect = activeRectIndex != null ? rects[activeRectIndex] || null : null;
    const rectSize = image && activeRect ? `${Math.max(1, Math.round(activeRect.width * image.width))} × ${Math.max(1, Math.round(activeRect.height * image.height))}` : "";
    const imageModel =
        (selectedImageModel && imageModelOptions.includes(selectedImageModel) ? selectedImageModel : "") ||
        (imageModelOptions.includes(preferredImageModel) && isAiConfigReady(effectiveConfig, preferredImageModel) ? preferredImageModel : "") ||
        imageModelOptions.find((model) => isAiConfigReady(effectiveConfig, model)) ||
        (imageModelOptions.includes(preferredImageModel) ? preferredImageModel : imageModelOptions[0]) ||
        "";
    const imageReady = Boolean(imageModel) && isAiConfigReady(effectiveConfig, imageModel);
    // The selection lives in the zoomed media layer, so counter-scale its chrome to keep a constant screen size.
    const overlayScale = 1 / viewport.zoom;
    const locked = Boolean(phase) || Boolean(completed);

    useEffect(() => {
        if (!open) return;
        setImage(null);
        setMode("rect");
        setBrushTarget("foreground");
        setRects([]);
        setActiveRectIndex(null);
        setDraftRect(null);
        setHasForegroundBrush(false);
        setHasBackgroundBrush(false);
        setAiRepair(false);
        setSelectedImageModel("");
        setLogs([]);
        setLogsOpen(false);
        setPhase(null);
        setCompleted(null);
        setCompletedFailed(false);
        setCompletedSkipped(0);
        setBrushPreview(null);
        setError("");
        drawingRef.current = null;
        rectStartRef.current = null;
        draftRectRef.current = null;
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
        clearCanvas(backgroundMaskCanvasRef.current);
        clearCanvas(overlayCanvasRef.current);
        drawingRef.current = null;
        setHasForegroundBrush(false);
        setHasBackgroundBrush(false);
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

    const startRectDrag = (index: number, dragMode: RectDragMode, event: ReactPointerEvent) => {
        const current = rects[index];
        if (!current || !image || event.button !== 0 || viewport.spacePressed) return;
        setActiveRectIndex(index);
        event.preventDefault();
        event.stopPropagation();
        dragAbortRef.current?.abort();
        const controller = new AbortController();
        dragAbortRef.current = controller;
        const start = readClientPoint(event.clientX, event.clientY);
        const startRect = { ...current };
        const pointerId = event.pointerId;
        const move = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            const next = computeRectDrag(startRect, dragMode, start, readClientPoint(moveEvent.clientX, moveEvent.clientY), image);
            setRects((prev) => prev.map((item, itemIndex) => (itemIndex === index ? next : item)));
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

    const drawStroke = (from: Point, to: Point, size: number, target: BrushTarget) => {
        for (const [canvas, color] of [
            [target === "foreground" ? maskCanvasRef.current : backgroundMaskCanvasRef.current, "#000000"],
            [overlayCanvasRef.current, target === "foreground" ? foregroundMaskColor : backgroundMaskColor],
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
            const draft = { x: point.x, y: point.y, width: 0, height: 0 };
            draftRectRef.current = draft;
            setDraftRect(draft);
            setActiveRectIndex(null);
            setError("");
            return;
        }
        const imagePoint = toImagePoint(point, image);
        const stroke: Stroke = { size: brushSize, points: [imagePoint] };
        drawingRef.current = stroke;
        drawStroke(imagePoint, imagePoint, stroke.size, brushTarget);
        if (brushTarget === "foreground") setHasForegroundBrush(true);
        else setHasBackgroundBrush(true);
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
            drawStroke(previous, imagePoint, stroke.size, brushTarget);
            stroke.points.push(imagePoint);
            return;
        }
        const start = rectStartRef.current;
        if (!start) return;
        event.preventDefault();
        const current = readClientPoint(event.clientX, event.clientY);
        const next = {
            x: Math.min(start.x, current.x),
            y: Math.min(start.y, current.y),
            width: Math.abs(current.x - start.x),
            height: Math.abs(current.y - start.y),
        };
        draftRectRef.current = next;
        setDraftRect(next);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (mode === "brush") {
            drawingRef.current = null;
            return;
        }
        rectStartRef.current = null;
        const draft = draftRectRef.current;
        draftRectRef.current = null;
        setDraftRect(null);
        if (!draft || !image || draft.width * image.width < 8 || draft.height * image.height < 8) return;
        const index = rects.length;
        setRects([...rects, draft]);
        setActiveRectIndex(index);
    };

    const resetSelection = () => {
        rectStartRef.current = null;
        drawingRef.current = null;
        draftRectRef.current = null;
        dragAbortRef.current?.abort();
        setRects([]);
        setActiveRectIndex(null);
        setDraftRect(null);
        setHasForegroundBrush(false);
        setHasBackgroundBrush(false);
        setError("");
        clearCanvas(maskCanvasRef.current);
        clearCanvas(backgroundMaskCanvasRef.current);
        clearCanvas(overlayCanvasRef.current);
    };

    const deleteActiveRect = () => {
        if (activeRectIndex == null) return;
        setRects((current) => current.filter((_, index) => index !== activeRectIndex));
        setActiveRectIndex(null);
    };

    const finish = (dataUrls: string[], skipped: number, failed: boolean) => {
        onConfirm({ dataUrls });
        setCompleted(dataUrls);
        setCompletedSkipped(skipped);
        setCompletedFailed(failed);
    };

    const submit = async () => {
        if (!image || locked) return;
        if (mode === "rect" && !rects.length) {
            setError(t("canvas.editors.cutoutRectRequired"));
            return;
        }
        if (mode === "brush" && !hasForegroundBrush) {
            setError(t("canvas.editors.cutoutBrushRequired"));
            return;
        }
        if (aiRepair && !imageReady) {
            setError(t("canvas.editors.cutoutModelRequired"));
            return;
        }
        const regions: CutoutRegion[] =
            mode === "rect"
                ? rects.map((rect) => ({ rect }))
                : [
                      {
                          fgMaskDataUrl: maskCanvasRef.current?.toDataURL("image/png"),
                          bgMaskDataUrl: hasBackgroundBrush ? backgroundMaskCanvasRef.current?.toDataURL("image/png") : undefined,
                      },
                  ];
        setPhase("matting");
        setError("");
        // 先让进度状态渲染出来，再开始同步的本地抠图计算。
        await new Promise((resolve) => setTimeout(resolve, 0));
        let controller: AbortController | null = null;
        try {
            const mattes = await cutoutMattes(dataUrl, regions);
            if (closedRef.current) return;
            const available = mattes.filter((matte): matte is CutoutMatte => Boolean(matte));
            const skipped = mattes.length - available.length;
            if (!available.length) throw new Error(t("canvas.editors.cutoutEmpty"));
            if (!aiRepair) {
                finish(available.map((matte) => matte.dataUrl), skipped, false);
                if (!skipped) onClose();
                return;
            }

            setPhase("repair");
            const abortController = new AbortController();
            controller = abortController;
            requestAbortRef.current = abortController;
            const prompt = t("canvas.projectPage.cutoutRepairPrompt");
            const requestConfig = { ...effectiveConfig, model: imageModel, count: "1", size: "auto", background: "transparent" };
            const results = await Promise.all(
                available.map(async (matte): Promise<CutoutResult | null> => {
                    const startedAt = Date.now();
                    let logId: string | null = null;
                    try {
                        const aiReferences = await buildCutoutRepairReferences(dataUrl, matte);
                        if (abortController.signal.aborted || closedRef.current) return null;
                        const newLogId = nanoid();
                        logId = newLogId;
                        setLogs((current) => [
                            ...current,
                            {
                                id: newLogId,
                                elementId: newLogId,
                                elementName: t("canvas.editors.cutoutTitle"),
                                box: { x: 0, y: 0, width: matte.box.width, height: matte.box.height },
                                model: modelOptionLabel(effectiveConfig, imageModel),
                                size: "auto",
                                quality: requestConfig.quality || "",
                                background: "transparent",
                                count: 1,
                                prompt,
                                systemPrompt: requestConfig.systemPrompt || "",
                                input: aiReferences.references[0].dataUrl,
                                inputs: aiReferences.references.map((item) => item.dataUrl),
                                status: "loading",
                                createdAt: startedAt,
                            },
                        ]);
                        const result = await requestEdit(requestConfig, prompt, aiReferences.references, { signal: abortController.signal }).then((items) => items[0]);
                        if (abortController.signal.aborted) return null;
                        const rawOutput = await imageToDataUrl({ dataUrl: result.dataUrl }, { signal: abortController.signal });
                        setLogs((current) => current.map((item) => (item.id === logId ? { ...item, status: "success", output: rawOutput, durationMs: Date.now() - startedAt } : item)));
                        const trimmedDataUrl = await trimTransparentDataUrl(rawOutput);
                        if (!trimmedDataUrl) throw new Error(t("canvas.editors.cutoutEmpty"));
                        return { dataUrl: trimmedDataUrl, failed: false };
                    } catch (requestError) {
                        if (abortController.signal.aborted || closedRef.current) return null;
                        const errorMessage = requestError instanceof Error ? requestError.message : t("canvas.editors.cutoutAiFailed");
                        if (logId) setLogs((current) => current.map((item) => (item.id === logId ? { ...item, status: "error", error: errorMessage, durationMs: Date.now() - startedAt } : item)));
                        return { dataUrl: matte.dataUrl, failed: true };
                    }
                }),
            );
            if (abortController.signal.aborted || closedRef.current) return;
            const finalResults = results.filter((item): item is CutoutResult => Boolean(item));
            if (!finalResults.length) throw new Error(t("canvas.editors.cutoutEmpty"));
            finish(
                finalResults.map((item) => item.dataUrl),
                skipped,
                finalResults.some((item) => item.failed),
            );
        } catch (submitError) {
            if (closedRef.current) return;
            setError(submitError instanceof Error ? submitError.message : t("canvas.editors.cutoutEmpty"));
        } finally {
            if (controller && requestAbortRef.current === controller) requestAbortRef.current = null;
            setPhase(null);
        }
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1060} centered destroyOnHidden transitionName="" maskTransitionName="" maskClosable={!phase} keyboard={!phase}>
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
                                        <canvas ref={backgroundMaskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                        <canvas
                                            ref={overlayCanvasRef}
                                            width={image.width}
                                            height={image.height}
                                            className="pointer-events-none absolute inset-0 size-full"
                                            style={{ opacity: mode === "brush" ? 0.42 : 0, transition: "opacity 120ms" }}
                                        />
                                        {mode === "rect"
                                            ? rects.map((item, index) => {
                                                  const active = index === activeRectIndex;
                                                  return (
                                                      <div
                                                          key={index}
                                                          className={`absolute z-20 touch-none border-sky-400 bg-sky-400/10 ${locked ? "pointer-events-none" : "cursor-move"}`}
                                                          style={{
                                                              borderWidth: 2 / viewport.zoom,
                                                              borderStyle: active ? "solid" : "dashed",
                                                              left: `${item.x * 100}%`,
                                                              top: `${item.y * 100}%`,
                                                              width: `${item.width * 100}%`,
                                                              height: `${item.height * 100}%`,
                                                              opacity: active ? 1 : 0.7,
                                                          }}
                                                          onPointerDown={(event) => startRectDrag(index, "move", event)}
                                                      >
                                                          <span
                                                              className="pointer-events-none absolute left-0 max-w-full truncate bg-sky-500 text-white"
                                                              style={{ bottom: "100%", fontSize: 10 * overlayScale, lineHeight: `${16 * overlayScale}px`, padding: `${2 * overlayScale}px ${6 * overlayScale}px` }}
                                                          >
                                                              {`#${index + 1}`}
                                                              {active && rectSize ? ` · ${rectSize}` : ""}
                                                          </span>
                                                          {active && !locked ? (
                                                              <>
                                                                  <span
                                                                      className="pointer-events-auto absolute left-1/2 z-10 flex -translate-x-1/2 cursor-move items-center justify-center rounded-full border border-white bg-sky-500 text-white shadow"
                                                                      style={{ top: 14 * overlayScale, width: 16 * overlayScale, height: 16 * overlayScale, borderWidth: overlayScale }}
                                                                      title={t("canvas.editors.cutoutMoveRect")}
                                                                      onPointerDown={(event) => startRectDrag(index, "move", event)}
                                                                  >
                                                                      <Move style={{ width: 10 * overlayScale, height: 10 * overlayScale }} />
                                                                  </span>
                                                                  <span className="pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 20 * overlayScale, height: 8 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "n", event)} />
                                                                  <span className="pointer-events-auto absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 20 * overlayScale, height: 8 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "s", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 8 * overlayScale, height: 20 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "w", event)} />
                                                                  <span className="pointer-events-auto absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 8 * overlayScale, height: 20 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "e", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "nw", event)} />
                                                                  <span className="pointer-events-auto absolute left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "ne", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "sw", event)} />
                                                                  <span className="pointer-events-auto absolute left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 10 * overlayScale, height: 10 * overlayScale, borderWidth: overlayScale }} onPointerDown={(event) => startRectDrag(index, "se", event)} />
                                                              </>
                                                          ) : null}
                                                      </div>
                                                  );
                                              })
                                            : null}
                                        {draftRect ? (
                                            <div
                                                className="pointer-events-none absolute z-20 border-sky-400 bg-sky-400/10"
                                                style={{
                                                    borderWidth: 2 / viewport.zoom,
                                                    borderStyle: "dashed",
                                                    left: `${draftRect.x * 100}%`,
                                                    top: `${draftRect.y * 100}%`,
                                                    width: `${draftRect.width * 100}%`,
                                                    height: `${draftRect.height * 100}%`,
                                                }}
                                            >
                                                <span
                                                    className="pointer-events-none absolute left-0 max-w-full truncate bg-sky-500 text-white"
                                                    style={{ bottom: "100%", fontSize: 10 * overlayScale, lineHeight: `${16 * overlayScale}px`, padding: `${2 * overlayScale}px ${6 * overlayScale}px` }}
                                                >
                                                    {`#${rects.length + 1}`}
                                                </span>
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
                        {completedSkipped > 0 ? (
                            <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">
                                {t("canvas.editors.cutoutSkipped", { count: completedSkipped })}
                            </div>
                        ) : null}
                        {completed.length === 1 ? (
                            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-black/10 bg-black/5 p-2 dark:border-white/10">
                                <img src={completed[0]} alt="" className="max-h-[48vh] max-w-full object-contain" />
                            </div>
                        ) : (
                            <div className="thin-scrollbar grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto rounded-lg border border-black/10 bg-black/5 p-2 dark:border-white/10">
                                {completed.map((dataUrl, index) => (
                                    <div key={index} className="relative flex min-h-24 items-center justify-center rounded-lg border border-black/10 p-1.5 dark:border-white/10">
                                        <img src={dataUrl} alt="" className="max-h-[22vh] max-w-full object-contain" />
                                        <span className="absolute left-1.5 top-1.5 rounded bg-sky-500 px-1.5 text-[10px] leading-4 text-white">#{index + 1}</span>
                                    </div>
                                ))}
                            </div>
                        )}
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
                            <Button type={mode === "rect" ? "primary" : "default"} icon={<SquareDashed className="size-4" />} onClick={() => { dragAbortRef.current?.abort(); rectStartRef.current = null; draftRectRef.current = null; setDraftRect(null); setMode("rect"); setBrushPreview(null); setError(""); }} disabled={!image || locked}>
                                {t("canvas.editors.cutoutRect")}
                            </Button>
                            <Button type={mode === "brush" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => { dragAbortRef.current?.abort(); draftRectRef.current = null; setDraftRect(null); setMode("brush"); setError(""); }} disabled={!image || locked}>
                                {t("canvas.editors.cutoutBrush")}
                            </Button>
                        </div>

                        {mode === "rect" ? (
                            <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="opacity-55">{t("canvas.editors.cutoutRectCount", { count: rects.length })}</span>
                                <Button type="text" size="small" className="!h-7 !px-2" icon={<Trash2 className="size-3.5" />} disabled={activeRectIndex == null || locked} onClick={deleteActiveRect}>
                                    {t("canvas.editors.cutoutDeleteRect")}
                                </Button>
                            </div>
                        ) : null}

                        {mode === "brush" ? (
                            <div className="space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                    <Button type={brushTarget === "foreground" ? "primary" : "default"} icon={<Brush className="size-4" />} onClick={() => setBrushTarget("foreground")} disabled={!image || locked}>
                                        {t("canvas.editors.cutoutBrushForeground")}
                                    </Button>
                                    <Button type={brushTarget === "background" ? "primary" : "default"} icon={<Eraser className="size-4" />} onClick={() => setBrushTarget("background")} disabled={!image || locked}>
                                        {t("canvas.editors.cutoutBrushBackground")}
                                    </Button>
                                </div>
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
                        </div>

                        <div className="mt-auto space-y-3">
                            <div className="text-xs leading-5 opacity-55">{t("canvas.editors.cropHint")}</div>
                            {phase ? (
                                <div className="flex items-center gap-2 text-sm opacity-70">
                                    <LoaderCircle className="size-4 animate-spin" />
                                    {t(phase === "repair" ? "canvas.editors.cutoutRepairing" : "canvas.editors.cutoutMatting")}
                                </div>
                            ) : null}
                            {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                            <div className="flex items-center justify-between gap-2">
                                <Button icon={<RotateCcw className="size-4" />} onClick={resetSelection} disabled={locked}>
                                    {t("canvas.editors.reset")}
                                </Button>
                                <div className="flex items-center gap-2">
                                    <Button onClick={onClose}>{t("canvas.editors.cancel")}</Button>
                                    <Button type="primary" icon={<Check className="size-4" />} loading={Boolean(phase)} disabled={!image || locked} onClick={() => void submit()}>
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
