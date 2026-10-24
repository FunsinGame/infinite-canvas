import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Popover, Select, Space, Steps, Tag, Typography } from "antd";
import { Download, Eraser, Layers, Play, ScrollText, Sparkles, Trash2, Type } from "lucide-react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { CanvasDecomposeBoxEditor } from "@/components/canvas/canvas-decompose-box-editor";
import { CanvasDecomposeLayerTree } from "@/components/canvas/canvas-decompose-layer-tree";
import { CanvasDecomposeRequestLog, type DecomposeRequestLog } from "@/components/canvas/canvas-decompose-request-log";
import {
    assignElementParents,
    canvasToBlob,
    createElementPreviewDataUrl,
    cropBox,
    downloadZip,
    drawToSize,
    fitAiSize,
    fitWorkingSize,
    getDescendantElements,
    getElementExtractionOrder,
    getElementRequestSize,
    isElementDescendant,
    loadImage,
    sanitizeFileName,
    trimByBackground,
    type DecomposeElement,
    type DecomposeElementType,
    type DecomposeResolution,
    type ElementBox,
    type LayerExportEntry,
} from "@/lib/canvas/canvas-decompose";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { analyzeImageElements } from "@/services/api/decompose-plan";
import { requestEdit } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionLabel, resolveModelForCapability, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { CanvasNodeData } from "@/types/canvas";

const TEXT_MODEL_STORAGE_KEY = "infinite-canvas:decompose-text-model";
const IMAGE_MODEL_STORAGE_KEY = "infinite-canvas:decompose-image-model";

type DecomposeExportResult = {
    id: string;
    elementId: string;
    elementName: string;
    dataUrl: string;
    blob: Blob;
    width: number;
    height: number;
    logs: DecomposeRequestLog[];
    createdAt: number;
};

type DecomposeDialogProps = {
    node: CanvasNodeData | null;
    open: boolean;
    config: AiConfig;
    onClose: () => void;
    onOpenConfig: () => void;
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

export function CanvasImageDecomposeDialog({ node, open, config, onClose, onOpenConfig }: DecomposeDialogProps) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const configRef = useRef(config);
    const abortRef = useRef<AbortController | null>(null);
    const runAbortsRef = useRef(new Set<AbortController>());
    const runningRef = useRef(new Set<string>());
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
    const [previews, setPreviews] = useState<Record<string, string>>({});
    const [runningIds, setRunningIds] = useState<string[]>([]);
    const [results, setResults] = useState<Record<string, DecomposeExportResult[]>>({});
    const [elementErrors, setElementErrors] = useState<Record<string, string>>({});
    const [error, setError] = useState<string | null>(null);
    const [requestLogs, setRequestLogs] = useState<DecomposeRequestLog[]>([]);
    const [logsOpen, setLogsOpen] = useState(false);
    const [resultLog, setResultLog] = useState<DecomposeExportResult | null>(null);
    const [exportingAll, setExportingAll] = useState(false);

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
        runAbortsRef.current.forEach((controller) => controller.abort());
        runAbortsRef.current.clear();
        runningRef.current.clear();
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
        setRunningIds([]);
        setResults({});
        setElementErrors({});
        setError(null);
        setRequestLogs([]);
        setLogsOpen(false);
        setResultLog(null);
        setAnalyzing(false);
        setExportingAll(false);

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
                    setElements(cache.elements.map((element) => ({ ...element, box: { ...element.box } })));
                    if (cache.textModel) setSelectedTextModel(cache.textModel);
                    if (cache.imageModel) setSelectedImageModel(cache.imageModel);
                    setStep(1);
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

    useEffect(() => {
        return () => {
            runAbortsRef.current.forEach((controller) => controller.abort());
            runAbortsRef.current.clear();
        };
    }, []);

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

    const selectedElement = elements.find((element) => element.id === selectedElementId) || null;
    const exportRows = useMemo(() => elements.filter((element) => element.type === "image"), [elements]);
    const orderMap = useMemo(() => new Map(getElementExtractionOrder(elements).filter((element) => element.type === "image").map((element, index) => [element.id, index + 1])), [elements]);
    const resultCount = useMemo(() => exportRows.reduce((total, element) => total + (results[element.id]?.length || 0), 0), [exportRows, results]);
    const anyRunning = runningIds.length > 0;

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
        runAbortsRef.current.forEach((controller) => controller.abort());
        runAbortsRef.current.clear();
        runningRef.current.clear();
        setLogsOpen(false);
        setResultLog(null);
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
            setResults({});
            setElementErrors({});
            setRequestLogs([]);
            setResultLog(null);
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
        setElements([...elements, withParents.find((element) => element.id === next.id) || next]);
        selectElement(next.id);
    };

    const renameElement = (id: string, name: string) => {
        setElements((current) => current.map((element) => (element.id === id ? { ...element, name } : element)));
    };

    const deleteElement = (id: string) => {
        const target = elements.find((element) => element.id === id);
        if (!target) return;
        const removedLogIds = new Set((results[id] || []).flatMap((result) => result.logs.map((log) => log.id)));
        setElements((current) => current.filter((element) => element.id !== id).map((element) => (element.parentId === id ? { ...element, parentId: target.parentId } : element)));
        setResults((current) => {
            if (!current[id]) return current;
            const next = { ...current };
            delete next[id];
            return next;
        });
        setElementErrors((current) => {
            if (!current[id]) return current;
            const next = { ...current };
            delete next[id];
            return next;
        });
        if (removedLogIds.size) setRequestLogs((current) => current.filter((log) => !removedLogIds.has(log.id)));
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
        setStep(1);
    };

    const goToExport = () => {
        if (!elements.length) return;
        setError(null);
        setStep(2);
    };

    const exportByAi = async (element: DecomposeElement, signal: AbortSignal): Promise<DecomposeExportResult | null> => {
        if (!workingCanvas) return null;
        const startedAt = Date.now();
        const aiSize = fitAiSize(element.box.width, element.box.height);
        const crop = cropBox(workingCanvas, element.box);
        const aiSource = drawToSize(crop, aiSize.width, aiSize.height);
        const descendants = getDescendantElements(elements, element.id);
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
        const requestSize = getElementRequestSize(element.resolution);
        const systemPrompt = configRef.current.systemPrompt;
        const editConfig = { ...configRef.current, model: imageModel, count: "1", size: requestSize, background: "transparent" };
        let canvas: HTMLCanvasElement;
        let resultDataUrl: string;
        let output: string | undefined;
        let logError: string | undefined;
        let status: DecomposeRequestLog["status"] = "success";

        try {
            const result = await requestEdit(editConfig, prompt, references, { signal });
            if (signal.aborted) return null;
            if (!result[0]) throw new Error(t("decompose.failed"));
            const resultUrl = await imageToDataUrl({ dataUrl: result[0].dataUrl }, { signal });
            const resultImage = await loadImage(resultUrl);
            const trimmedResult = trimByBackground(resultImage);
            if (!trimmedResult) throw new Error(t("decompose.emptyResult"));
            canvas = drawToSize(trimmedResult, element.box.width, element.box.height);
            resultDataUrl = canvas.toDataURL("image/png");
            output = resultDataUrl;
        } catch (extractError) {
            if (signal.aborted) return null;
            status = "error";
            logError = extractError instanceof Error ? extractError.message : t("decompose.failed");
            message.warning(t("decompose.extractFallback", { name: element.name }));
            canvas = cropBox(workingCanvas, element.box);
            resultDataUrl = canvas.toDataURL("image/png");
        }

        const blob = await canvasToBlob(canvas);
        const log: DecomposeRequestLog = {
            id: nanoid(),
            elementId: element.id,
            elementName: element.name,
            box: element.box,
            model: imageModel,
            size: requestSize,
            quality: configRef.current.quality || "",
            background: "transparent",
            count: 1,
            prompt: buildImageReferencePromptText(prompt, references),
            systemPrompt,
            input: inputDataUrl,
            status,
            error: logError,
            output,
            durationMs: Date.now() - startedAt,
            createdAt: startedAt,
        };
        setRequestLogs((current) => [...current, log]);
        return {
            id: nanoid(),
            elementId: element.id,
            elementName: element.name,
            dataUrl: resultDataUrl,
            blob,
            width: canvas.width,
            height: canvas.height,
            logs: [log],
            createdAt: startedAt,
        };
    };

    const runExport = async (element: DecomposeElement) => {
        if (!workingCanvas || !node || runningRef.current.has(element.id)) return;
        if (!imageReady) {
            setElementErrors((current) => ({ ...current, [element.id]: t("decompose.imageModelRequired") }));
            return;
        }

        runningRef.current.add(element.id);
        setRunningIds(Array.from(runningRef.current));
        setElementErrors((current) => {
            if (!current[element.id]) return current;
            const next = { ...current };
            delete next[element.id];
            return next;
        });

        const controller = new AbortController();
        runAbortsRef.current.add(controller);
        try {
            const result = await exportByAi(element, controller.signal);
            if (!result || controller.signal.aborted) return;
            setResults((current) => ({ ...current, [element.id]: [...(current[element.id] || []), result] }));
        } catch (exportError) {
            if (controller.signal.aborted) return;
            const errorMessage = exportError instanceof Error ? exportError.message : t("decompose.failed");
            setElementErrors((current) => ({ ...current, [element.id]: errorMessage }));
            message.error(errorMessage);
        } finally {
            runAbortsRef.current.delete(controller);
            runningRef.current.delete(element.id);
            setRunningIds(Array.from(runningRef.current));
        }
    };

    const downloadResult = (result: DecomposeExportResult, index: number) => {
        saveAs(result.blob, `${sanitizeFileName(result.elementName)}-${index + 1}.png`);
    };

    const deleteResult = (result: DecomposeExportResult) => {
        setResults((current) => {
            const list = (current[result.elementId] || []).filter((item) => item.id !== result.id);
            const next = { ...current };
            if (list.length) next[result.elementId] = list;
            else delete next[result.elementId];
            return next;
        });
        const removedLogIds = new Set(result.logs.map((log) => log.id));
        setRequestLogs((current) => current.filter((log) => !removedLogIds.has(log.id)));
        if (resultLog?.id === result.id) setResultLog(null);
    };

    const exportAll = async () => {
        if (!node || exportingAll || anyRunning) return;
        const entries: LayerExportEntry[] = [];
        exportRows.forEach((element, elementIndex) => {
            (results[element.id] || []).forEach((result, resultIndex) => {
                entries.push({ name: `${String(elementIndex + 1).padStart(2, "0")}-${sanitizeFileName(element.name)}-${resultIndex + 1}.png`, blob: result.blob });
            });
        });
        if (!entries.length) {
            message.warning(t("decompose.noResults"));
            return;
        }
        setExportingAll(true);
        try {
            await downloadZip(entries, `${sanitizeFileName(node.title || t("decompose.title"))}-export.zip`);
            message.success(t("decompose.exportAllDone", { count: entries.length }));
        } catch (exportError) {
            message.error(exportError instanceof Error ? exportError.message : t("decompose.failed"));
        } finally {
            setExportingAll(false);
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
                <Button onClick={() => setStep(0)}>{t("decompose.back")}</Button>
                <Button type="primary" onClick={goToExport} disabled={!elements.length}>
                    {t("decompose.next")}
                </Button>
            </Space>
        ) : (
            <Space>
                <Button onClick={() => setStep(1)} disabled={anyRunning || exportingAll}>
                    {t("decompose.back")}
                </Button>
                <Button onClick={close} disabled={anyRunning || exportingAll}>
                    {t("decompose.close")}
                </Button>
                <Button type="primary" icon={<Download className="size-4" />} loading={exportingAll} disabled={!resultCount || anyRunning} onClick={() => void exportAll()}>
                    {t("decompose.exportAll")}
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
                        { title: t("decompose.steps.export") },
                    ]}
                />
                <Button size="small" icon={<ScrollText className="size-3.5" />} disabled={!requestLogs.length} onClick={() => setLogsOpen(true)}>
                    {t("decompose.logs.button", { count: requestLogs.length })}
                </Button>
            </div>

            {preparing ? (
                <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-stone-500">
                    <span className="size-5 animate-spin rounded-full border-2 border-stone-400 border-t-transparent" />
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
                    <div className="rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                        <CanvasDecomposeLayerTree elements={elements} previews={previews} onTypeChange={changeElementType} onResolutionChange={changeElementResolution} onReparent={reparentElement} />
                    </div>
                </div>
            ) : (
                <div className="max-h-[70vh] space-y-3 overflow-y-auto pr-1">
                    <Alert type="info" showIcon message={t("decompose.exportHint")} />
                    {exportRows.length ? (
                        <div className="space-y-1">
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
                            <Typography.Text type="secondary" className="block text-xs">{t("decompose.imageModelHint")}</Typography.Text>
                        </div>
                    ) : null}
                    {error ? <Alert type="error" showIcon message={t("decompose.failed")} description={error} /> : null}
                    {exportRows.length && !imageReady ? <Alert type="warning" showIcon message={t("decompose.imageModelRequired")} action={<Button size="small" onClick={onOpenConfig}>{t("decompose.openConfig")}</Button>} /> : null}

                    <div className="space-y-2">
                        {exportRows.length ? (
                            exportRows.map((element) => {
                                const running = runningIds.includes(element.id);
                                const elementError = elementErrors[element.id];
                                const list = results[element.id] || [];
                                return (
                                    <div key={element.id} className="overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800">
                                        <div className="flex flex-wrap items-center gap-3 p-3">
                                            <Popover
                                                trigger="hover"
                                                mouseEnterDelay={1}
                                                placement="right"
                                                content={
                                                    previews[element.id] ? (
                                                        <div className="w-[420px] max-w-[58vw]">
                                                            <img src={previews[element.id]} alt={element.name} className="max-h-[60vh] w-full rounded-md object-contain" />
                                                            <div className="mt-1 text-xs text-stone-500">{t("decompose.childMaskHint")}</div>
                                                        </div>
                                                    ) : null
                                                }
                                            >
                                                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-stone-200 bg-stone-950 dark:border-stone-800">
                                                    {previews[element.id] ? <img src={previews[element.id]} alt={element.name} className="size-full object-contain" draggable={false} /> : null}
                                                </div>
                                            </Popover>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center gap-1.5">
                                                    <Tag className="m-0 shrink-0">#{orderMap.get(element.id) || "—"}</Tag>
                                                    <span className="truncate text-sm font-medium" title={element.name}>{element.name}</span>
                                                </div>
                                                <div className="mt-0.5 text-xs text-stone-500">
                                                    {Math.round(element.box.width)}×{Math.round(element.box.height)} · {element.resolution.toUpperCase()}
                                                </div>
                                            </div>
                                            <Button type="primary" icon={<Play className="size-3.5" />} loading={running} disabled={running || exportingAll} onClick={() => void runExport(element)}>
                                                {t("decompose.execute")}
                                            </Button>
                                        </div>
                                        {elementError ? <div className="px-3 pb-2 text-xs text-red-500">{elementError}</div> : null}
                                        {list.length ? (
                                            <div className="mx-auto mb-3 mt-1 w-1/2 space-y-2 rounded-lg border border-stone-200 bg-stone-50/70 p-2 dark:border-stone-800 dark:bg-white/[0.03]">
                                                {list.map((result, index) => (
                                                    <div key={result.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-stone-200 bg-white p-2 dark:border-stone-800 dark:bg-stone-950/40">
                                                        <Popover
                                                            trigger="hover"
                                                            mouseEnterDelay={1}
                                                            placement="right"
                                                            content={
                                                                <div className="w-[420px] max-w-[58vw] rounded-md bg-stone-950 p-2">
                                                                    <img src={result.dataUrl} alt={result.elementName} className="max-h-[60vh] w-full rounded-md object-contain" />
                                                                </div>
                                                            }
                                                        >
                                                            <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-stone-200 bg-stone-950 dark:border-stone-800">
                                                                <img src={result.dataUrl} alt={result.elementName} className="size-full object-contain" draggable={false} />
                                                            </div>
                                                        </Popover>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex flex-wrap items-center gap-1.5 text-xs">
                                                                <span>{t("decompose.resultRun", { index: index + 1 })}</span>
                                                            </div>
                                                            <div className="mt-0.5 text-[11px] text-stone-500">{result.width}×{result.height} · {new Date(result.createdAt).toLocaleTimeString()}</div>
                                                        </div>
                                                        <Button size="small" icon={<Download className="size-3.5" />} onClick={() => downloadResult(result, index)}>{t("decompose.resultDownload")}</Button>
                                                        <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => deleteResult(result)}>{t("decompose.resultDelete")}</Button>
                                                        <Button size="small" icon={<ScrollText className="size-3.5" />} onClick={() => setResultLog(result)}>{t("decompose.resultLog")}</Button>
                                                    </div>
                                                ))}
                                            </div>
                                        ) : null}
                                    </div>
                                );
                            })
                        ) : (
                            <div className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500 dark:border-stone-700">{t("decompose.noExportElements")}</div>
                        )}
                    </div>
                </div>
            )}
            <CanvasDecomposeRequestLog open={logsOpen} logs={requestLogs} fileBase={node?.title || t("decompose.title")} onClose={() => setLogsOpen(false)} />
            <CanvasDecomposeRequestLog
                open={Boolean(resultLog)}
                logs={resultLog?.logs || []}
                fileBase={node?.title || t("decompose.title")}
                onClose={() => setResultLog(null)}
            />
        </Modal>
    );
}
