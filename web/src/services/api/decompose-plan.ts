import { requestImageQuestion } from "@/services/api/image";
import type { AiConfig } from "@/stores/use-config-store";

export const MAX_ANALYZE_ELEMENTS = 30;

export type ImageElementPlan = {
    name: string;
    description: string;
    type: "image" | "text";
    /** Normalized 0-1000 box: x1, y1, x2, y2. */
    box: { x1: number; y1: number; x2: number; y2: number };
};

const SYSTEM_PROMPT = [
    "你是 UI 图像分层分析助手。",
    "分析用户提供的效果图，找出所有可见的独立元素，供后续分层导出使用。",
    "只输出严格 JSON，不要输出解释、Markdown 或代码块。",
].join("\n");

const USER_PROMPT = [
    "请识别这张图片中的所有可见元素，输出以下 JSON：",
    '{"elements":[{"name":"元素名称","description":"元素外观描述","type":"image","box":[x1,y1,x2,y2]}]}',
    "要求：",
    "1. box 使用 0-1000 的相对坐标，依次是左上角 x、左上角 y、右下角 x、右下角 y，尽量紧贴元素边界。",
    "2. 同时包含容器和子元素，例如按钮和按钮内部的图标需要分别列成两行。",
    "3. 文字元素使用 type=text，name 写识别到的文字内容（最多 20 字）。",
    "4. 非文字元素使用 type=image。",
    `5. 最多输出 ${MAX_ANALYZE_ELEMENTS} 个元素，不要重复，忽略纯装饰性的阴影和噪点。`,
    "6. 按照从底层到上层的视觉顺序排列。",
].join("\n");

export async function analyzeImageElements(config: AiConfig, imageDataUrl: string, signal?: AbortSignal): Promise<ImageElementPlan[]> {
    const text = await requestImageQuestion(
        config,
        [
            { role: "system", content: SYSTEM_PROMPT },
            {
                role: "user",
                content: [
                    { type: "text", text: USER_PROMPT },
                    { type: "image_url", image_url: { url: imageDataUrl } },
                ],
            },
        ],
        () => undefined,
        { signal },
    );
    return parseElementPlan(text);
}

export function parseElementPlan(value: string): ImageElementPlan[] {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("The model did not return a JSON object");

    let data: unknown;
    try {
        data = JSON.parse(value.slice(start, end + 1));
    } catch {
        throw new Error("The model returned invalid JSON");
    }

    const record = data as { elements?: unknown };
    const rawElements = Array.isArray(record.elements) ? record.elements.slice(0, MAX_ANALYZE_ELEMENTS) : [];
    const elements: ImageElementPlan[] = [];

    rawElements.forEach((item, index) => {
        if (!item || typeof item !== "object") return;
        const element = item as { name?: unknown; description?: unknown; type?: unknown; box?: unknown };
        if (!Array.isArray(element.box) || element.box.length < 4) return;

        const numbers = element.box.map((part) => Number(part));
        if (numbers.some((part) => !Number.isFinite(part))) return;
        const scale = Math.max(...numbers) <= 1.5 ? 1000 : 1;
        const x1 = clamp(numbers[0] * scale, 0, 1000);
        const y1 = clamp(numbers[1] * scale, 0, 1000);
        const x2 = clamp(numbers[2] * scale, 0, 1000);
        const y2 = clamp(numbers[3] * scale, 0, 1000);
        if (x2 - x1 < 4 || y2 - y1 < 4) return;

        const name = typeof element.name === "string" && element.name.trim() ? element.name.trim().slice(0, 40) : `Element ${index + 1}`;
        const description = typeof element.description === "string" && element.description.trim() ? element.description.trim().slice(0, 300) : name;
        const type = typeof element.type === "string" && /text|文字|字体|font/i.test(element.type) ? "text" : "image";
        const next: ImageElementPlan = { name, description, type, box: { x1, y1, x2, y2 } };

        // Drop near-identical boxes produced by some vision models.
        if (elements.some((existing) => intersectionOverUnion(existing.box, next.box) > 0.92)) return;
        elements.push(next);
    });

    if (!elements.length) throw new Error("No elements were detected");
    return elements;
}

function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value));
}

function intersectionOverUnion(a: ImageElementPlan["box"], b: ImageElementPlan["box"]) {
    const intersectionWidth = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
    const intersectionHeight = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
    const intersection = intersectionWidth * intersectionHeight;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return intersection / Math.max(1, areaA + areaB - intersection);
}
