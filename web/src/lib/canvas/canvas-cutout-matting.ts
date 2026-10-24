import type { ReferenceImage } from "@/types/image";

import { MAX_DECOMPOSE_AI_EDGE } from "./canvas-decompose";
import { loadImage, type ImageCropRect } from "./canvas-image-data";

export type CutoutRegion = {
    rect?: ImageCropRect;
    fgMaskDataUrl?: string;
    bgMaskDataUrl?: string;
};

export type CutoutMatte = {
    dataUrl: string;
    box: { x: number; y: number; width: number; height: number };
};

// 本地抠图在缩小后的分析图上计算，最后只把 alpha 放回原图，避免大图卡顿。
const ANALYSIS_LONG_EDGE = 1024;
const EDGE_COLOR_WEIGHT = 8;
// 框选模式从选区外的背景向内泛洪，颜色差超过该值就视为图案边缘，并把这圈像素一起挡住。
const EDGE_BARRIER_THRESHOLD = 48;
const BORDER_SEED_PX = 2;
const ALPHA_FLOOR = 0.06;
const ALPHA_CEIL = 0.94;
const GUIDE_RADIUS = 4;
const GUIDE_EPSILON = 1e-4;
const CUTOUT_MARKER_COLOR = "#ff00ff";
const MAX_EDGE_COST = 1 + EDGE_COLOR_WEIGHT * 3;
const UNREACHABLE = 0x7fffffff;

type SeedLabels = Uint8Array; // 0 unknown, 1 foreground seed, 2 background seed
type PixelBox = { x: number; y: number; width: number; height: number };

/** 一次处理多个选区：原图只解码和分析一次，每个选区各自生成一张透明 PNG。 */
export async function cutoutMattes(dataUrl: string, regions: CutoutRegion[]): Promise<(CutoutMatte | null)[]> {
    if (!regions.length) return [];
    const image = await loadImage(dataUrl);
    const scale = Math.min(1, ANALYSIS_LONG_EDGE / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const small = drawToSize(image, width, height);
    const data = small.getContext("2d")!.getImageData(0, 0, width, height).data;

    const results: (CutoutMatte | null)[] = [];
    for (const region of regions) {
        let alpha: Float32Array | null = null;
        if (region.rect) {
            const box = toPixelBox(region.rect, width, height);
            if (box && box.width >= 2 && box.height >= 2) alpha = rectAlpha(data, width, height, box);
        } else {
            const labels = await buildBrushSeeds(data, width, height, region);
            if (labels) {
                const computed = computeAlpha(data, width, height, labels);
                keepConnectedToSeeds(computed, labels, width, height);
                alpha = computed;
            }
        }
        results.push(alpha ? composeMatte(image, upscaleAlpha(smoothAlpha(data, alpha, width, height), width, height, image.width, image.height)) : null);
    }
    return results;
}

/**
 * 生成 AI 修补用的两张参考图：图 1 是本地结果铺品红底，图 2 是同一区域的原图。
 * 图 2 供模型补回被误删的边缘细节，图 1 告诉模型当前哪些区域已判为背景。
 */
export async function buildCutoutRepairReferences(originalDataUrl: string, matte: CutoutMatte) {
    const source = await loadImage(originalDataUrl);
    const cutout = await loadImage(matte.dataUrl);
    const pad = Math.max(24, Math.round(Math.max(matte.box.width, matte.box.height) * 0.06));
    const x = clamp(matte.box.x - pad, 0, Math.max(0, source.width - 1));
    const y = clamp(matte.box.y - pad, 0, Math.max(0, source.height - 1));
    const right = clamp(matte.box.x + matte.box.width + pad, x + 1, source.width);
    const bottom = clamp(matte.box.y + matte.box.height + pad, y + 1, source.height);
    const scale = Math.min(1, MAX_DECOMPOSE_AI_EDGE / Math.max(right - x, bottom - y));
    const width = Math.max(1, Math.round((right - x) * scale));
    const height = Math.max(1, Math.round((bottom - y) * scale));

    const marked = document.createElement("canvas");
    marked.width = width;
    marked.height = height;
    const markedContext = marked.getContext("2d")!;
    markedContext.fillStyle = CUTOUT_MARKER_COLOR;
    markedContext.fillRect(0, 0, width, height);
    markedContext.drawImage(cutout, (matte.box.x - x) * scale, (matte.box.y - y) * scale, matte.box.width * scale, matte.box.height * scale);

    const original = document.createElement("canvas");
    original.width = width;
    original.height = height;
    original.getContext("2d")!.drawImage(source, x, y, right - x, bottom - y, 0, 0, width, height);

    const references: ReferenceImage[] = [
        { id: "cutout-matte", name: "cutout-matte.png", type: "image/png", dataUrl: marked.toDataURL("image/png") },
        { id: "cutout-original", name: "cutout-original.png", type: "image/png", dataUrl: original.toDataURL("image/png") },
    ];
    return { references, box: matte.box };
}

/**
 * 框选模式：把选区外和图片最外圈当作背景种子，向选区内泛洪。
 * 泛洪不会越过颜色突变（图案边缘），所以被轮廓围住的按钮内部、文字都保持不透明，
 * 而选区里与外部背景连通的部分会被剔除。泛洪覆盖不到的区域再按是否与选区相交筛选。
 */
function rectAlpha(data: Uint8ClampedArray, width: number, height: number, box: PixelBox) {
    const visited = floodBackground(data, width, height, box);
    const components = new Int32Array(width * height).fill(-1);
    const keep: boolean[] = [];
    const queue: number[] = [];
    for (let start = 0; start < components.length; start += 1) {
        if (visited[start] || components[start] !== -1) continue;
        const id = keep.length;
        let overlap = 0;
        components[start] = id;
        queue.length = 0;
        queue.push(start);
        for (let head = 0; head < queue.length; head += 1) {
            const index = queue[head];
            const x = index % width;
            const y = (index - x) / width;
            if (isInside(x, y, box)) overlap += 1;
            const visit = (next: number) => {
                if (visited[next] || components[next] !== -1) return;
                components[next] = id;
                queue.push(next);
            };
            if (x > 0) visit(index - 1);
            if (y > 0) visit(index - width);
            if (x + 1 < width) visit(index + 1);
            if (y + 1 < height) visit(index + width);
        }
        keep.push(overlap > 0);
    }

    const alpha = new Float32Array(width * height);
    let subject = false;
    for (let index = 0; index < alpha.length; index += 1) {
        const id = components[index];
        if (id >= 0 && keep[id]) {
            alpha[index] = 1;
            subject = true;
        }
    }
    return subject ? alpha : fallbackRectAlpha(width, height, box);
}

function floodBackground(data: Uint8ClampedArray, width: number, height: number, box: PixelBox) {
    const barrier = buildBarrier(data, width, height);
    const visited = new Uint8Array(width * height);
    const queue: number[] = [];
    const seed = (index: number) => {
        if (visited[index]) return;
        visited[index] = 1;
        queue.push(index);
    };
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (data[index * 4 + 3] < 16 || !isInside(x, y, box) || isBorder(x, y, width, height)) seed(index);
        }
    }
    const transparent = (index: number) => data[index * 4 + 3] < 16;
    for (let head = 0; head < queue.length; head += 1) {
        const index = queue[head];
        const x = index % width;
        const y = (index - x) / width;
        const visit = (next: number) => {
            if (visited[next] || barrier[next] || transparent(next) !== transparent(index)) return;
            visited[next] = 1;
            queue.push(next);
        };
        if (x > 0) visit(index - 1);
        if (y > 0) visit(index - width);
        if (x + 1 < width) visit(index + 1);
        if (y + 1 < height) visit(index + width);
    }
    return visited;
}

/** 把强边缘两侧的像素都标成障碍，细边框上的小缺口也会被两侧的边缘一起封住。 */
function buildBarrier(data: Uint8ClampedArray, width: number, height: number) {
    const barrier = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (x + 1 < width && colorDifference(data, index, index + 1) > EDGE_BARRIER_THRESHOLD) {
                barrier[index] = 1;
                barrier[index + 1] = 1;
            }
            if (y + 1 < height && colorDifference(data, index, index + width) > EDGE_BARRIER_THRESHOLD) {
                barrier[index] = 1;
                barrier[index + width] = 1;
            }
        }
    }
    return barrier;
}

/** 图案边缘太弱导致泛洪把主体也覆盖时，退化为直接保留选区内部，避免抠出空图。 */
function fallbackRectAlpha(width: number, height: number, box: PixelBox) {
    const alpha = new Float32Array(width * height);
    for (let y = box.y; y < box.y + box.height; y += 1) {
        for (let x = box.x; x < box.x + box.width; x += 1) {
            if (!isBorder(x, y, width, height)) alpha[y * width + x] = 1;
        }
    }
    return alpha;
}

async function buildBrushSeeds(data: Uint8ClampedArray, width: number, height: number, region: CutoutRegion): Promise<SeedLabels | null> {
    const labels: SeedLabels = new Uint8Array(width * height);
    const foregroundMask = await readMask(region.fgMaskDataUrl, width, height);
    if (!foregroundMask) return null;
    const backgroundMask = await readMask(region.bgMaskDataUrl, width, height);
    for (let index = 0; index < labels.length; index += 1) {
        if (foregroundMask[index * 4 + 3] > 127) labels[index] = 1;
        if (backgroundMask && backgroundMask[index * 4 + 3] > 127) labels[index] = 2;
    }
    if (!labels.includes(1)) return null;
    for (let index = 0; index < labels.length; index += 1) if (data[index * 4 + 3] < 16) labels[index] = 2;
    markBorder(labels, width, height);
    return labels;
}

function computeAlpha(data: Uint8ClampedArray, width: number, height: number, labels: SeedLabels) {
    const distanceToForeground = dijkstra(data, width, height, labels, 1);
    const distanceToBackground = dijkstra(data, width, height, labels, 2);
    const alpha = new Float32Array(width * height);
    for (let index = 0; index < alpha.length; index += 1) {
        const total = distanceToForeground[index] + distanceToBackground[index];
        alpha[index] = total > 0 ? distanceToBackground[index] / total : labels[index] === 1 ? 1 : 0;
    }
    return alpha;
}

/** 多源 Dijkstra，整数边权配循环桶队列；颜色突变处的代价更高，因此边界会停在图案轮廓上。 */
function dijkstra(data: Uint8ClampedArray, width: number, height: number, labels: SeedLabels, seed: number) {
    const size = width * height;
    const distances = new Int32Array(size).fill(UNREACHABLE);
    const bucketCount = MAX_EDGE_COST + 1;
    const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
    let pending = 0;
    const push = (index: number, distance: number) => {
        distances[index] = distance;
        buckets[distance % bucketCount].push(index);
        pending += 1;
    };
    for (let index = 0; index < size; index += 1) if (labels[index] === seed) push(index, 0);
    let current = 0;
    while (pending > 0) {
        while (!buckets[current % bucketCount].length) current += 1;
        const bucket = buckets[current % bucketCount];
        const index = bucket.pop()!;
        pending -= 1;
        if (distances[index] !== current) continue;
        const x = index % width;
        const y = (index - x) / width;
        const relax = (next: number) => {
            const distance = current + edgeCost(data, index, next);
            if (distance >= distances[next]) return;
            distances[next] = distance;
            buckets[distance % bucketCount].push(next);
            pending += 1;
        };
        if (x > 0) relax(index - 1);
        if (y > 0) relax(index - width);
        if (x + 1 < width) relax(index + 1);
        if (y + 1 < height) relax(index + width);
    }
    return distances;
}

function edgeCost(data: Uint8ClampedArray, from: number, to: number) {
    return 1 + Math.round((EDGE_COLOR_WEIGHT * colorDifference(data, from, to)) / 255);
}

function colorDifference(data: Uint8ClampedArray, from: number, to: number) {
    const offset = from * 4;
    const nextOffset = to * 4;
    return Math.abs(data[offset] - data[nextOffset]) + Math.abs(data[offset + 1] - data[nextOffset + 1]) + Math.abs(data[offset + 2] - data[nextOffset + 2]);
}

function smoothAlpha(data: Uint8ClampedArray, alpha: Float32Array, width: number, height: number) {
    const guide = new Float32Array(width * height);
    for (let index = 0; index < guide.length; index += 1) {
        const offset = index * 4;
        guide[index] = (data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114) / 255;
    }
    const filtered = guidedFilter(guide, alpha, width, height, GUIDE_RADIUS, GUIDE_EPSILON);
    for (let index = 0; index < filtered.length; index += 1) {
        const value = clamp(filtered[index], 0, 1);
        filtered[index] = value < ALPHA_FLOOR ? 0 : value > ALPHA_CEIL ? 1 : value;
    }
    return filtered;
}

/** 涂抹模式只保留与前景种子连通的前景块，去掉零散误判。 */
function keepConnectedToSeeds(alpha: Float32Array, labels: SeedLabels, width: number, height: number) {
    const keep = new Uint8Array(alpha.length);
    const queue: number[] = [];
    for (let index = 0; index < alpha.length; index += 1) {
        if (labels[index] === 1 && alpha[index] >= 0.5 && !keep[index]) {
            keep[index] = 1;
            queue.push(index);
        }
    }
    for (let head = 0; head < queue.length; head += 1) {
        const index = queue[head];
        const x = index % width;
        const y = (index - x) / width;
        const visit = (next: number) => {
            if (keep[next] || alpha[next] < 0.5) return;
            keep[next] = 1;
            queue.push(next);
        };
        if (x > 0) visit(index - 1);
        if (y > 0) visit(index - width);
        if (x + 1 < width) visit(index + 1);
        if (y + 1 < height) visit(index + width);
    }
    for (let index = 0; index < alpha.length; index += 1) if (alpha[index] >= 0.5 && !keep[index]) alpha[index] = 0;
}

function guidedFilter(guide: Float32Array, source: Float32Array, width: number, height: number, radius: number, epsilon: number) {
    const size = width * height;
    const meanGuide = boxMean(guide, width, height, radius);
    const meanSource = boxMean(source, width, height, radius);
    const squaredGuide = new Float32Array(size);
    const crossed = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
        squaredGuide[index] = guide[index] * guide[index];
        crossed[index] = guide[index] * source[index];
    }
    const meanSquaredGuide = boxMean(squaredGuide, width, height, radius);
    const meanCrossed = boxMean(crossed, width, height, radius);
    const scale = new Float32Array(size);
    const offset = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
        const variance = meanSquaredGuide[index] - meanGuide[index] * meanGuide[index];
        const covariance = meanCrossed[index] - meanGuide[index] * meanSource[index];
        scale[index] = covariance / (variance + epsilon);
        offset[index] = meanSource[index] - scale[index] * meanGuide[index];
    }
    const meanScale = boxMean(scale, width, height, radius);
    const meanOffset = boxMean(offset, width, height, radius);
    const output = new Float32Array(size);
    for (let index = 0; index < size; index += 1) output[index] = meanScale[index] * guide[index] + meanOffset[index];
    return output;
}

function boxMean(source: Float32Array, width: number, height: number, radius: number) {
    const stride = width + 1;
    const integral = new Float64Array(stride * (height + 1));
    for (let y = 0; y < height; y += 1) {
        let row = 0;
        for (let x = 0; x < width; x += 1) {
            row += source[y * width + x];
            integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row;
        }
    }
    const output = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const top = Math.max(0, y - radius);
        const bottom = Math.min(height - 1, y + radius);
        for (let x = 0; x < width; x += 1) {
            const left = Math.max(0, x - radius);
            const right = Math.min(width - 1, x + radius);
            const sum = integral[(bottom + 1) * stride + right + 1] - integral[top * stride + right + 1] - integral[(bottom + 1) * stride + left] + integral[top * stride + left];
            output[y * width + x] = sum / ((right - left + 1) * (bottom - top + 1));
        }
    }
    return output;
}

function upscaleAlpha(alpha: Float32Array, width: number, height: number, targetWidth: number, targetHeight: number) {
    const small = document.createElement("canvas");
    small.width = width;
    small.height = height;
    const smallContext = small.getContext("2d")!;
    const imageData = smallContext.createImageData(width, height);
    for (let index = 0; index < alpha.length; index += 1) {
        const value = Math.round(alpha[index] * 255);
        imageData.data[index * 4] = value;
        imageData.data[index * 4 + 1] = value;
        imageData.data[index * 4 + 2] = value;
        imageData.data[index * 4 + 3] = 255;
    }
    smallContext.putImageData(imageData, 0, 0);
    if (width === targetWidth && height === targetHeight) return imageData;
    const target = document.createElement("canvas");
    target.width = targetWidth;
    target.height = targetHeight;
    const targetContext = target.getContext("2d")!;
    targetContext.imageSmoothingEnabled = true;
    targetContext.imageSmoothingQuality = "high";
    targetContext.drawImage(small, 0, 0, targetWidth, targetHeight);
    return targetContext.getImageData(0, 0, targetWidth, targetHeight);
}

function composeMatte(image: HTMLImageElement, alpha: ImageData): CutoutMatte | null {
    const width = image.width;
    const height = image.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const frame = context.getImageData(0, 0, width, height);
    const pixels = frame.data;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
            const value = border ? 0 : Math.min(alpha.data[index * 4], pixels[index * 4 + 3]);
            pixels[index * 4 + 3] = value;
            if (value <= 8) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            bottom = y;
        }
    }
    if (right < left || bottom < top) return null;
    context.putImageData(frame, 0, 0);
    const trimmed = document.createElement("canvas");
    trimmed.width = right - left + 1;
    trimmed.height = bottom - top + 1;
    trimmed.getContext("2d")!.drawImage(canvas, left, top, trimmed.width, trimmed.height, 0, 0, trimmed.width, trimmed.height);
    return { dataUrl: trimmed.toDataURL("image/png"), box: { x: left, y: top, width: trimmed.width, height: trimmed.height } };
}

async function readMask(dataUrl: string | undefined, width: number, height: number) {
    if (!dataUrl) return null;
    const mask = await loadImage(dataUrl);
    return drawToSize(mask, width, height).getContext("2d")!.getImageData(0, 0, width, height).data;
}

function drawToSize(source: CanvasImageSource, width: number, height: number) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, width, height);
    return canvas;
}

function toPixelBox(rect: ImageCropRect, width: number, height: number): PixelBox | null {
    const x = clamp(Math.round(rect.x * width), 0, width - 1);
    const y = clamp(Math.round(rect.y * height), 0, height - 1);
    return {
        x,
        y,
        width: clamp(Math.round(rect.width * width), 1, width - x),
        height: clamp(Math.round(rect.height * height), 1, height - y),
    };
}

function markBorder(labels: SeedLabels, width: number, height: number) {
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            if (x < BORDER_SEED_PX || y < BORDER_SEED_PX || x >= width - BORDER_SEED_PX || y >= height - BORDER_SEED_PX) labels[y * width + x] = 2;
        }
    }
}

function isBorder(x: number, y: number, width: number, height: number) {
    return x < BORDER_SEED_PX || y < BORDER_SEED_PX || x >= width - BORDER_SEED_PX || y >= height - BORDER_SEED_PX;
}

function isInside(x: number, y: number, box: PixelBox) {
    return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}
