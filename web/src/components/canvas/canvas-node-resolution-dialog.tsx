import { useEffect, useState } from "react";
import { Button, InputNumber, Modal, Tooltip } from "antd";
import { Lock, LockOpen, Scaling } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import type { ImageResizeParams } from "@/lib/canvas/canvas-image-data";

export type CanvasImageResolution = ImageResizeParams;

export function CanvasNodeResolutionDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (size: CanvasImageResolution) => void }) {
    const { t } = useTranslation();
    const [source, setSource] = useState<CanvasImageResolution | null>(null);
    const [size, setSize] = useState<CanvasImageResolution>({ width: 0, height: 0 });
    const [locked, setLocked] = useState(true);
    const ratio = source ? source.width / source.height : 1;
    const changed = Boolean(source && (size.width !== source.width || size.height !== source.height));

    useEffect(() => {
        if (!open) return;
        setSource(null);
        setLocked(true);
        void readImageMeta(dataUrl).then((image) => {
            setSource({ width: image.width, height: image.height });
            setSize({ width: image.width, height: image.height });
        });
    }, [dataUrl, open]);

    const updateWidth = (value: number | null) => {
        const width = normalizeSize(value);
        setSize((current) => ({ width, height: locked ? Math.max(1, Math.round(width / ratio)) : current.height }));
    };

    const updateHeight = (value: number | null) => {
        const height = normalizeSize(value);
        setSize((current) => ({ width: locked ? Math.max(1, Math.round(height * ratio)) : current.width, height }));
    };

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={720} centered destroyOnHidden>
            <div className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">{t("canvas.editors.resolutionTitle")}</h2>
                    <p className="mt-1 text-sm opacity-60">{t("canvas.editors.resolutionDescription")}</p>
                </div>
                <div className="grid gap-6 md:grid-cols-[minmax(240px,1fr)_320px]">
                    <div className="rounded-xl border p-4">
                        <div className="grid min-h-[260px] place-items-center rounded-lg bg-black/5">
                            <img src={dataUrl} alt="" className="max-h-[300px] max-w-full rounded-lg object-contain shadow-xl" draggable={false} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-sm">
                            <span className="opacity-60">{t("canvas.editors.source")}</span>
                            <span className="font-semibold">{source ? `${source.width} x ${source.height} px` : t("canvas.editors.loading")}</span>
                        </div>
                    </div>
                    <div className="space-y-4 py-2">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-end gap-2">
                            <SizeField label={t("canvas.editors.width")} value={size.width} disabled={!source} onChange={updateWidth} />
                            <Tooltip title={locked ? t("canvas.editors.unlockRatio") : t("canvas.editors.lockRatio")}>
                                <Button icon={locked ? <Lock className="size-4" /> : <LockOpen className="size-4" />} aria-label={locked ? t("canvas.editors.unlockRatio") : t("canvas.editors.lockRatio")} onClick={() => setLocked((current) => !current)} />
                            </Tooltip>
                            <SizeField label={t("canvas.editors.height")} value={size.height} disabled={!source} onChange={updateHeight} />
                        </div>
                        <div className="text-xs opacity-55">{locked ? t("canvas.editors.ratioLocked") : t("canvas.editors.ratioUnlocked")}</div>
                        <div className="rounded-xl border px-4 py-3 text-sm">
                            <div className="flex items-center justify-between">
                                <span className="opacity-60">{t("canvas.editors.outputSize")}</span>
                                <span className="font-semibold">
                                    {size.width} x {size.height} px
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex justify-end">
                    <Button type="primary" size="large" icon={<Scaling className="size-4" />} disabled={!source || !changed} onClick={() => onConfirm(size)}>
                        {t("canvas.editors.resolutionConfirm")}
                    </Button>
                </div>
            </div>
        </Modal>
    );
}

function SizeField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number | null) => void }) {
    return (
        <div className="min-w-0">
            <div className="mb-1.5 text-sm font-medium opacity-75">{label}</div>
            <InputNumber className="w-full" style={{ width: "100%" }} min={1} precision={0} controls={false} value={value || null} disabled={disabled} onChange={onChange} />
        </div>
    );
}

function normalizeSize(value: number | null) {
    return Math.max(1, Math.round(Number(value) || 1));
}
