// Re-exports types.ts as the single source of truth.
// index.ts previously duplicated all interfaces from types.ts verbatim.
// Centralised here to eliminate divergence risk.
export * from "./types";
