import { saveAs } from "file-saver";

import { imageSizePresets } from "@/lib/media-size";
import { createZip } from "@/lib/zip";
import type { UploadedImage } from "@/services/image-storage";

export const MAX_DECOMPOSE_EDGE = 4096;
export const MAX_DECOMPOSE_AI_EDGE = 2048;

export type ElementBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

export type DecomposeElementType = "image" | "text" | "mask";
export type DecomposeResolution = "1k" | "2k";

export type DecomposeElement = {
    id: string;
    name: string;
    description: string;
    type: DecomposeElementType;
    resolution: DecomposeResolution;
    box: ElementBox;
    parentId: string | null;
};

export type ExtractedLayer = {
    elementId: string;
    width: number;
    height: number;
    canvas: HTMLCanvasElement;
    blob: Blob;
    uploaded: UploadedImage;
};

export type DecomposeCacheLayer = {
    elementId: string;
    storageKey?: string;
    width: number;
    height: number;
};

export type DecomposeCache = {
    width: number;
    height: number;
    elements: DecomposeElement[];
    layers: DecomposeCacheLayer[];
    offsets: Record<string, { dx: number; dy: number }>;
    baseStorageKey?: string;
    sourceNodeId?: string;
    textModel?: string;
    imageModel?: string;
};

export type DecomposeExportPayload = {
    sourceNodeId: string;
    cache: DecomposeCache;
    baseBlob: Blob;
};

export type LayerExportEntry = {
    name: string;
    blob: Blob;
};

export function createCanvas(width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

export async function loadImage(url: string) {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    await image.decode();
    return image;
}

export function fitWorkingSize(width: number, height: number) {
    const longEdge = Math.max(width, height);
    if (longEdge <= MAX_DECOMPOSE_EDGE) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    const scale = MAX_DECOMPOSE_EDGE / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function fitAiSize(width: number, height: number) {
    const longEdge = Math.max(width, height);
    if (longEdge <= MAX_DECOMPOSE_AI_EDGE) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
    const scale = MAX_DECOMPOSE_AI_EDGE / longEdge;
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Always request a square canvas: the element keeps its own aspect inside it and the transparent margins are trimmed away afterwards. */
export function getElementRequestSize(resolution: DecomposeResolution) {
    return imageSizePresets[resolution]["1:1"];
}

export function drawToSize(source: CanvasImageSource, width: number, height: number) {
    const canvas = createCanvas(width, height);
    canvas.getContext("2d")!.drawImage(source, 0, 0, width, height);
    return canvas;
}

function cropToContent(canvas: HTMLCanvasElement, alphaThreshold: number) {
    const { width, height } = canvas;
    const data = canvas.getContext("2d")!.getImageData(0, 0, width, height).data;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (data[(y * width + x) * 4 + 3] <= alphaThreshold) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            bottom = y;
        }
    }
    if (right < left || bottom < top) return null;
    if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1) return canvas;
    const trimmed = createCanvas(right - left + 1, bottom - top + 1);
    trimmed.getContext("2d")!.drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    return trimmed;
}

/** Crop the transparent margins some models add when the requested aspect differs from the element. */
export function trimTransparent(source: HTMLImageElement | HTMLCanvasElement, alphaThreshold = 8) {
    const width = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const height = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
    return cropToContent(drawToSize(source, width, height), alphaThreshold);
}

function hasTransparentPixel(data: Uint8ClampedArray, alphaThreshold: number) {
    for (let index = 3; index < data.length; index += 4) if (data[index] <= alphaThreshold) return true;
    return false;
}

/** Models that ignore `background: transparent` paint the element on a backdrop; sample the canvas borders to see if it is one flat color. */
function readBorderColor(data: Uint8ClampedArray, width: number, height: number, alphaThreshold: number) {
    const samples: Array<[number, number, number]> = [];
    const push = (x: number, y: number) => {
        const offset = (y * width + x) * 4;
        if (data[offset + 3] <= alphaThreshold) return;
        samples.push([data[offset], data[offset + 1], data[offset + 2]]);
    };
    for (let x = 0; x < width; x += 1) {
        push(x, 0);
        push(x, height - 1);
    }
    for (let y = 0; y < height; y += 1) {
        push(0, y);
        push(width - 1, y);
    }
    if (!samples.length) return null;
    const median = (index: 0 | 1 | 2) => {
        const values = samples.map((sample) => sample[index]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)];
    };
    const color: [number, number, number] = [median(0), median(1), median(2)];
    const deviations = samples.map((sample) => Math.max(Math.abs(sample[0] - color[0]), Math.abs(sample[1] - color[1]), Math.abs(sample[2] - color[2]))).sort((a, b) => a - b);
    return { color, spread: deviations[Math.floor(deviations.length * 0.9)] };
}

/** Only the border-connected region is keyed out, so dark artwork inside the element is never eaten. */
function keyOutColor(data: Uint8ClampedArray, width: number, height: number, color: [number, number, number], tolerance: number) {
    const visited = new Uint8Array(width * height);
    const stack: number[] = [];
    const enqueue = (x: number, y: number) => {
        const index = y * width + x;
        if (visited[index]) return;
        const offset = index * 4;
        if (data[offset + 3] <= 8) return;
        if (Math.abs(data[offset] - color[0]) > tolerance) return;
        if (Math.abs(data[offset + 1] - color[1]) > tolerance) return;
        if (Math.abs(data[offset + 2] - color[2]) > tolerance) return;
        visited[index] = 1;
        stack.push(index);
    };
    for (let x = 0; x < width; x += 1) {
        enqueue(x, 0);
        enqueue(x, height - 1);
    }
    for (let y = 0; y < height; y += 1) {
        enqueue(0, y);
        enqueue(width - 1, y);
    }
    while (stack.length) {
        const index = stack.pop()!;
        data[index * 4 + 3] = 0;
        const x = index % width;
        const y = (index - x) / width;
        if (x > 0) enqueue(x - 1, y);
        if (x < width - 1) enqueue(x + 1, y);
        if (y > 0) enqueue(x, y - 1);
        if (y < height - 1) enqueue(x, y + 1);
    }
}

/** Soften the hard key edge inward by one pixel: background pixels stay clear so no dark fringe is left around the layer. */
function featherAlpha(data: Uint8ClampedArray, width: number, height: number) {
    const alpha = new Uint8ClampedArray(width * height);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = data[index * 4 + 3];
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const index = y * width + x;
            if (alpha[index] !== 255) continue;
            let edge = false;
            let sum = 0;
            for (let dy = -1; dy <= 1; dy += 1) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    const neighbor = alpha[index + dy * width + dx];
                    if (neighbor !== 255) edge = true;
                    sum += neighbor;
                }
            }
            if (edge) data[index * 4 + 3] = Math.round(sum / 9);
        }
    }
}

/**
 * Trim a generated layer that may come back either with alpha or painted on a flat backdrop
 * (some models ignore `background: transparent` and return an opaque black/white canvas).
 */
export function trimByBackground(source: HTMLImageElement | HTMLCanvasElement, alphaThreshold = 8, colorTolerance = 16) {
    const width = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
    const height = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;
    const canvas = drawToSize(source, width, height);
    const context = canvas.getContext("2d")!;
    const image = context.getImageData(0, 0, width, height);
    if (!hasTransparentPixel(image.data, alphaThreshold)) {
        const border = readBorderColor(image.data, width, height, alphaThreshold);
        // A scattered border means the element touches the edge or a scene sits behind it; keying would damage the artwork.
        if (border && border.spread <= colorTolerance * 1.5) {
            keyOutColor(image.data, width, height, border.color, Math.max(colorTolerance, border.spread + 8));
            featherAlpha(image.data, width, height);
            context.putImageData(image, 0, 0);
        }
    }
    return cropToContent(canvas, alphaThreshold);
}

export function boxArea(box: ElementBox) {
    return Math.max(0, box.width) * Math.max(0, box.height);
}

export function containsBox(outer: ElementBox, inner: ElementBox) {
    const tolerance = 2;
    return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance && inner.x + inner.width <= outer.x + outer.width + tolerance && inner.y + inner.height <= outer.y + outer.height + tolerance;
}

/** The smallest containing element becomes the parent, which reproduces nested UI structure (button > icon). */
export function assignElementParents(elements: DecomposeElement[]) {
    return elements.map((element) => {
        let parent: DecomposeElement | null = null;
        for (const candidate of elements) {
            if (candidate.id === element.id) continue;
            if (!containsBox(candidate.box, element.box)) continue;
            if (boxArea(candidate.box) <= boxArea(element.box)) continue;
            if (!parent || boxArea(candidate.box) < boxArea(parent.box)) parent = candidate;
        }
        return { ...element, parentId: parent?.id ?? null };
    });
}

export function buildChildrenMap(elements: DecomposeElement[]) {
    const byParent = new Map<string, DecomposeElement[]>();
    const ids = new Set(elements.map((element) => element.id));
    for (const element of elements) {
        const parentId = element.parentId && ids.has(element.parentId) && element.parentId !== element.id ? element.parentId : null;
        const list = byParent.get(parentId || "") || [];
        list.push(element);
        byParent.set(parentId || "", list);
    }
    for (const list of byParent.values()) list.sort((a, b) => boxArea(b.box) - boxArea(a.box));
    return byParent;
}

export function flattenElementTree(elements: DecomposeElement[]) {
    const children = buildChildrenMap(elements);
    const visited = new Set<string>();
    const rows: Array<{ element: DecomposeElement; depth: number }> = [];
    const walk = (element: DecomposeElement, depth: number) => {
        if (visited.has(element.id)) return;
        visited.add(element.id);
        rows.push({ element, depth });
        for (const child of children.get(element.id) || []) walk(child, depth + 1);
    };
    for (const root of children.get("") || []) walk(root, 0);
    for (const element of elements) if (!visited.has(element.id)) walk(element, 0);
    return rows;
}

export function getElementDepth(elements: DecomposeElement[], id: string) {
    const byId = new Map(elements.map((element) => [element.id, element]));
    let depth = 0;
    let current = byId.get(id);
    const visited = new Set<string>();
    while (current?.parentId && byId.has(current.parentId) && !visited.has(current.id)) {
        visited.add(current.id);
        current = byId.get(current.parentId);
        depth += 1;
    }
    return depth;
}

export function getDescendantElements(elements: DecomposeElement[], id: string) {
    const children = buildChildrenMap(elements);
    const result: DecomposeElement[] = [];
    const visited = new Set<string>();
    const walk = (elementId: string) => {
        for (const child of children.get(elementId) || []) {
            if (visited.has(child.id)) continue;
            visited.add(child.id);
            result.push(child);
            walk(child.id);
        }
    };
    walk(id);
    return result;
}

export function isElementDescendant(elements: DecomposeElement[], ancestorId: string, id: string) {
    return getDescendantElements(elements, ancestorId).some((element) => element.id === id);
}

/** Children must be extracted before their parent so the parent can mask them out. */
export function getElementExtractionOrder(elements: DecomposeElement[]) {
    const children = buildChildrenMap(elements);
    const visited = new Set<string>();
    const ordered: DecomposeElement[] = [];
    const walk = (element: DecomposeElement) => {
        if (visited.has(element.id)) return;
        visited.add(element.id);
        for (const child of children.get(element.id) || []) walk(child);
        ordered.push(element);
    };
    for (const root of children.get("") || []) walk(root);
    for (const element of elements) if (!visited.has(element.id)) walk(element);
    return ordered;
}

export function createElementPreviewDataUrl(image: HTMLImageElement | HTMLCanvasElement, element: DecomposeElement, descendants: DecomposeElement[], maxEdge = 560) {
    const box = element.box;
    if (box.width <= 0 || box.height <= 0) return "";
    const scale = Math.min(1, maxEdge / Math.max(box.width, box.height));
    const width = Math.max(1, Math.round(box.width * scale));
    const height = Math.max(1, Math.round(box.height * scale));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0b0b0c";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, box.x, box.y, box.width, box.height, 0, 0, width, height);

    context.fillStyle = "#000";
    for (const child of descendants) {
        context.fillRect((child.box.x - box.x) * scale, (child.box.y - box.y) * scale, child.box.width * scale, child.box.height * scale);
    }
    return canvas.toDataURL("image/jpeg", 0.86);
}

export function cropBox(source: HTMLCanvasElement | HTMLImageElement, box: ElementBox) {
    const canvas = createCanvas(box.width, box.height);
    canvas.getContext("2d")!.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height);
    return canvas;
}

export async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Failed to encode PNG"))), "image/png");
    });
}

export function sanitizeFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 60) || "layer";
}

export async function downloadZip(entries: LayerExportEntry[], fileName: string) {
    const zip = await createZip(entries.map((entry) => ({ name: entry.name, data: entry.blob })));
    saveAs(zip, fileName);
}

export async function downloadLayerZip(entries: LayerExportEntry[], fileBase: string) {
    await downloadZip(entries, `${sanitizeFileName(fileBase)}-layers.zip`);
}

export function downloadJson(value: unknown, fileBase: string) {
    saveAs(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), `${sanitizeFileName(fileBase)}-layers.json`);
}

export function buildDecomposeExport(cache: DecomposeCache) {
    const order = getElementExtractionOrder(cache.elements);
    const indexMap = new Map(order.map((element, index) => [element.id, index + 1]));
    const layerIds = new Set((cache.layers || []).map((layer) => layer.elementId));
    const fileById = new Map<string, string>();
    order.forEach((element, index) => {
        if (element.type !== "image" || !layerIds.has(element.id)) return;
        fileById.set(element.id, `layers/${String(index + 1).padStart(2, "0")}-${sanitizeFileName(element.name)}.png`);
    });
    const json = {
        version: 1,
        image: { width: cache.width, height: cache.height },
        base: "base.png",
        elements: order.map((element) => {
            const offset = (cache.offsets || {})[element.id] || { dx: 0, dy: 0 };
            return {
                id: element.id,
                name: element.name,
                text: element.type === "text" ? element.name : null,
                description: element.description,
                type: element.type,
                parentId: element.parentId,
                depth: getElementDepth(cache.elements, element.id),
                order: indexMap.get(element.id),
                box: {
                    x: Math.round(element.box.x + offset.dx),
                    y: Math.round(element.box.y + offset.dy),
                    width: Math.round(element.box.width),
                    height: Math.round(element.box.height),
                },
                image: fileById.get(element.id) || null,
            };
        }),
    };
    return { json, fileById };
}
