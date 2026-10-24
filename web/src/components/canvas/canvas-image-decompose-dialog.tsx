import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Progress, Select, Space, Spin, Steps, Tag, Typography } from "antd";
import { Download, Eraser, FileJson, Layers, LoaderCircle, RotateCcw, ScrollText, Sparkles, Trash2, Type } from "lucide-react";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { CanvasDecomposeBoxEditor } from "@/components/canvas/canvas-decompose-box-editor";
import { CanvasDecomposeLayerTree } from "@/components/canvas/canvas-decompose-layer-tree";
import { CanvasDecomposeRequestLog, type DecomposeRequestLog } from "@/components/canvas/canvas-decompose-request-log";
import { CanvasDecomposeRestorePreview } from "@/components/canvas/canvas-decompose-restore-preview";
import {
    assignElementParents,
    buildDecomposeExport,
    canvasToBlob,
    createElementPreviewDataUrl,
    cropBox,
    downloadJson,
    downloadLayerZip,
    drawToSize,
    fitAiSize,
    fitWorkingSize,
    getDescendantElements,
    getElementExtractionOrder,
    getElementRequestSize,
    isElementDescendant,
    loadImage,
    sanitizeFileName,
    trimTransparent,
    type DecomposeCache,
    type DecomposeElement,
    type DecomposeElementType,
    type DecomposeExportPayload,
    type DecomposeResolution,
    type ElementBox,
    type ExtractedLayer,
    type LayerExportEntry,
} from "@/lib/canvas/canvas-decompose";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { analyzeImageElements } from "@/services/api/decompose-plan";
import { requestEdit } from "@/services/api/image";
import { getImageBlob, imageToDataUrl, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { modelOptionLabel, resolveModelForCapability, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { CanvasNodeData } from "@/types/canvas";

const TEXT_MODEL_STORAGE_KEY = "infinite-canvas:decompose-text-model";
const IMAGE_MODEL_STORAGE_KEY = "infinite-canvas:decompose-image-model";

type Offset = { dx: number; dy: number };

type DecomposeDialogProps = {
    node: CanvasNodeData | null;
    open: boolean;
    config: AiConfig;
    onClose: () => void;
    onOpenConfig: () => void;
    onExported?: (payload: DecomposeExportPayload) => Promise<boolean | void> | boolean | void;
};

function readStoredValue(key: string) {
    try {
        return window.localStorage.getItem(key) || "";
    } catch {
        return "";
    }
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

export function CanvasImageDecomposeDialog({ node, open, config, onClose, onOpenConfig, onExported }: DecomposeDialogProps) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const configRef = useRef(config);
    const abortRef = useRef<AbortController | null>(null);
    const workingUrlRef = useRef("");
    const elementListRef = useRef<HTMLDivElement>(null);

    const [step, setStep] = useState(0);
    const [preparing, setPreparing] = useState(false);
    const [prepareError, setPrepareError] = useState<string | null>(null);
    const [workingCanvas, setWorkingCanvas] = useState<HTMLCanvasElement | null>(null);
    const [workingUrl, setWorkingUrl] = useState("");
    const [workingSize, setWorkingSize] = useState({ width: 0, height: 0 });
    const [elements, setElements] = useState<DecomposeElement[]>([]);
    const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
    const [selectedTextModel, setSelectedTextModel] = useState(() => readStoredValue(TEXT_MODEL_STORAGE_KEY));
    const [selectedImageModel, setSelectedImageModel] = useState(() => readStoredValue(IMAGE_MODEL_STORAGE_KEY));
    const [analyzing, setAnalyzing] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const [extractProgress, setExtractProgress] = useState<{ current: number; total: number; name: string } | null>(null);
    const [previews, setPreviews] = useState<Record<string, string>>({});
    const [layers, setLayers] = useState<Record<string, ExtractedLayer>>({});
    const [offsets, setOffsets] = useState<Record<string, Offset>>({});
    const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [requestLogs, setRequestLogs] = useState<DecomposeRequestLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [exporting, setExporting] = useState(false);

    useEffect(() => {
        configRef.current = config;
    }, [config]);

    useEffect(() => {
        try {
            if (selectedTextModel) window.localStorage.setItem(TEXT_MODEL_STORAGE_KEY, selectedTextModel);
        } catch {
            // Ignore storage failures; the selection still works for this session.
        }
    }, [selectedTextModel]);

    useEffect(() => {
        try {
            if (selectedImageModel) window.localStorage.setItem(IMAGE_MODEL_STORAGE_KEY, selectedImageModel);
        } catch {
            // Ignore storage failures; the selection still works for this session.
        }
    }, [selectedImageModel]);

    useEffect(() => {
        abortRef.current?.abort();
        if (!open || !node?.metadata?.content) return;

        let cancelled = false;
        setStep(0);
        setPreparing(true);
        setPrepareError(null);
        setWorkingCanvas(null);
        setWorkingUrl("");
        setWorkingSize({ width: 0, height: 0 });
        setElements([]);
        setSelectedElementId(null);
        setPreviews({});
        setLayers({});
        setOffsets({});
        setSelectedLayerId(null);
        setError(null);
        setRequestLogs([]);
        setLogsOpen(false);
        setAnalyzing(false);
        setExtracting(false);
        setExtractProgress(null);
        setExporting(false);

        const cache = node.metadata.decompose;
        const contentUrl = node.metadata.content;
        void (async () => {
            try {
                const image = await loadImage(contentUrl);
                const naturalWidth = node.metadata?.naturalWidth || image.naturalWidth || node.width;
                const naturalHeight = node.metadata?.naturalHeight || image.naturalHeight || node.height;
                const size = cache?.width && cache.height ? { width: cache.width, height: cache.height } : fitWorkingSize(naturalWidth, naturalHeight);
                const canvas = drawToSize(image, size.width, size.height);
                const blob = await canvasToBlob(canvas);
                const url = URL.createObjectURL(blob);
                if (cancelled) {
                    URL.revokeObjectURL(url);
                    return;
                }
                workingUrlRef.current = url;
                setWorkingCanvas(canvas);
                setWorkingUrl(url);
                setWorkingSize(size);
                if (cache?.elements?.length) {
                    const cachedLayers = await hydrateCachedLayers(cache);
                    if (cancelled) return;
                    setElements(cache.elements.map((element) => ({ ...element, box: { ...element.box } })));
                    setOffsets({ ...(cache.offsets || {}) });
                    setLayers(cachedLayers);
                    if (cache.textModel) setSelectedTextModel(cache.textModel);
                    if (cache.imageModel) setSelectedImageModel(cache.imageModel);
                    setStep(2);
                }
                setPreparing(false);
            } catch (loadError) {
                if (cancelled) return;
                setPrepareError(loadError instanceof Error ? loadError.message : t("decompose.prepareFailed"));
                setPreparing(false);
            }
        })();

        return () => {
            cancelled = true;
            if (workingUrlRef.current) {
                URL.revokeObjectURL(workingUrlRef.current);
                workingUrlRef.current = "";
            }
        };
    }, [node?.id, node?.metadata?.content, open]);

    const textModelOptions = selectableModelsByCapability(config, "text");
    const preferredTextModel = resolveModelForCapability(config, undefined, "text");
    const textModel = (selectedTextModel && textModelOptions.includes(selectedTextModel) ? selectedTextModel : "") || textModelOptions.find((model) => isAiConfigReady(config, model)) || preferredTextModel;
    const textReady = isAiConfigReady(config, textModel);

    const imageModelOptions = selectableModelsByCapability(config, "image");
    const preferredImageModel = config.model || resolveModelForCapability(config, undefined, "image");
    const imageModel =
        (selectedImageModel && imageModelOptions.includes(selectedImageModel) ? selectedImageModel : "") ||
        (imageModelOptions.includes(preferredImageModel) && isAiConfigReady(config, preferredImageModel) ? preferredImageModel : "") ||
        imageModelOptions.find((model) => isAiConfigReady(config, model)) ||
        preferredImageModel;
    const imageReady = isAiConfigReady(config, imageModel);

    const imageModelRequired = useMemo(() => elements.some((element) => element.type === "image"), [elements]);
    const selectedElement = elements.find((element) => element.id === selectedElementId) || null;

    useEffect(() => {
        if (!selectedElementId) return;
        const row = elementListRef.current?.querySelector<HTMLElement>(`[data-element-id="${selectedElementId}"]`);
        row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [selectedElementId]);

    useEffect(() => {
        if (step === 0 || !workingCanvas || !elements.length) return;
        const next: Record<string, string> = {};
        for (const element of elements) {
            next[element.id] = createElementPreviewDataUrl(workingCanvas, element, getDescendantElements(elements, element.id));
        }
        setPreviews(next);
    }, [elements, step, workingCanvas]);

    const close = () => {
        abortRef.current?.abort();
        setLogsOpen(false);
        setRequestLogs([]);
        onClose();
    };

    const runAnalyze = async () => {
        if (!workingCanvas || !workingSize.width) return;
        if (!textReady) {
            setError(t("decompose.noTextModel"));
            return;
        }
        setAnalyzing(true);
        setError(null);
        const controller = new AbortController();
        abortRef.current = controller;
        try {
            const scale = Math.min(1, 1280 / Math.max(workingSize.width, workingSize.height));
            const analysisCanvas = drawToSize(workingCanvas, Math.max(1, Math.round(workingSize.width * scale)), Math.max(1, Math.round(workingSize.height * scale)));
            const dataUrl = analysisCanvas.toDataURL("image/png");
            const plans = await analyzeImageElements({ ...configRef.current, model: textModel }, dataUrl, controller.signal);
            if (controller.signal.aborted) return;

            const nextElements = plans
                .map((plan, index): DecomposeElement | null => {
                    const x1 = clamp((plan.box.x1 / 1000) * workingSize.width, 0, workingSize.width);
                    const y1 = clamp((plan.box.y1 / 1000) * workingSize.height, 0, workingSize.height);
                    const x2 = clamp((plan.box.x2 / 1000) * workingSize.width, 0, workingSize.width);
                    const y2 = clamp((plan.box.y2 / 1000) * workingSize.height, 0, workingSize.height);
                    if (x2 - x1 < 8 || y2 - y1 < 8) return null;
                    return {
                        id: nanoid(),
                        name: plan.name || `Element ${index + 1}`,
                        description: plan.description,
                        type: plan.type,
                        resolution: "1k",
                        box: { x: Math.round(x1), y: Math.round(y1), width: Math.round(x2 - x1), height: Math.round(y2 - y1) },
                        parentId: null,
                    };
                })
                .filter((element): element is DecomposeElement => Boolean(element));

            if (!nextElements.length) throw new Error(t("decompose.emptyElements"));
            const withParents = assignElementParents(nextElements);
            setElements(withParents);
            setSelectedElementId(withParents[0]?.id || null);
            setPreviews({});
            setLayers({});
            setOffsets({});
            setSelectedLayerId(null);
            setStep(0);
        } catch (analyzeError) {
            if (controller.signal.aborted) return;
            setError(analyzeError instanceof Error ? analyzeError.message : t("decompose.analyzeFailed"));
        } finally {
            setAnalyzing(false);
        }
    };

    const analyze = () => {
        if (!elements.length) {
            void runAnalyze();
            return;
        }
        modal.confirm({
            title: t("decompose.reanalyzeTitle"),
            content: t("decompose.reanalyzeConfirm"),
            okText: t("decompose.reanalyze"),
            cancelText: t("common.cancel"),
            onOk: () => void runAnalyze(),
        });
    };

    const updateBox = (id: string, box: ElementBox) => {
        setElements((current) => current.map((element) => (element.id === id ? { ...element, box } : element)));
    };

    const selectElement = (id: string | null) => {
        setSelectedElementId(id);
        if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    };

    const createElementAtBox = (box: ElementBox) => {
        if (!workingSize.width || !workingSize.height || box.width < 8 || box.height < 8) return;
        const next: DecomposeElement = {
            id: nanoid(),
            name: t("decompose.newElementName", { index: elements.length + 1 }),
            description: "",
            type: "image",
            resolution: "1k",
            box,
            parentId: null,
        };
        const withParents = assignElementParents([...elements, next]);
        setElements(withParents);
        selectElement(next.id);
    };

    const renameElement = (id: string, name: string) => {
        setElements((current) => current.map((element) => (element.id === id ? { ...element, name } : element)));
    };

    const deleteElement = (id: string) => {
        const target = elements.find((element) => element.id === id);
        if (!target) return;
        setElements((current) => current.filter((element) => element.id !== id).map((element) => (element.parentId === id ? { ...element, parentId: target.parentId } : element)));
        if (selectedElementId === id) setSelectedElementId(null);
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Delete" && event.key !== "Backspace") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[role='combobox'],[role='listbox']")) return;
            if (step !== 0 || !selectedElementId) return;
            event.preventDefault();
            event.stopPropagation();
            deleteElement(selectedElementId);
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [deleteElement, open, selectedElementId, step]);

    const changeElementType = (id: string, type: DecomposeElementType) => {
        setElements((current) => current.map((element) => (element.id === id ? { ...element, type } : element)));
    };

    const changeElementResolution = (id: string, resolution: DecomposeResolution) => {
        setElements((current) => current.map((element) => (element.id === id ? { ...element, resolution } : element)));
    };

    const reparentElement = (id: string, parentId: string | null) => {
        if (parentId && (parentId === id || isElementDescendant(elements, id, parentId))) return;
        setElements((current) => current.map((element) => (element.id === id ? { ...element, parentId } : element)));
    };

    const goToHierarchy = () => {
        if (!elements.length) return;
        setError(null);
        setLayers({});
        setOffsets({});
        setSelectedLayerId(null);
        setStep(1);
    };

    const startExtract = async () => {
        if (!workingCanvas || !node || !elements.length) return;
        if (imageModelRequired && !imageReady) {
            setError(t("decompose.imageModelRequired"));
            return;
        }

        setError(null);
        setExtracting(true);
        setExtractProgress(null);
        setRequestLogs([]);
        setLogsOpen(false);
        setLayers({});
        setOffsets({});
        setSelectedLayerId(null);
        const controller = new AbortController();
        abortRef.current = controller;

        const order = getElementExtractionOrder(elements);
        const imageElements = order.filter((element) => element.type === "image");
        const nextLayers: Record<string, ExtractedLayer> = {};
        let current = 0;

        try {
            for (const element of order) {
                if (controller.signal.aborted) return;
                if (element.type !== "image") continue;

                current += 1;
                setExtractProgress({ current, total: imageElements.length, name: element.name });
                const descendants = getDescendantElements(elements, element.id);
                const logId = nanoid();
                const startedAt = Date.now();
                let canvas: HTMLCanvasElement;

                try {
                    const aiSize = fitAiSize(element.box.width, element.box.height);
                    const crop = cropBox(workingCanvas, element.box);
                    const aiSource = drawToSize(crop, aiSize.width, aiSize.height);
                    const childBoxes = descendants
                        .map((child) => {
                            const left = (Math.max(child.box.x, element.box.x) - element.box.x) / element.box.width;
                            const top = (Math.max(child.box.y, element.box.y) - element.box.y) / element.box.height;
                            const right = (Math.min(child.box.x + child.box.width, element.box.x + element.box.width) - element.box.x) / element.box.width;
                            const bottom = (Math.min(child.box.y + child.box.height, element.box.y + element.box.height) - element.box.y) / element.box.height;
                            return { x: left * aiSize.width, y: top * aiSize.height, width: Math.max(0, right - left) * aiSize.width, height: Math.max(0, bottom - top) * aiSize.height };
                        })
                        .filter((box) => box.width > 0 && box.height > 0);

                    // Filled magenta marker: models that ignore masks still treat it as a placeholder instead of content.
                    if (childBoxes.length) {
                        const context = aiSource.getContext("2d")!;
                        context.fillStyle = "#ff00ff";
                        for (const box of childBoxes) context.fillRect(box.x, box.y, box.width, box.height);
                    }

                    const inputDataUrl = aiSource.toDataURL("image/png");
                    const references: ReferenceImage[] = [{ id: element.id, name: `${sanitizeFileName(element.name)}.png`, type: "image/png", dataUrl: inputDataUrl }];
                    const prompt = childBoxes.length ? t("decompose.cutoutInpaintPrompt") : t("decompose.cutoutPrompt");
                    const requestSize = getElementRequestSize(element.box.width, element.box.height, element.resolution);
                    const systemPrompt = configRef.current.systemPrompt;
                    const editConfig = { ...configRef.current, model: imageModel, count: "1", size: requestSize, background: "transparent" };
                    setRequestLogs((current) => [
                        ...current,
                        { id: logId, elementId: element.id, elementName: element.name, box: element.box, model: imageModel, size: requestSize, quality: configRef.current.quality, background: "transparent", count: 1, prompt: buildImageReferencePromptText(prompt, references), systemPrompt, input: inputDataUrl, status: "loading", createdAt: startedAt },
                    ]);
                    const result = await requestEdit(editConfig, prompt, references, { signal: controller.signal });
                    if (controller.signal.aborted) return;
                    if (!result[0]) throw new Error(t("decompose.failed"));
                    const resultUrl = await imageToDataUrl({ dataUrl: result[0].dataUrl }, { signal: controller.signal });
                    const resultImage = await loadImage(resultUrl);
                    const trimmedResult = trimTransparent(resultImage);
                    if (!trimmedResult) throw new Error(t("decompose.emptyResult"));
                    canvas = drawToSize(trimmedResult, element.box.width, element.box.height);
                    setRequestLogs((current) => current.map((log) => (log.id === logId ? { ...log, status: "success", output: resultUrl, durationMs: Date.now() - startedAt } : log)));
                } catch (extractError) {
                    if (controller.signal.aborted) return;
                    setRequestLogs((current) => current.map((log) => (log.id === logId ? { ...log, status: "error", error: extractError instanceof Error ? extractError.message : t("decompose.failed"), durationMs: Date.now() - startedAt } : log)));
                    message.warning(t("decompose.extractFallback", { name: element.name }));
                    canvas = cropBox(workingCanvas, element.box);
                }

                const blob = await canvasToBlob(canvas);
                const uploaded = await uploadImage(blob, { signal: controller.signal });
                nextLayers[element.id] = { elementId: element.id, width: canvas.width, height: canvas.height, canvas, blob, uploaded };
            }

            if (controller.signal.aborted) return;
            setLayers(nextLayers);
            setSelectedLayerId(null);
            setStep(2);
        } catch (extractError) {
            if (controller.signal.aborted) return;
            setError(extractError instanceof Error ? extractError.message : t("decompose.failed"));
        } finally {
            setExtracting(false);
            setExtractProgress(null);
        }
    };

    const backToHierarchy = () => {
        setStep(1);
        setLayers({});
        setOffsets({});
        setSelectedLayerId(null);
        setError(null);
    };

    const resetPositions = () => {
        setOffsets({});
        setSelectedLayerId(null);
    };

    const buildCache = (): DecomposeCache => ({
        width: workingSize.width,
        height: workingSize.height,
        elements: elements.map((element) => ({ ...element, box: { ...element.box } })),
        layers: Object.values(layers).map((layer) => ({ elementId: layer.elementId, storageKey: layer.uploaded.storageKey, width: layer.width, height: layer.height })),
        offsets: { ...offsets },
        textModel,
        imageModel,
    });

    const buildExport = async () => {
        if (!workingCanvas || !node) throw new Error(t("decompose.failed"));
        const cache = buildCache();
        const { json, fileById } = buildDecomposeExport(cache);
        return { cache, json, fileById, baseBlob: await canvasToBlob(workingCanvas) };
    };

    const exportZip = async () => {
        if (!node || exporting) return;
        setExporting(true);
        try {
            const { cache, json, baseBlob, fileById } = await buildExport();
            const entries: LayerExportEntry[] = [{ name: "base.png", blob: baseBlob }];
            for (const [elementId, fileName] of fileById) {
                const layer = layers[elementId];
                if (layer) entries.push({ name: fileName, blob: layer.blob });
            }
            entries.push({ name: "layers.json", blob: new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }) });
            await downloadLayerZip(entries, node.title || t("decompose.title"));
            const created = onExported ? await onExported({ sourceNodeId: node.id, cache, baseBlob }) : false;
            message.success(t(created === false ? "decompose.exportDone" : "decompose.exportAndCreated"));
        } catch (exportError) {
            message.error(exportError instanceof Error ? exportError.message : t("decompose.failed"));
        } finally {
            setExporting(false);
        }
    };

    const exportJsonOnly = async () => {
        if (!node || exporting) return;
        setExporting(true);
        try {
            const { cache, json, baseBlob } = await buildExport();
            downloadJson(json, node.title || t("decompose.title"));
            const created = onExported ? await onExported({ sourceNodeId: node.id, cache, baseBlob }) : false;
            message.success(t(created === false ? "decompose.exportDone" : "decompose.exportAndCreated"));
        } catch (exportError) {
            message.error(exportError instanceof Error ? exportError.message : t("decompose.failed"));
        } finally {
            setExporting(false);
        }
    };

    const footer =
        step === 0 ? (
            <Space>
                <Button onClick={close}>{t("decompose.cancel")}</Button>
                <Button type="primary" onClick={goToHierarchy} disabled={!elements.length || preparing || analyzing}>
                    {t("decompose.next")}
                </Button>
            </Space>
        ) : step === 1 ? (
            <Space>
                <Button onClick={() => setStep(0)} disabled={extracting}>
                    {t("decompose.back")}
                </Button>
                {extracting ? (
                    <Button onClick={() => abortRef.current?.abort()}>{t("decompose.cancel")}</Button>
                ) : (
                    <Button type="primary" onClick={() => void startExtract()} disabled={!elements.length || (imageModelRequired && !imageReady)}>
                        {t("decompose.startExtract")}
                    </Button>
                )}
            </Space>
        ) : (
            <Space>
                <Button onClick={backToHierarchy}>{t("decompose.backToHierarchy")}</Button>
                <Button type="primary" onClick={close}>
                    {t("decompose.close")}
                </Button>
            </Space>
        );

    return (
        <Modal
            title={<span className="inline-flex items-center gap-2"><Layers className="size-4" />{t("decompose.title")}</span>}
            open={open}
            onCancel={close}
            footer={footer}
            width={1120}
            maskClosable={false}
            keyboard={false}
            destroyOnHidden
        >
            <div className="mb-4 flex items-start gap-3">
                <Steps
                    size="small"
                    current={step}
                    className="min-w-0 flex-1"
                    items={[
                        { title: t("decompose.steps.analyze") },
                        { title: t("decompose.steps.hierarchy") },
                        { title: t("decompose.steps.restore") },
                    ]}
                />
                <Button size="small" icon={<ScrollText className="size-3.5" />} disabled={!requestLogs.length} onClick={() => setLogsOpen(true)}>
                    {t("decompose.logs.button", { count: requestLogs.length })}
                </Button>
            </div>

            {preparing ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-stone-500">
                    <Spin />
                    <span>{t("decompose.preparing")}</span>
                </div>
            ) : prepareError ? (
                <Alert type="error" showIcon message={t("decompose.prepareFailed")} description={prepareError} />
            ) : !node ? null : step === 0 ? (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{t("decompose.analysisModel")}</span>
                        <Select
                            className="min-w-64"
                            value={textModelOptions.includes(textModel) ? textModel : undefined}
                            options={textModelOptions.map((value) => ({ value, label: modelOptionLabel(config, value) }))}
                            placeholder={t("decompose.analysisModelPlaceholder")}
                            onChange={setSelectedTextModel}
                        />
                        <Button type="primary" icon={<Sparkles className="size-4" />} loading={analyzing} disabled={!textReady} onClick={analyze}>
                            {elements.length ? t("decompose.reanalyze") : t("decompose.analyze")}
                        </Button>
                    </div>
                    <Typography.Text type="secondary" className="block text-xs">{t("decompose.analysisModelHint")}</Typography.Text>

                    {!textReady ? <Alert type="warning" showIcon message={t("decompose.noTextModel")} action={<Button size="small" onClick={onOpenConfig}>{t("decompose.openConfig")}</Button>} /> : null}
                    {error ? <Alert type="error" showIcon message={t("decompose.analyzeFailed")} description={error} /> : null}

                    <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
                        <div className="space-y-2">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">{t("decompose.elementsCount", { count: elements.length })}</span>
                                <span className="text-[10px] text-stone-400">{t("decompose.dragToCreate")}</span>
                            </div>
                            <div ref={elementListRef} className="thin-scrollbar max-h-[36vh] space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                                {elements.length ? (
                                    elements.map((element) => (
                                        <button
                                            key={element.id}
                                            type="button"
                                            data-element-id={element.id}
                                            onClick={() => setSelectedElementId(element.id)}
                                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition ${element.id === selectedElementId ? "bg-sky-50 text-sky-900 dark:bg-sky-950/40 dark:text-sky-100" : "hover:bg-stone-100 dark:hover:bg-stone-900"}`}
                                        >
                                            {element.type === "text" ? <Type className="size-3.5 shrink-0 text-amber-500" /> : element.type === "mask" ? <Eraser className="size-3.5 shrink-0 text-rose-400" /> : <Layers className="size-3.5 shrink-0 text-stone-400" />}
                                            <span className="min-w-0 flex-1 truncate text-sm">{element.name}</span>
                                            <span className="shrink-0 text-[10px] text-stone-400">{Math.round(element.box.width)}×{Math.round(element.box.height)}</span>
                                        </button>
                                    ))
                                ) : (
                                    <div className="p-4 text-center text-xs text-stone-500">{t("decompose.emptyElements")}</div>
                                )}
                            </div>

                            {selectedElement ? (
                                <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                                    <div className="flex items-center gap-1.5">
                                        <Input
                                            className="min-w-0 flex-1"
                                            value={selectedElement.name}
                                            maxLength={40}
                                            placeholder={t("decompose.elementNamePlaceholder")}
                                            onChange={(event) => renameElement(selectedElement.id, event.target.value)}
                                        />
                                        <Button
                                            danger
                                            type="text"
                                            size="small"
                                            className="shrink-0"
                                            icon={<Trash2 className="size-3.5" />}
                                            aria-label={t("decompose.deleteElement")}
                                            title={t("decompose.deleteElement")}
                                            onClick={() => deleteElement(selectedElement.id)}
                                        />
                                    </div>
                                    <div className="flex items-center justify-between text-xs text-stone-500">
                                        <Tag className="m-0">{selectedElement.type === "text" ? t("decompose.typeText") : selectedElement.type === "mask" ? t("decompose.typeMask") : t("decompose.typeImage")}</Tag>
                                        <span>{Math.round(selectedElement.box.width)} × {Math.round(selectedElement.box.height)}</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="text-xs text-stone-500">{t("decompose.noSelection")}</div>
                            )}
                        </div>

                        <div className="min-w-0 space-y-2">
                            {workingUrl ? (
                                <CanvasDecomposeBoxEditor
                                    imageUrl={workingUrl}
                                    width={workingSize.width}
                                    height={workingSize.height}
                                    elements={elements}
                                    selectedId={selectedElementId}
                                    onSelect={selectElement}
                                    onChange={updateBox}
                                    onCreate={createElementAtBox}
                                />
                            ) : null}
                            <Typography.Text type="secondary" className="block text-xs">{t("decompose.boxHint")}</Typography.Text>
                        </div>
                    </div>
                </div>
            ) : step === 1 ? (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                    <Alert type="info" showIcon message={t("decompose.hierarchyHint")} />
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm">{t("decompose.imageModel")}</span>
                        <Select
                            className="min-w-64"
                            value={imageModelOptions.includes(imageModel) ? imageModel : undefined}
                            options={imageModelOptions.map((value) => ({ value, label: modelOptionLabel(config, value) }))}
                            placeholder={t("decompose.imageModelPlaceholder")}
                            onChange={setSelectedImageModel}
                        />
                    </div>
                    <Typography.Text type="secondary" className="block text-xs">
                        {imageModelRequired ? t("decompose.imageModelHint") : t("decompose.noImageModelNeeded")}
                    </Typography.Text>
                    {imageModelRequired && !imageReady ? <Alert type="warning" showIcon message={t("decompose.imageModelRequired")} action={<Button size="small" onClick={onOpenConfig}>{t("decompose.openConfig")}</Button>} /> : null}
                    {error ? <Alert type="error" showIcon message={t("decompose.failed")} description={error} /> : null}

                    <div className={extracting ? "pointer-events-none opacity-60" : ""}>
                        <CanvasDecomposeLayerTree elements={elements} previews={previews} onTypeChange={changeElementType} onResolutionChange={changeElementResolution} onReparent={reparentElement} />
                    </div>

                    {extracting ? (
                        <div className="space-y-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="flex items-center gap-2 text-sm text-stone-500">
                                <LoaderCircle className="size-4 animate-spin" />
                                <span>{extractProgress ? t("decompose.extractStage", extractProgress) : t("decompose.extracting")}</span>
                            </div>
                            <Progress percent={extractProgress ? Math.round((extractProgress.current / Math.max(1, extractProgress.total)) * 100) : 0} size="small" />
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                    <Alert type="info" showIcon message={t("decompose.restoreHint")} />
                    {error ? <Alert type="error" showIcon message={t("decompose.failed")} description={error} /> : null}
                    {workingUrl ? (
                        <CanvasDecomposeRestorePreview
                            imageUrl={workingUrl}
                            width={workingSize.width}
                            height={workingSize.height}
                            elements={elements}
                            previews={previews}
                            layers={layers}
                            offsets={offsets}
                            selectedId={selectedLayerId}
                            onSelect={setSelectedLayerId}
                            onMove={(id, dx, dy) => setOffsets((current) => ({ ...current, [id]: { dx, dy } }))}
                        />
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        <Button icon={<RotateCcw className="size-4" />} onClick={resetPositions}>{t("decompose.resetPositions")}</Button>
                        <Button icon={<Download className="size-4" />} loading={exporting} onClick={() => void exportZip()}>{t("decompose.exportZip")}</Button>
                        <Button icon={<FileJson className="size-4" />} disabled={exporting} onClick={() => void exportJsonOnly()}>{t("decompose.exportJson")}</Button>
                    </div>
                </div>
            )}
            <CanvasDecomposeRequestLog open={logsOpen} logs={requestLogs} fileBase={node?.title || t("decompose.title")} onClose={() => setLogsOpen(false)} />
        </Modal>
    );
}

async function hydrateCachedLayers(cache: DecomposeCache) {
    const entries = await Promise.all(
        (cache.layers || []).map(async (item): Promise<[string, ExtractedLayer] | null> => {
            if (!item.storageKey) return null;
            try {
                const blob = await getImageBlob(item.storageKey);
                if (!blob) return null;
                const url = await resolveImageUrl(item.storageKey);
                if (!url) return null;
                const image = await loadImage(url);
                return [
                    item.elementId,
                    {
                        elementId: item.elementId,
                        width: item.width,
                        height: item.height,
                        canvas: drawToSize(image, item.width, item.height),
                        blob,
                        uploaded: { url, storageKey: item.storageKey, width: item.width, height: item.height, bytes: blob.size, mimeType: blob.type },
                    },
                ];
            } catch {
                return null;
            }
        }),
    );
    return Object.fromEntries(entries.filter((entry): entry is [string, ExtractedLayer] => Boolean(entry)));
}
