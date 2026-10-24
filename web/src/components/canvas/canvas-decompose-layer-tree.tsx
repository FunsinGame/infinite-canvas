import { useMemo, useState } from "react";
import { Button, Popover, Segmented, Tag, Tooltip } from "antd";
import { ArrowUpToLine, Eraser, GripVertical, Type } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
    flattenElementTree,
    getElementExtractionOrder,
    isElementDescendant,
    type DecomposeElement,
    type DecomposeElementType,
    type DecomposeResolution,
} from "@/lib/canvas/canvas-decompose";

type Props = {
    elements: DecomposeElement[];
    previews: Record<string, string>;
    onTypeChange: (id: string, type: DecomposeElementType) => void;
    onResolutionChange: (id: string, resolution: DecomposeResolution) => void;
    onReparent: (id: string, parentId: string | null) => void;
};

export function CanvasDecomposeLayerTree({ elements, previews, onTypeChange, onResolutionChange, onReparent }: Props) {
    const { t } = useTranslation();
    const rows = useMemo(() => flattenElementTree(elements), [elements]);
    const orderMap = useMemo(() => new Map(getElementExtractionOrder(elements).filter((element) => element.type === "image").map((element, index) => [element.id, index + 1])), [elements]);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dropTargetId, setDropTargetId] = useState<string | null>(null);

    const canDropOn = (targetId: string) => Boolean(draggingId && draggingId !== targetId && !isElementDescendant(elements, draggingId, targetId));

    const dropOn = (parentId: string | null) => {
        if (!draggingId) return;
        if (parentId && !canDropOn(parentId)) {
            setDraggingId(null);
            setDropTargetId(null);
            return;
        }
        onReparent(draggingId, parentId);
        setDraggingId(null);
        setDropTargetId(null);
    };

    return (
        <div className="space-y-2">
            <div
                className={`rounded-md border border-dashed px-3 py-2 text-center text-xs transition ${dropTargetId === "root" ? "border-sky-400 bg-sky-50 text-sky-700 dark:bg-sky-950/30 dark:text-sky-300" : "border-stone-300 text-stone-500 dark:border-stone-700"}`}
                onDragOver={(event) => {
                    if (!draggingId) return;
                    event.preventDefault();
                    setDropTargetId("root");
                }}
                onDragLeave={() => setDropTargetId((current) => (current === "root" ? null : current))}
                onDrop={(event) => {
                    event.preventDefault();
                    dropOn(null);
                }}
            >
                {t("decompose.dropRoot")}
            </div>

            <div className="thin-scrollbar max-h-[380px] space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {rows.map(({ element, depth }) => {
                    const preview = previews[element.id];
                    const isDropTarget = dropTargetId === element.id;
                    return (
                        <div
                            key={element.id}
                            className={`group flex items-center gap-2 rounded-md px-2 py-1.5 transition ${isDropTarget ? "bg-sky-50 ring-1 ring-sky-300 dark:bg-sky-950/30" : "hover:bg-stone-100 dark:hover:bg-stone-900"}`}
                            style={{ paddingLeft: 8 + depth * 18 }}
                            onDragOver={(event) => {
                                if (!canDropOn(element.id)) return;
                                event.preventDefault();
                                setDropTargetId(element.id);
                            }}
                            onDragLeave={() => setDropTargetId((current) => (current === element.id ? null : current))}
                            onDrop={(event) => {
                                event.preventDefault();
                                dropOn(element.id);
                            }}
                        >
                            <span
                                draggable
                                className="cursor-grab text-stone-400 active:cursor-grabbing"
                                title={t("decompose.dragHint")}
                                onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", element.id);
                                    setDraggingId(element.id);
                                }}
                                onDragEnd={() => {
                                    setDraggingId(null);
                                    setDropTargetId(null);
                                }}
                            >
                                <GripVertical className="size-4" />
                            </span>

                            <Popover
                                trigger="hover"
                                mouseEnterDelay={1}
                                placement="right"
                                content={
                                    preview ? (
                                        <div className="w-[420px] max-w-[58vw]">
                                            <img src={preview} alt={element.name} className="max-h-[60vh] w-full rounded-md object-contain" />
                                            <div className="mt-1 text-xs text-stone-500">{t("decompose.childMaskHint")}</div>
                                        </div>
                                    ) : null
                                }
                            >
                                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded border border-stone-200 bg-stone-950 dark:border-stone-800">
                                    {preview ? <img src={preview} alt={element.name} className="size-full object-cover" /> : null}
                                </div>
                            </Popover>

                            <Tag className="m-0 shrink-0" color="default">
                                {orderMap.has(element.id) ? `#${orderMap.get(element.id)}` : "—"}
                            </Tag>

                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                {element.type === "text" ? <Type className="size-3.5 shrink-0 text-amber-500" /> : element.type === "mask" ? <Eraser className="size-3.5 shrink-0 text-rose-400" /> : null}
                                <span className="truncate text-sm" title={element.name}>{element.name}</span>
                                {element.parentId ? <span className="shrink-0 text-[10px] text-stone-400">↳</span> : null}
                            </div>

                            <Segmented
                                size="small"
                                className="shrink-0 text-xs"
                                value={element.type}
                                options={[
                                    { value: "image", label: t("decompose.typeImage") },
                                    { value: "text", label: t("decompose.typeText") },
                                    { value: "mask", label: t("decompose.typeMask") },
                                ]}
                                onChange={(value) => onTypeChange(element.id, value as DecomposeElementType)}
                            />

                            <Segmented
                                size="small"
                                className="shrink-0 text-xs"
                                value={element.resolution}
                                options={[
                                    { value: "1k", label: "1K", tooltip: t("decompose.requestResolutionHint", { resolution: "1K" }) },
                                    { value: "2k", label: "2K", tooltip: t("decompose.requestResolutionHint", { resolution: "2K" }) },
                                ]}
                                onChange={(value) => onResolutionChange(element.id, value as DecomposeResolution)}
                            />

                            <Tooltip title={t("decompose.moveToTopLevel")}>
                                <Button
                                    type="text"
                                    size="small"
                                    className="shrink-0"
                                    icon={<ArrowUpToLine className="size-4" />}
                                    aria-label={t("decompose.moveToTopLevel")}
                                    disabled={!element.parentId}
                                    onClick={() => onReparent(element.id, null)}
                                />
                            </Tooltip>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
