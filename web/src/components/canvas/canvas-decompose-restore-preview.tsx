import { useEffect, useMemo, useRef } from "react";
import { Type } from "lucide-react";

import { getElementDepth, type DecomposeElement, type ExtractedLayer } from "@/lib/canvas/canvas-decompose";

type Offset = { dx: number; dy: number };

type Props = {
    imageUrl: string;
    width: number;
    height: number;
    elements: DecomposeElement[];
    previews: Record<string, string>;
    layers: Record<string, ExtractedLayer>;
    offsets: Record<string, Offset>;
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onMove: (id: string, dx: number, dy: number) => void;
};

export function CanvasDecomposeRestorePreview({ imageUrl, width, height, elements, previews, layers, offsets, selectedId, onSelect, onMove }: Props) {
    const dragRef = useRef<{ id: string; startX: number; startY: number; startDx: number; startDy: number; scale: number } | null>(null);
    const scale = useMemo(() => Math.min(820 / Math.max(1, width), 520 / Math.max(1, height), 1), [height, width]);
    const displayWidth = Math.max(1, Math.round(width * scale));
    const displayHeight = Math.max(1, Math.round(height * scale));

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            event.preventDefault();
            onMove(drag.id, drag.startDx + (event.clientX - drag.startX) / drag.scale, drag.startDy + (event.clientY - drag.startY) / drag.scale);
        };
        const handleUp = () => {
            dragRef.current = null;
        };
        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleUp);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleUp);
        };
    }, [onMove]);

    const ordered = useMemo(() => [...elements].sort((a, b) => getElementDepth(elements, a.id) - getElementDepth(elements, b.id)), [elements]);

    return (
        <div className="flex justify-center">
            <div className="relative select-none overflow-hidden rounded-lg border border-stone-200 bg-stone-950 shadow-inner dark:border-stone-800" style={{ width: displayWidth, height: displayHeight }} onPointerDown={() => onSelect(null)}>
                <img src={imageUrl} alt="" className="pointer-events-none absolute inset-0 size-full object-contain" draggable={false} />
                {ordered.map((element) => {
                    if (element.type === "mask") return null;
                    const offset = offsets[element.id] || { dx: 0, dy: 0 };
                    const layer = layers[element.id];
                    const isText = element.type === "text";
                    const source = layer?.uploaded.url || previews[element.id];
                    if (!isText && !source) return null;
                    const selected = selectedId === element.id;
                    const fontSize = Math.max(4, Math.min(element.box.height * 0.62, (element.box.width / Math.max(1, element.name.length)) * 1.5)) * scale;
                    return (
                        <div
                            key={element.id}
                            className={`absolute cursor-move ${selected ? "z-40 outline outline-2 outline-sky-400" : "z-20 hover:outline hover:outline-1 hover:outline-sky-300/70"}`}
                            style={{
                                left: (element.box.x + offset.dx) * scale,
                                top: (element.box.y + offset.dy) * scale,
                                width: Math.max(1, element.box.width * scale),
                                height: Math.max(1, element.box.height * scale),
                            }}
                            onPointerDown={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                onSelect(element.id);
                                dragRef.current = { id: element.id, startX: event.clientX, startY: event.clientY, startDx: offset.dx, startDy: offset.dy, scale };
                            }}
                        >
                            {isText ? (
                                <span
                                    className="pointer-events-none flex size-full items-center justify-center overflow-hidden px-1 text-center font-medium text-white"
                                    style={{ fontSize, lineHeight: 1.1, textShadow: "0 1px 3px rgba(0,0,0,0.85)", whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                                >
                                    {element.name}
                                </span>
                            ) : (
                                <img src={source} alt={element.name} className="pointer-events-none size-full object-fill" draggable={false} />
                            )}
                            {isText ? <span className="pointer-events-none absolute inset-0 border border-dashed border-amber-400/80" /> : null}
                            {selected ? (
                                <span className="pointer-events-none absolute left-0 top-0 flex max-w-full -translate-y-full items-center gap-1 truncate bg-sky-500 px-1.5 py-0.5 text-[10px] text-white">
                                    {isText ? <Type className="size-3" /> : null}
                                    {element.name}
                                </span>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
