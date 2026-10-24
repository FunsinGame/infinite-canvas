import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Eraser, Move, Type } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { DecomposeElement, ElementBox } from "@/lib/canvas/canvas-decompose";

type DragMode = "move" | "n" | "e" | "s" | "w" | "nw" | "ne" | "sw" | "se";

type DragState = {
    id: string;
    mode: DragMode;
    pointerX: number;
    pointerY: number;
    startBox: ElementBox;
};

type ViewState = { zoom: number; x: number; y: number };

type PanState = { startX: number; startY: number; x: number; y: number };

type CreateState = {
    startX: number;
    startY: number;
};

type Props = {
    imageUrl: string;
    width: number;
    height: number;
    elements: DecomposeElement[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onChange: (id: string, box: ElementBox) => void;
    onCreate: (box: ElementBox) => void;
};

const WHEEL_ZOOM_SPEED = 0.0015;

export function CanvasDecomposeBoxEditor({ imageUrl, width, height, elements, selectedId, onSelect, onChange, onCreate }: Props) {
    const { t } = useTranslation();
    const containerRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<DragState | null>(null);
    const panRef = useRef<PanState | null>(null);
    const createRef = useRef<CreateState | null>(null);
    const onChangeRef = useRef(onChange);
    const [view, setView] = useState<ViewState>({ zoom: 1, x: 0, y: 0 });
    const viewRef = useRef(view);
    const [panning, setPanning] = useState(false);
    const [draft, setDraft] = useState<ElementBox | null>(null);

    const applyView = (next: ViewState) => {
        viewRef.current = next;
        setView(next);
    };

    useEffect(() => {
        onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
        const next = { zoom: 1, x: 0, y: 0 };
        viewRef.current = next;
        setView(next);
        panRef.current = null;
        createRef.current = null;
        setPanning(false);
        setDraft(null);
    }, [height, imageUrl, width]);

    useEffect(() => {
        const viewport = containerRef.current;
        if (!viewport) return;

        const handleWheel = (event: WheelEvent) => {
            event.preventDefault();
            const rect = viewport.getBoundingClientRect();
            if (!rect.width || !rect.height) return;

            const current = viewRef.current;
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
            if (!delta) return;

            const nextZoom = Math.max(1, current.zoom * Math.exp(-delta * WHEEL_ZOOM_SPEED));
            if (!Number.isFinite(nextZoom) || Math.abs(nextZoom - current.zoom) < 0.0001) return;

            const cursorX = event.clientX - rect.left;
            const cursorY = event.clientY - rect.top;
            const contentX = (cursorX - current.x) / current.zoom;
            const contentY = (cursorY - current.y) / current.zoom;
            applyView(clampView({ zoom: nextZoom, x: cursorX - contentX * nextZoom, y: cursorY - contentY * nextZoom }, rect));

            const create = createRef.current;
            if (create) {
                const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
                setDraft(boxBetween(create.startX, create.startY, point.x, point.y));
                return;
            }
            const drag = dragRef.current;
            if (drag) {
                const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
                onChangeRef.current(drag.id, computeDragBox(drag, point, width, height));
            }
        };

        viewport.addEventListener("wheel", handleWheel, { passive: false });
        return () => viewport.removeEventListener("wheel", handleWheel);
    }, [height, width]);

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const pan = panRef.current;
            if (!pan) return;
            event.preventDefault();
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const current = viewRef.current;
            applyView(clampView({ zoom: current.zoom, x: pan.x + event.clientX - pan.startX, y: pan.y + event.clientY - pan.startY }, rect));
        };

        const handleUp = () => {
            if (!panRef.current) return;
            panRef.current = null;
            setPanning(false);
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleUp);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleUp);
        };
    }, []);

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const create = createRef.current;
            if (!create) return;
            event.preventDefault();
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
            setDraft(boxBetween(create.startX, create.startY, point.x, point.y));
        };

        const handleUp = (event: PointerEvent) => {
            if (event.button !== 0) return;
            const create = createRef.current;
            if (!create) return;
            createRef.current = null;
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
            const box = boxBetween(create.startX, create.startY, point.x, point.y);
            setDraft(null);
            if (box.width >= 8 && box.height >= 8) onCreate(box);
        };

        const handleCancel = () => {
            createRef.current = null;
            setDraft(null);
        };

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp);
        window.addEventListener("pointercancel", handleCancel);
        return () => {
            window.removeEventListener("pointermove", handleMove);
            window.removeEventListener("pointerup", handleUp);
            window.removeEventListener("pointercancel", handleCancel);
        };
    }, [height, onCreate, width]);

    useEffect(() => {
        const handleMove = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            event.preventDefault();
            const rect = containerRef.current?.getBoundingClientRect();
            if (!rect) return;
            const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
            onChange(drag.id, computeDragBox(drag, point, width, height));
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
    }, [height, onChange, width]);

    const beginDrag = (event: ReactPointerEvent, element: DecomposeElement, mode: DragMode) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(element.id);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
        dragRef.current = { id: element.id, mode, pointerX: point.x, pointerY: point.y, startBox: element.box };
    };

    const beginCreate = (event: ReactPointerEvent<HTMLImageElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        onSelect(null);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const point = imagePoint(event.clientX, event.clientY, rect, viewRef.current, width, height);
        createRef.current = { startX: point.x, startY: point.y };
        setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
    };

    const beginPan = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 1 || createRef.current) return;
        event.preventDefault();
        panRef.current = { startX: event.clientX, startY: event.clientY, x: viewRef.current.x, y: viewRef.current.y };
        setPanning(true);
    };

    return (
        <div
            ref={containerRef}
            className={`relative w-full select-none overflow-hidden rounded-lg border border-stone-200 bg-stone-950/95 dark:border-stone-800 ${view.zoom > 1 ? (panning ? "cursor-grabbing" : "cursor-grab") : ""}`}
            style={width && height ? { aspectRatio: `${width} / ${height}` } : undefined}
            onPointerDown={beginPan}
            onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
                if (event.button === 1) event.preventDefault();
            }}
        >
            {/* Scale by layout size instead of a CSS transform: a transform-scaled layer keeps its old raster and turns the base image blurry when zoomed in. */}
            <div className="absolute" style={{ left: view.x, top: view.y, width: `${view.zoom * 100}%`, height: `${view.zoom * 100}%` }}>
                <img
                    src={imageUrl}
                    alt=""
                    className="block h-full w-full cursor-crosshair"
                    draggable={false}
                    onPointerDown={(event) => {
                        if (event.button === 0) beginCreate(event);
                    }}
                />
                {elements.map((element) => {
                    const selected = element.id === selectedId;
                    const boxStyle = {
                        left: `${(element.box.x / width) * 100}%`,
                        top: `${(element.box.y / height) * 100}%`,
                        width: `${(element.box.width / width) * 100}%`,
                        height: `${(element.box.height / height) * 100}%`,
                    };
                    return (
                        <div
                            key={element.id}
                            className={`group pointer-events-none absolute border-2 ${selected ? "z-30 border-sky-400 bg-sky-400/10" : "z-10 border-white/70"}`}
                            style={boxStyle}
                        >
                            <span className={`pointer-events-none absolute left-0 top-0 max-w-full -translate-y-full truncate px-1.5 py-0.5 text-[10px] leading-4 ${selected ? "bg-sky-500 text-white" : "bg-black/70 text-white/90"}`}>
                                {element.type === "text" ? <Type className="mr-1 inline size-2.5" /> : element.type === "mask" ? <Eraser className="mr-1 inline size-2.5" /> : null}
                                {element.name}
                            </span>
                            {selected ? (
                                <span
                                    className="pointer-events-auto absolute left-1/2 top-4 z-10 flex size-4 -translate-x-1/2 cursor-move items-center justify-center rounded-full border border-white bg-sky-500 text-white shadow"
                                    title={t("decompose.moveBox")}
                                    onPointerDown={(event) => beginDrag(event, element, "move")}
                                >
                                    <Move className="size-2.5" />
                                </span>
                            ) : null}
                            {selected ? (
                                <>
                                    <span className="pointer-events-auto absolute left-1/2 top-0 h-2 w-5 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" onPointerDown={(event) => beginDrag(event, element, "n")} />
                                    <span className="pointer-events-auto absolute bottom-0 left-1/2 h-2 w-5 -translate-x-1/2 translate-y-1/2 cursor-ns-resize rounded-full border border-white bg-sky-500" onPointerDown={(event) => beginDrag(event, element, "s")} />
                                    <span className="pointer-events-auto absolute left-0 top-1/2 h-5 w-2 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" onPointerDown={(event) => beginDrag(event, element, "w")} />
                                    <span className="pointer-events-auto absolute right-0 top-1/2 h-5 w-2 translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-sky-500" onPointerDown={(event) => beginDrag(event, element, "e")} />
                                </>
                            ) : null}
                            <span className={`pointer-events-auto absolute -left-1 -top-1 size-2.5 cursor-nwse-resize rounded-full border border-white ${selected ? "bg-sky-500" : "bg-stone-400/80"}`} onPointerDown={(event) => beginDrag(event, element, "nw")} />
                            <span className={`pointer-events-auto absolute -right-1 -top-1 size-2.5 cursor-nesw-resize rounded-full border border-white ${selected ? "bg-sky-500" : "bg-stone-400/80"}`} onPointerDown={(event) => beginDrag(event, element, "ne")} />
                            <span className={`pointer-events-auto absolute -bottom-1 -left-1 size-2.5 cursor-nesw-resize rounded-full border border-white ${selected ? "bg-sky-500" : "bg-stone-400/80"}`} onPointerDown={(event) => beginDrag(event, element, "sw")} />
                            <span className={`pointer-events-auto absolute -bottom-1 -right-1 size-2.5 cursor-nwse-resize rounded-full border border-white ${selected ? "bg-sky-500" : "bg-stone-400/80"}`} onPointerDown={(event) => beginDrag(event, element, "se")} />
                        </div>
                    );
                })}
                {draft && draft.width > 0 && draft.height > 0 ? (
                    <div
                        className="pointer-events-none absolute z-40 border-2 border-dashed border-sky-400 bg-sky-400/10"
                        style={{
                            left: `${(draft.x / width) * 100}%`,
                            top: `${(draft.y / height) * 100}%`,
                            width: `${(draft.width / width) * 100}%`,
                            height: `${(draft.height / height) * 100}%`,
                        }}
                    />
                ) : null}
            </div>
        </div>
    );
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function clampView(view: ViewState, rect: DOMRect): ViewState {
    const minX = rect.width - rect.width * view.zoom;
    const minY = rect.height - rect.height * view.zoom;
    return { zoom: view.zoom, x: Math.min(0, Math.max(minX, view.x)), y: Math.min(0, Math.max(minY, view.y)) };
}

function imagePoint(clientX: number, clientY: number, rect: DOMRect, view: ViewState, width: number, height: number) {
    const x = ((clientX - rect.left - view.x) / view.zoom / Math.max(1, rect.width)) * width;
    const y = ((clientY - rect.top - view.y) / view.zoom / Math.max(1, rect.height)) * height;
    return { x: clamp(x, 0, width), y: clamp(y, 0, height) };
}

function computeDragBox(drag: DragState, point: { x: number; y: number }, width: number, height: number): ElementBox {
    const dx = point.x - drag.pointerX;
    const dy = point.y - drag.pointerY;
    const start = drag.startBox;
    const minSize = 8;
    let x = start.x;
    let y = start.y;
    let w = start.width;
    let h = start.height;

    if (drag.mode === "move") {
        x = clamp(start.x + dx, 0, width - start.width);
        y = clamp(start.y + dy, 0, height - start.height);
    } else {
        if (drag.mode === "nw" || drag.mode === "sw" || drag.mode === "w") {
            const right = start.x + start.width;
            x = clamp(start.x + dx, 0, right - minSize);
            w = right - x;
        } else if (drag.mode === "ne" || drag.mode === "se" || drag.mode === "e") {
            w = clamp(start.width + dx, minSize, width - start.x);
        }
        if (drag.mode === "nw" || drag.mode === "ne" || drag.mode === "n") {
            const bottom = start.y + start.height;
            y = clamp(start.y + dy, 0, bottom - minSize);
            h = bottom - y;
        } else if (drag.mode === "sw" || drag.mode === "se" || drag.mode === "s") {
            h = clamp(start.height + dy, minSize, height - start.y);
        }
    }

    return { x: Math.round(x), y: Math.round(y), width: Math.max(minSize, Math.round(w)), height: Math.max(minSize, Math.round(h)) };
}

function boxBetween(startX: number, startY: number, endX: number, endY: number): ElementBox {
    return {
        x: Math.round(Math.min(startX, endX)),
        y: Math.round(Math.min(startY, endY)),
        width: Math.round(Math.abs(endX - startX)),
        height: Math.round(Math.abs(endY - startY)),
    };
}
