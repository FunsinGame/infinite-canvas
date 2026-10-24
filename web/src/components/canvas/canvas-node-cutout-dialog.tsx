import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Modal, Select, Slider, Switch, Tooltip } from "antd";
import { ArrowLeft, Brush, Check, ChevronDown, Eraser, LoaderCircle, Move, RefreshCw, RotateCcw, ScrollText, SquareDashed, Trash2, ZoomIn, ZoomOut } from "lucide-react";
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
import { useCutoutSettingsStore, type CutoutBackground } from "@/stores/use-cutout-settings-store";
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
type CutoutPreview = { dataUrls: string[]; skipped: number; failed: boolean };

const cutoutBackgroundColors: Record<CutoutBackground, string> = {
    transparent: "",
    black: "#000000",
    white: "#ffffff",
    green: "#00b140",
};

const detailOptions = [768, 1024, 1536, 2048];

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
    const params = useCutoutSettingsStore((state) => state.params);
    const updateParams = useCutoutSettingsStore((state) => state.updateParams);
    const resetParams = useCutoutSettingsStore((state) => state.resetParams);
    const cutoutBackground = useCutoutSettingsStore((state) => state.background);
    const setCutoutBackground = useCutoutSettingsStore((state) => state.setBackground);
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
    const [preview, setPreview] = useState<CutoutPreview | null>(null);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [view, setView] = useState<"edit" | "result">("edit");
    const [showParams, setShowParams] = useState(true);
    const [error, setError] = useState("");
    const viewport = useImageEditorViewport(image, open, { maxZoom: 8 });
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
    // 选框层随图片一起布局缩放，边框和手柄使用固定屏幕像素，不会随 zoom 变粗。
    const locked = Boolean(phase);

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
        setPreview(null);
        setPreviewIndex(0);
        setView("edit");
        setShowParams(true);
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
        setPreview(null);
        setPreviewIndex(0);
        setView("edit");
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

    const showPreview = (dataUrls: string[], skipped: number, failed: boolean) => {
        setPreview({ dataUrls, skipped, failed });
        setPreviewIndex(0);
        setBrushPreview(null);
        setView("result");
    };

    const applyPreview = () => {
        if (!preview || phase) return;
        onConfirm({ dataUrls: preview.dataUrls });
        onClose();
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
            const mattes = await cutoutMattes(dataUrl, regions, params);
            if (closedRef.current) return;
            const available = mattes.filter((matte): matte is CutoutMatte => Boolean(matte));
            const skipped = mattes.length - available.length;
            if (!available.length) throw new Error(t("canvas.editors.cutoutEmpty"));
            if (!aiRepair) {
                showPreview(
                    available.map((matte) => matte.dataUrl),
                    skipped,
                    false,
                );
                return;
            }

            setPhase("repair");
            const abortController = new AbortController();
            controller = abortController;
            requestAbortRef.current = abortController;
            const prompt = t("canvas.projectPage.cutoutRepairPrompt");
            const requestConfig = { ...effectiveConfig, model: imageModel, count: "1", size: "auto", background: "transparent" };
            const results = await Promise.all(
                available.map(async (matte, matteIndex): Promise<CutoutResult | null> => {
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
                                elementName: `${t("canvas.editors.cutoutTitle")} #${matteIndex + 1}`,
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
            showPreview(
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
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={1060} centered destroyOnHidden transitionName="" maskTransitionName="" maskClosable={false} keyboard={false}>
            <div className="grid gap-5 lg:grid-cols-[minmax(400px,1fr)_320px]" data-canvas-no-zoom>
                {view === "result" && preview ? (
                    <CutoutResultView preview={preview} previewIndex={previewIndex} background={cutoutBackground} onSelect={setPreviewIndex} onBackgroundChange={setCutoutBackground} onBack={() => setView("edit")} />
                ) : (
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
                                                              borderWidth: 1,
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
                                                              style={{ bottom: "100%", fontSize: 10, lineHeight: "16px", padding: "2px 6px" }}
                                                          >
                                                              {`#${index + 1}`}
                                                              {active && rectSize ? ` · ${rectSize}` : ""}
                                                          </span>
                                                          {active && !locked ? (
                                                              <>
                                                                  <span
                                                                      className="pointer-events-auto absolute left-1/2 z-10 flex -translate-x-1/2 cursor-move items-center justify-center rounded-full border border-white bg-sky-500 text-white shadow"
                                                                      style={{ top: 10, width: 12, height: 12, borderWidth: 1 }}
                                                                      title={t("canvas.editors.cutoutMoveRect")}
                                                                      onPointerDown={(event) => startRectDrag(index, "move", event)}
                                                                  >
                                                                      <Move style={{ width: 8, height: 8 }} />
                                                                  </span>
                                                                  <span className="pointer-events-auto absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 14, height: 5, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "n", event)} />
                                                                  <span className="pointer-events-auto absolute left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" style={{ width: 14, height: 5, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "s", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 5, height: 14, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "w", event)} />
                                                                  <span className="pointer-events-auto absolute right-0 top-1/2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" style={{ width: 5, height: 14, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "e", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 8, height: 8, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "nw", event)} />
                                                                  <span className="pointer-events-auto absolute left-full top-0 -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 8, height: 8, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "ne", event)} />
                                                                  <span className="pointer-events-auto absolute left-0 top-full -translate-x-1/2 -translate-y-1/2 cursor-nesw-resize rounded-full border border-white bg-sky-500" style={{ width: 8, height: 8, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "sw", event)} />
                                                                  <span className="pointer-events-auto absolute left-full top-full -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-full border border-white bg-sky-500" style={{ width: 8, height: 8, borderWidth: 1 }} onPointerDown={(event) => startRectDrag(index, "se", event)} />
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
                                                    borderWidth: 1,
                                                    borderStyle: "dashed",
                                                    left: `${draftRect.x * 100}%`,
                                                    top: `${draftRect.y * 100}%`,
                                                    width: `${draftRect.width * 100}%`,
                                                    height: `${draftRect.height * 100}%`,
                                                }}
                                            >
                                                <span
                                                    className="pointer-events-none absolute left-0 max-w-full truncate bg-sky-500 text-white"
                                                    style={{ bottom: "100%", fontSize: 10, lineHeight: "16px", padding: "2px 6px" }}
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
                )}

                <div className="thin-scrollbar flex max-h-[min(68vh,720px)] min-h-[360px] flex-col gap-4 overflow-y-auto pr-1">
                        <div>
                            <h2 className="text-xl font-semibold">{t("canvas.editors.cutoutTitle")}</h2>
                            <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                            {logs.length ? (
                                <Button type="link" size="small" className="!mt-1 !h-auto !px-0" icon={<ScrollText className="size-3.5" />} onClick={() => setLogsOpen(true)}>
                                    {t("decompose.logs.button", { count: logs.length })}
                                </Button>
                            ) : null}
                            {preview && view === "edit" ? (
                                <Button type="link" size="small" className="!mt-1 !h-auto !px-0" icon={<ArrowLeft className="size-3.5 rotate-180" />} onClick={() => { setBrushPreview(null); setView("result"); }}>
                                    {t("canvas.editors.cutoutViewResult")}
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

                        <div className="rounded-lg border border-black/10 px-3 py-2.5 dark:border-white/10">
                            <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setShowParams((current) => !current)}>
                                <span className="text-sm font-medium">{t("canvas.editors.cutoutParams")}</span>
                                <ChevronDown className={`size-4 opacity-60 transition-transform ${showParams ? "rotate-180" : ""}`} />
                            </button>
                            {showParams ? (
                                <div className="mt-3 space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="text-[11px] leading-4 opacity-50">{t("canvas.editors.cutoutParamsHint")}</span>
                                        <Button type="link" size="small" className="!h-auto shrink-0 !px-0" disabled={locked} onClick={resetParams}>
                                            {t("canvas.editors.cutoutParamsReset")}
                                        </Button>
                                    </div>
                                    <ParamSlider label={t("canvas.editors.cutoutParamEdge")} value={params.edgeThreshold} min={10} max={100} step={1} disabled={locked} onChange={(value) => updateParams({ edgeThreshold: value })} />
                                    <ParamSlider label={t("canvas.editors.cutoutParamCentral")} value={Math.round(params.centralRatio * 100)} suffix="%" min={30} max={90} step={5} disabled={locked} onChange={(value) => updateParams({ centralRatio: value / 100 })} />
                                    <ParamSlider label={t("canvas.editors.cutoutParamFeather")} value={params.feather} suffix="px" min={0} max={12} step={1} disabled={locked} onChange={(value) => updateParams({ feather: value })} />
                                    <ParamSlider label={t("canvas.editors.cutoutParamShrink")} value={params.shrink} suffix="px" min={0} max={3} step={1} disabled={locked} onChange={(value) => updateParams({ shrink: value })} />
                                    <div className="space-y-1">
                                        <div className="flex items-center justify-between text-xs">
                                            <span className="font-medium opacity-75">{t("canvas.editors.cutoutParamQuality")}</span>
                                            <span className="font-semibold tabular-nums">{params.analysisLongEdge}</span>
                                        </div>
                                        <Select className="w-full" value={params.analysisLongEdge} options={detailOptions.map((value) => ({ value, label: String(value) }))} disabled={locked} onChange={(value: number) => updateParams({ analysisLongEdge: value })} />
                                        <div className="text-[11px] leading-4 opacity-45">{t("canvas.editors.cutoutParamQualityHint")}</div>
                                    </div>
                                </div>
                            ) : null}
                        </div>

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
                            {preview ? <div className="text-[11px] leading-4 opacity-50">{t("canvas.editors.cutoutPreviewHint")}</div> : null}
                            <div className="flex items-center justify-between gap-2">
                                <Button icon={<RotateCcw className="size-4" />} onClick={resetSelection} disabled={locked}>
                                    {t("canvas.editors.reset")}
                                </Button>
                            </div>
                            <div className={`grid gap-2 ${preview ? "grid-cols-2" : "grid-cols-1"}`}>
                                <Button type={preview ? "default" : "primary"} icon={<RefreshCw className="size-4" />} loading={Boolean(phase)} disabled={!image || locked} onClick={() => void submit()}>
                                    {preview ? t("canvas.editors.cutoutRetry") : t("canvas.editors.cutoutConfirm")}
                                </Button>
                                {preview ? (
                                    <Button type="primary" icon={<Check className="size-4" />} disabled={Boolean(phase)} onClick={applyPreview}>
                                        {t("canvas.editors.cutoutApply")}
                                    </Button>
                                ) : null}
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

function CutoutResultView({ preview, previewIndex, background, onSelect, onBackgroundChange, onBack }: { preview: CutoutPreview; previewIndex: number; background: CutoutBackground; onSelect: (index: number) => void; onBackgroundChange: (background: CutoutBackground) => void; onBack: () => void }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const selected = preview.dataUrls[previewIndex] || preview.dataUrls[0];
    const backgroundColor = cutoutBackgroundColors[background];
    const previewStyle = backgroundColor
        ? { backgroundColor }
        : { backgroundColor: theme.node.fill, backgroundImage: `repeating-conic-gradient(${theme.node.stroke} 0% 25%, transparent 0% 50%)`, backgroundSize: "16px 16px", backgroundPosition: "50%" };
    const thumbStyle = backgroundColor
        ? { backgroundColor }
        : { backgroundColor: theme.node.fill, backgroundImage: `repeating-conic-gradient(${theme.node.stroke} 0% 25%, transparent 0% 50%)`, backgroundSize: "8px 8px" };
    const backgroundOptions: Array<{ value: CutoutBackground; label: string }> = [
        { value: "transparent", label: t("canvas.editors.cutoutBackgroundTransparent") },
        { value: "black", label: t("canvas.editors.cutoutBackgroundBlack") },
        { value: "white", label: t("canvas.editors.cutoutBackgroundWhite") },
        { value: "green", label: t("canvas.editors.cutoutBackgroundGreen") },
    ];
    return (
        <div className="flex h-[min(68vh,720px)] min-h-[360px] flex-col gap-3 rounded-xl border border-black/10 p-3 dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-baseline gap-2">
                    <span className="text-sm font-medium">{t("canvas.editors.cutoutResultTitle")}</span>
                    <span className="text-xs opacity-55">{t("canvas.editors.cutoutResultCount", { count: preview.dataUrls.length })}</span>
                </div>
                <Button type="text" size="small" icon={<ArrowLeft className="size-3.5" />} onClick={onBack}>
                    {t("canvas.editors.cutoutBackToEdit")}
                </Button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] opacity-50">{t("canvas.editors.cutoutBackground")}</span>
                {backgroundOptions.map((option) => {
                    const active = background === option.value;
                    const swatch =
                        option.value === "transparent"
                            ? { backgroundImage: "repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%)", backgroundSize: "6px 6px" }
                            : { backgroundColor: cutoutBackgroundColors[option.value] };
                    return (
                        <button
                            key={option.value}
                            type="button"
                            onClick={() => onBackgroundChange(option.value)}
                            className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition ${active ? "border-sky-500 text-sky-600 dark:text-sky-400" : "border-black/10 opacity-70 hover:opacity-100 dark:border-white/10"}`}
                        >
                            <span className="size-3 shrink-0 rounded-sm border border-black/10 dark:border-white/20" style={swatch} />
                            {option.label}
                        </button>
                    );
                })}
            </div>
            {preview.failed ? (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">{t("canvas.editors.cutoutAiFallback")}</div>
            ) : null}
            {preview.skipped > 0 ? (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300">{t("canvas.editors.cutoutSkipped", { count: preview.skipped })}</div>
            ) : null}
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-black/10 dark:border-white/10" style={previewStyle}>
                {selected ? <img src={selected} alt="" className="max-h-full max-w-full object-contain" /> : null}
            </div>
            {preview.dataUrls.length > 1 ? (
                <div className="thin-scrollbar flex shrink-0 gap-2 overflow-x-auto">
                    {preview.dataUrls.map((dataUrl, index) => (
                        <button
                            key={index}
                            type="button"
                            onClick={() => onSelect(index)}
                            className={`relative flex size-16 shrink-0 items-center justify-center rounded-lg border p-0.5 ${index === previewIndex ? "border-sky-500" : "border-black/10 dark:border-white/10"}`}
                            style={thumbStyle}
                        >
                            <img src={dataUrl} alt="" className="max-h-full max-w-full object-contain" />
                            <span className="absolute left-0.5 top-0.5 rounded bg-sky-500 px-1 text-[9px] leading-4 text-white">#{index + 1}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function ParamSlider({ label, value, suffix = "", min, max, step, disabled, onChange }: { label: string; value: number; suffix?: string; min: number; max: number; step: number; disabled?: boolean; onChange: (value: number) => void }) {
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
                <span className="font-medium opacity-75">{label}</span>
                <span className="font-semibold tabular-nums">
                    {value}
                    {suffix}
                </span>
            </div>
            <Slider min={min} max={max} step={step} value={value} disabled={disabled} onChange={onChange} />
        </div>
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
