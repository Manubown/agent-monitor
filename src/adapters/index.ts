import type { Adapter } from "../core/adapter";
import { claudeCodeAdapter } from "./claude-code";
import { codexAdapter } from "./codex";
import { ompAdapter } from "./omp";

/** Every supported tool. Add new adapters here. */
export const adapters: Adapter[] = [ompAdapter, claudeCodeAdapter, codexAdapter];

export const adapterById = (id: string): Adapter | undefined => adapters.find((a) => a.id === id);

export const sourceLabel = (id: string): string => adapterById(id)?.label ?? id;
