import { App, Button, Modal, Tag } from "antd";
import { Copy, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { downloadZip, sanitizeFileName, type ElementBox, type LayerExportEntry } from "@/lib/canvas/canvas-decompose";
import type { CutoutParams } from "@/lib/canvas/canvas-cutout-matting";
import { dataUrlToFile } from "@/lib/image-utils";

export type DecomposeCutoutLog = {
    params: CutoutParams;
    selection: ElementBox;
    imageWidth: number;
    imageHeight: number;
    analysisWidth: number;
    analysisHeight: number;
    outputWidth: number;
    outputHeight: number;
};

export type DecomposeRequestLog = {
    id: string;
    elementId: string;
    elementName: string;
    box: ElementBox;
    model: string;
    size: string;
    quality: string;
    background: string;
    count: number;
    prompt: string;
    systemPrompt: string;
    input: string;
    inputs?: string[];
    output?: string;
    status: "loading" | "success" | "error";
    error?: string;
    durationMs?: number;
    createdAt: number;
    cutout?: DecomposeCutoutLog;
};

type Props = {
    open: boolean;
    logs: DecomposeRequestLog[];
    fileBase: string;
    onClose: () => void;
    title?: string;
    emptyText?: string;
    boxLabel?: string;
};

export function CanvasDecomposeRequestLog({ open, logs, fileBase, onClose, title, emptyText, boxLabel }: Props) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const copyText = useCopyText();

    const serialize = () =>
        logs.map((log, index) => {
            const files = logFileNames(log, index);
            return {
                index: index + 1,
                time: new Date(log.createdAt).toISOString(),
                element: log.elementName,
                box: { x: Math.round(log.box.x), y: Math.round(log.box.y), width: Math.round(log.box.width), height: Math.round(log.box.height) },
                model: log.model,
                size: log.size,
                quality: log.quality,
                background: log.background,
                count: log.count,
                systemPrompt: log.systemPrompt,
                prompt: log.prompt,
                status: log.status,
                error: log.error || null,
                durationMs: log.durationMs ?? null,
                cutout: log.cutout
                    ? {
                          params: log.cutout.params,
                          selection: {
                              x: Math.round(log.cutout.selection.x),
                              y: Math.round(log.cutout.selection.y),
                              width: Math.round(log.cutout.selection.width),
                              height: Math.round(log.cutout.selection.height),
                          },
                          imageSize: { width: log.cutout.imageWidth, height: log.cutout.imageHeight },
                          analysisSize: { width: log.cutout.analysisWidth, height: log.cutout.analysisHeight },
                          outputSize: { width: log.cutout.outputWidth, height: log.cutout.outputHeight },
                      }
                    : null,
                input: files.inputs[0],
                inputs: files.inputs,
                output: log.output ? files.output : null,
            };
        });

    const exportZip = async () => {
        try {
            const entries: LayerExportEntry[] = [];
            logs.forEach((log, index) => {
                const files = logFileNames(log, index);
                const inputData = logInputs(log);
                files.inputs.forEach((name, inputIndex) => {
                    entries.push({ name, blob: dataUrlToFile({ id: `${log.id}-${inputIndex}`, name, type: "image/png", dataUrl: inputData[inputIndex] }) });
                });
                if (log.output) entries.push({ name: files.output, blob: dataUrlToFile({ id: log.id, name: files.output, type: "image/png", dataUrl: log.output }) });
            });
            entries.push({ name: "requests.json", blob: new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" }) });
            await downloadZip(entries, `${sanitizeFileName(fileBase)}-requests.zip`);
        } catch {
            message.error(t("decompose.logs.exportFailed"));
        }
    };

    return (
        <Modal open={open} title={title || t("decompose.logs.title")} onCancel={onClose} footer={null} width={1000}>
            {!logs.length ? (
                <div className="py-12 text-center text-sm text-stone-500">{emptyText || t("decompose.logs.empty")}</div>
            ) : (
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-stone-500">{t("decompose.logs.total", { count: logs.length })}</span>
                        <div className="flex gap-2">
                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(JSON.stringify(serialize(), null, 2), t("decompose.logs.copied"))}>
                                {t("decompose.logs.copyJson")}
                            </Button>
                            <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void exportZip()}>
                                {t("decompose.logs.exportZip")}
                            </Button>
                        </div>
                    </div>
                    <div className="thin-scrollbar max-h-[72vh] space-y-3 overflow-y-auto pr-1">
                        {logs.map((log, index) => (
                            <RequestCard key={log.id} log={log} index={index} boxLabel={boxLabel} />
                        ))}
                    </div>
                </div>
            )}
        </Modal>
    );
}

function RequestCard({ log, index, boxLabel }: { log: DecomposeRequestLog; index: number; boxLabel?: string }) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const files = logFileNames(log, index);
    const inputs = logInputs(log);
    const statusColor = log.status === "success" ? "success" : log.status === "error" ? "error" : "processing";

    return (
        <div className="rounded-lg border border-stone-200 p-3 text-sm dark:border-stone-800">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <Tag className="m-0" color={statusColor}>
                    {t(`decompose.logs.status.${log.status}`)}
                </Tag>
                <span className="text-sm font-medium">
                    {index + 1}. {log.elementName}
                </span>
                <span className="text-stone-500">{log.model}</span>
                <span className="text-stone-500">{log.size}</span>
                {log.durationMs != null ? <span className="text-stone-500">{t("decompose.logs.duration", { seconds: (log.durationMs / 1000).toFixed(1) })}</span> : null}
                <span className="ml-auto text-stone-400">{new Date(log.createdAt).toLocaleTimeString()}</span>
            </div>

            <div className="mt-2 grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
                <div className="space-y-2">
                    {inputs.map((source, inputIndex) => (
                        <LogImage
                            key={inputIndex}
                            label={inputs.length > 1 ? `${t("decompose.logs.input")} ${inputIndex + 1}` : t("decompose.logs.input")}
                            src={source}
                            name={files.inputs[inputIndex]}
                        />
                    ))}
                    {log.output ? (
                        <LogImage label={t("decompose.logs.output")} src={log.output} name={files.output} />
                    ) : (
                        <div className="rounded-md border border-dashed border-stone-300 p-3 text-center text-xs text-stone-400 dark:border-stone-700">{t("decompose.logs.noOutput")}</div>
                    )}
                </div>

                <div className="min-w-0 space-y-2">
                    {log.cutout ? (
                        <>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
                                <span>
                                    {t("decompose.logs.cutoutMethod")}: {t("decompose.logs.cutoutRect")}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutSelection")}: {Math.round(log.cutout.selection.x)}, {Math.round(log.cutout.selection.y)} · {Math.round(log.cutout.selection.width)}×{Math.round(log.cutout.selection.height)}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutImageSize")}: {log.cutout.imageWidth}×{log.cutout.imageHeight}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutAnalysisSize")}: {log.cutout.analysisWidth}×{log.cutout.analysisHeight}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutOutputSize")}: {log.cutout.outputWidth}×{log.cutout.outputHeight}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutEdgeThreshold")}: {log.cutout.params.edgeThreshold}
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutCentralRatio")}: {Math.round(log.cutout.params.centralRatio * 100)}%
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutFeather")}: {log.cutout.params.feather}px
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutShrink")}: {log.cutout.params.shrink}px
                                </span>
                                <span>
                                    {t("decompose.logs.cutoutQuality")}: {log.cutout.params.analysisLongEdge}
                                </span>
                            </div>
                            {log.error ? <div className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{log.error}</div> : null}
                        </>
                    ) : (
                        <>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
                                <span>
                                    {t("decompose.logs.size")}: {log.size}
                                </span>
                                <span>
                                    {t("decompose.logs.quality")}: {log.quality || "auto"}
                                </span>
                                <span>
                                    {t("decompose.logs.background")}: {log.background || "-"}
                                </span>
                                <span>
                                    {t("decompose.logs.quantity")}: {log.count}
                                </span>
                                <span>
                                    {boxLabel || t("decompose.logs.box")}: {Math.round(log.box.width)}×{Math.round(log.box.height)}
                                </span>
                            </div>
                            {log.systemPrompt ? (
                                <div className="text-[11px] text-stone-500">
                                    {t("decompose.logs.systemPrompt")}: {log.systemPrompt}
                                </div>
                            ) : null}
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-stone-500">{t("decompose.logs.prompt")}</span>
                                <Button type="text" size="small" icon={<Copy className="size-3.5" />} onClick={() => copyText(log.prompt, t("decompose.logs.copied"))}>
                                    {t("decompose.logs.copyPrompt")}
                                </Button>
                            </div>
                            <pre className="thin-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/5 p-2 text-xs leading-5 dark:bg-white/10">{log.prompt}</pre>
                            {log.error ? <div className="rounded-md border border-red-300/60 bg-red-50 p-2 text-xs text-red-600 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">{log.error}</div> : null}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

function LogImage({ label, src, name }: { label: string; src: string; name: string }) {
    const { t } = useTranslation();
    return (
        <div>
            <div className="mb-1 flex items-center justify-between text-[11px] text-stone-500">
                <span>{label}</span>
                <a href={src} download={name} className="underline-offset-2 hover:underline" title={t("decompose.logs.downloadImage")}>
                    {t("decompose.logs.downloadImage")}
                </a>
            </div>
            <a href={src} download={name} className="block overflow-hidden rounded-md border border-stone-200 bg-stone-100 dark:border-stone-800 dark:bg-stone-900">
                <img src={src} alt={label} loading="lazy" draggable={false} className="max-h-40 w-full object-contain" />
            </a>
        </div>
    );
}

function logInputs(log: DecomposeRequestLog) {
    return log.inputs?.length ? log.inputs : [log.input];
}

function logFileNames(log: DecomposeRequestLog, index: number) {
    const prefix = String(index + 1).padStart(2, "0");
    const base = sanitizeFileName(log.elementName);
    const count = logInputs(log).length;
    const inputs = Array.from({ length: count }, (_, inputIndex) => (count > 1 ? `input/${prefix}-${base}-${inputIndex + 1}.png` : `input/${prefix}-${base}.png`));
    return { inputs, output: `output/${prefix}-${base}.png` };
}
