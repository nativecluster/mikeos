export type CatalogPricing = {
    input?: string;
    output?: string;
    variesByProvider?: true;
    tiered?: true;
};
export type CatalogModel = {
    id: string;
    label: string;
    pricing?: CatalogPricing;
};
export type LocalModel = { id: string; label: string; group: string };
/** GET /models/nativecluster. */
export type NativeClusterCatalog = {
    /** Every model call goes to NativeCluster (MIKE_INFERENCE_PROVIDER). */
    inferenceOnly: boolean;
    models: LocalModel[];
};
export type ConfiguredCatalogModel = LocalModel & {
    location: "cloud" | "local";
    source: "Configured";
};
export type CatalogFailure =
    | { ok: false; kind: "missing_api_key"; code: string; detail: string }
    // report: false when the user's own endpoint or key is at fault.
    | { ok: false; kind: "upstream"; error: Error; report?: boolean }
    | { ok: false; kind: "error"; error: unknown };
export type CatalogResult =
    | { ok: true; models: CatalogModel[] }
    | CatalogFailure;
