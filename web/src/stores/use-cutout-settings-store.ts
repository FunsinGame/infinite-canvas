import { create } from "zustand";
import { persist } from "zustand/middleware";

import { defaultCutoutParams, type CutoutParams } from "@/lib/canvas/canvas-cutout-matting";

export type CutoutBackground = "transparent" | "black" | "white" | "green";

type CutoutSettingsState = {
    params: CutoutParams;
    background: CutoutBackground;
    updateParams: (patch: Partial<CutoutParams>) => void;
    resetParams: () => void;
    setBackground: (background: CutoutBackground) => void;
};

const defaultBackground: CutoutBackground = "transparent";
const backgrounds: CutoutBackground[] = ["transparent", "black", "white", "green"];

function isCutoutBackground(value: unknown): value is CutoutBackground {
    return typeof value === "string" && backgrounds.includes(value as CutoutBackground);
}

export const useCutoutSettingsStore = create<CutoutSettingsState>()(
    persist(
        (set) => ({
            params: { ...defaultCutoutParams },
            background: defaultBackground,
            updateParams: (patch) => set((state) => ({ params: { ...state.params, ...patch } })),
            resetParams: () => set({ params: { ...defaultCutoutParams } }),
            setBackground: (background) => set({ background: isCutoutBackground(background) ? background : defaultBackground }),
        }),
        {
            name: "infinite-canvas:cutout_settings",
            partialize: (state) => ({ params: state.params, background: state.background }),
            merge: (persisted, current) => {
                const stored = (persisted || {}) as { params?: Partial<CutoutParams>; background?: unknown };
                return {
                    ...current,
                    params: { ...defaultCutoutParams, ...(stored.params || {}) },
                    background: isCutoutBackground(stored.background) ? stored.background : defaultBackground,
                };
            },
        },
    ),
);
