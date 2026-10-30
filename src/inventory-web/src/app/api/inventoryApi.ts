import { z } from "zod";

import { CountType, LocationsSchema } from "../types/inventory";
import type {
  CompletedRunDetail,
  CompletedRunSummary,
  OpenRunSummary,
  ConflictZoneDetail,
  ConflictZoneSummary,
  InventorySummary,
  Location,
  Product,
} from "../types/inventory";

import { API_BASE } from "@/lib/api/config";
import http, {
  RequestTimeoutError,
  type HttpError,
  type HttpRequestInit,
} from "@/lib/api/http";
import {
  LocationSummaryListSchema,
  type LocationSummaryList,
} from "@/types/summary";

/* ------------------------------ HTTP helpers ------------------------------ */

const PRODUCT_LOOKUP_TIMEOUT_MS = 7000;
const INVENTORY_RUN_MUTATION_TIMEOUT_MS = 7000;
type BudgetedRequest = (
  url: string,
  init?: HttpRequestInit
) => Promise<unknown>;
const nowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

const isHttpError = (value: unknown): value is HttpError =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { status?: unknown }).status === "number" &&
  typeof (value as { url?: unknown }).url === "string";

const tryExtractMessage = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const extractProblemMessage = (problem: unknown): string | null => {
  if (!problem) return null;
  if (typeof problem === "string") return tryExtractMessage(problem);

  if (Array.isArray(problem)) {
    for (const item of problem) {
      const message = extractProblemMessage(item);
      if (message) return message;
    }
    return null;
  }

  if (typeof problem !== "object") return null;

  const record = problem as Record<string, unknown>;
  const candidateKeys = [
    "message",
    "detail",
    "title",
    "error",
    "error_description",
  ] as const;
  for (const key of candidateKeys) {
    const message = tryExtractMessage(record[key]);
    if (message) return message;
  }

  const errors = (record as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      const message = extractProblemMessage(item);
      if (message) return message;
    }
  }

  return null;
};

const getHttpErrorMessage = (error: HttpError): string | null => {
  const fromProblem = extractProblemMessage(error.problem);
  if (fromProblem) return fromProblem;
  return tryExtractMessage(error.body);
};

/* ------------------------------- Data helpers ------------------------------ */

const UUID_RE =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

const toUuidOrNull = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v : null;

const toDateOrNull = (v: unknown): Date | null =>
  typeof v === "string" && v.length > 0 ? new Date(v) : null;

/* --------------------------- Inventory summary ---------------------------- */

export const fetchInventorySummary = async (): Promise<InventorySummary> => {
  const data = (await http(`${API_BASE}/inventories/summary`)) as
    | Partial<InventorySummary>
    | null
    | undefined;

  const sanitizeOpenRun = (
    run: Partial<OpenRunSummary> | null | undefined
  ): OpenRunSummary => ({
    runId: typeof run?.runId === "string" ? run.runId : "",
    locationId: typeof run?.locationId === "string" ? run.locationId : "",
    locationCode: typeof run?.locationCode === "string" ? run.locationCode : "",
    locationLabel:
      typeof run?.locationLabel === "string" ? run.locationLabel : "",
    countType: (run?.countType as CountType) ?? CountType.Count1,
    ownerDisplayName: run?.ownerDisplayName ?? null,
    ownerUserId: typeof run?.ownerUserId === "string" ? run.ownerUserId : null,
    startedAtUtc: typeof run?.startedAtUtc === "string" ? run.startedAtUtc : "",
  });

  const sanitizeCompletedRun = (
    run: Partial<CompletedRunSummary> | null | undefined
  ): CompletedRunSummary => ({
    runId: typeof run?.runId === "string" ? run.runId : "",
    locationId: typeof run?.locationId === "string" ? run.locationId : "",
    locationCode: typeof run?.locationCode === "string" ? run.locationCode : "",
    locationLabel:
      typeof run?.locationLabel === "string" ? run.locationLabel : "",
    countType: (run?.countType as CountType) ?? CountType.Count1,
    ownerDisplayName: run?.ownerDisplayName ?? null,
    ownerUserId: typeof run?.ownerUserId === "string" ? run.ownerUserId : null,
    startedAtUtc: typeof run?.startedAtUtc === "string" ? run.startedAtUtc : "",
    completedAtUtc:
      typeof run?.completedAtUtc === "string" ? run.completedAtUtc : "",
  });

  const openRunDetails = (
    Array.isArray(data?.openRunDetails) ? data.openRunDetails : []
  ).map(sanitizeOpenRun);
  const completedRunDetails = (
    Array.isArray(data?.completedRunDetails) ? data.completedRunDetails : []
  ).map(sanitizeCompletedRun);
  const conflictZones = Array.isArray(data?.conflictZones)
    ? data!.conflictZones
    : [];

  return {
    activeSessions: data?.activeSessions ?? 0,
    openRuns: data?.openRuns ?? 0,
    completedRuns: data?.completedRuns ?? completedRunDetails.length,
    conflicts: data?.conflicts ?? 0,
    lastActivityUtc: data?.lastActivityUtc ?? null,
    openRunDetails,
    completedRunDetails,
    conflictZones,
  };
};

/* --------------------------- /api/locations schema ------------------------ */
/* Un SEUL schéma, réutilisé partout. On conserve countType/status. */

const LocationApiItemSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    disabled: z.boolean().optional().default(false),
    isBusy: z.boolean().optional().default(false),
    busyBy: z.string().nullable().optional(),
    activeRunId: z.string().uuid().nullable().optional(),
    activeCountType: z.number().int().nullable().optional(),
    activeStartedAtUtc: z.string().nullable().optional(),
    countStatuses: z
      .array(
        z
          .object({
            runId: z.string().uuid().nullable().optional(),
            ownerUserId: z.string().nullable().optional(),
            startedAtUtc: z.string().nullable().optional(),
            completedAtUtc: z.string().nullable().optional(),
            countType: z.number().int().nullable().optional(),
            status: z
              .enum(["not_started", "in_progress", "completed"])
              .optional(),
          })
          .passthrough()
      )
      .optional()
      .default([]),
  })
  .passthrough();

/* ------------------- Home: summaries (shape front propre) ----------------- */

export const fetchLocationSummaries = async (
  shopId: string,
  signal?: AbortSignal
): Promise<LocationSummaryList> => {
  if (!shopId) throw new Error("Aucune boutique sélectionnée.");

  const searchParams = new URLSearchParams({ shopId });
  const raw = await http(`${API_BASE}/locations?${searchParams.toString()}`, {
    signal,
  });

  const normalized = Array.isArray(raw) ? raw : [];
  const apiItems = z.array(LocationApiItemSchema).parse(normalized);

  const adapted = apiItems.map((it) => ({
    locationId: it.id,
    locationName: it.label,
    busyBy: it.busyBy ?? null,
    activeRunId: it.activeRunId ?? null,
    activeCountType: it.activeCountType ?? null,
    activeStartedAtUtc: toDateOrNull(it.activeStartedAtUtc),
    // ici on expose uniquement ce que le schéma front attend
    countStatuses: (it.countStatuses ?? []).map((s) => ({
      runId: s.runId ?? null,
      ownerUserId: toUuidOrNull(s.ownerUserId),
      startedAtUtc: toDateOrNull(s.startedAtUtc),
      completedAtUtc: toDateOrNull(s.completedAtUtc),
    })),
  }));

  return LocationSummaryListSchema.parse(adapted);
};

/* -------------------------- Conflits & détails run ------------------------ */

export const getConflictZonesSummary = async (): Promise<
  ConflictZoneSummary[]
> => {
  const summary = await fetchInventorySummary();
  return summary.conflictZones;
};

export const getConflictZoneDetail = async (
  locationId: string,
  signal?: AbortSignal
): Promise<ConflictZoneDetail> => {
  const data = await http(
    `${API_BASE}/conflicts/${encodeURIComponent(locationId)}`,
    { signal }
  );
  return data as ConflictZoneDetail;
};

export const getCompletedRunDetail = async (
  runId: string
): Promise<CompletedRunDetail> => {
  const data = (await http(
    `${API_BASE}/inventories/runs/${encodeURIComponent(runId)}`
  )) as Partial<CompletedRunDetail> | null | undefined;

  const items = Array.isArray(data?.items) ? data!.items : [];

  return {
    runId: data?.runId ?? runId,
    locationId: data?.locationId ?? "",
    locationCode: data?.locationCode ?? "",
    locationLabel: data?.locationLabel ?? "",
    countType: (data?.countType as CountType) ?? CountType.Count1,
    ownerDisplayName: data?.ownerDisplayName ?? null,
    ownerUserId: data?.ownerUserId ?? null,
    startedAtUtc: data?.startedAtUtc ?? "",
    completedAtUtc: data?.completedAtUtc ?? "",
    items: items.map((item) => {
      const subGroupValue =
        typeof item?.subGroup === "string" ? item.subGroup.trim() : "";

      return {
        productId: item?.productId ?? "",
        sku: item?.sku ?? "",
        name: item?.name ?? "",
        ean:
          typeof item?.ean === "string" && item.ean.trim().length > 0
            ? item.ean
            : null,
        subGroup: subGroupValue.length > 0 ? subGroupValue : null,
        quantity:
          typeof item?.quantity === "number"
            ? item.quantity
            : Number(item?.quantity ?? 0),
      };
    }),
  };
};

/* ------------------------- /api/locations: select list -------------------- */
/* Parse brut -> normalise UUID -> validation stricte LocationsSchema */

type FetchLocationsOptions = {
  includeDisabled?: boolean;
};

export const fetchLocations = async (
  shopId: string,
  options: FetchLocationsOptions = {}
): Promise<Location[]> => {
  if (!shopId) throw new Error("Aucune boutique sélectionnée.");

  const params = new URLSearchParams({ shopId });
  if (options.includeDisabled) {
    params.set("includeDisabled", "true");
  }

  const url = `${API_BASE}/locations?${params.toString()}`;
  const response = await http(url);

  const arr = z.array(LocationApiItemSchema).parse(response);

  const sanitized = arr.map((loc) => ({
    ...loc,
    countStatuses: loc.countStatuses.map((s) => ({
      ...s, // on préserve countType/status/runId/started/completed
      ownerUserId: toUuidOrNull(s.ownerUserId),
    })),
  }));

  return LocationsSchema.parse(sanitized);
};

type UpdateLocationStatusOptions = {
  isActive: boolean;
  force?: boolean;
};

type LocationStatusConflictPayload = {
  counts?: {
    lines?: number;
  };
};

export const updateLocationStatus = async (
  locationId: string,
  { isActive, force = false }: UpdateLocationStatusOptions
): Promise<void> => {
  const trimmedId = typeof locationId === "string" ? locationId.trim() : "";
  if (!trimmedId) {
    throw new Error("L'identifiant de zone est requis.");
  }

  try {
    await http(
      `${API_BASE}/locations/${encodeURIComponent(trimmedId)}/status`,
      {
        method: "PATCH",
        body: {
          isActive: Boolean(isActive),
          force: Boolean(force),
        },
      }
    );
  } catch (error) {
    if (isHttpError(error) && error.status === 409) {
      const conflictPayload = (
        error.problem as LocationStatusConflictPayload | undefined
      )?.counts;
      const lines =
        typeof conflictPayload?.lines === "number" &&
        Number.isFinite(conflictPayload.lines)
          ? conflictPayload.lines
          : null;
      const message =
        getHttpErrorMessage(error) ??
        "Cette zone a déjà des lignes de comptage.";
      throw Object.assign(new Error(message), {
        status: error.status,
        problem: error.problem,
        counts: { lines },
      });
    }

    throw error;
  }
};

/* ----------------------------- Produits par EAN --------------------------- */

interface ProductSearchItemDtoLike {
  sku?: string | null;
  code?: string | null;
  ean?: string | null;
  name?: string | null;
}

type ProductCandidate = {
  sku?: string;
  code?: string;
  ean?: string;
  name?: string;
};

type ProductLookupConflictMatchLike = {
  sku?: string | null;
  code?: string | null;
};

interface ProductLookupConflictProblemLike {
  matches?: ProductLookupConflictMatchLike[];
}

const sanitizeProductCandidate = (
  candidate: unknown
): ProductCandidate | null => {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const record = candidate as ProductSearchItemDtoLike &
    Record<string, unknown>;
  const sku = typeof record.sku === "string" ? record.sku.trim() : "";
  const code = typeof record.code === "string" ? record.code.trim() : "";
  const ean = typeof record.ean === "string" ? record.ean.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (!sku && !code && !ean && !name) {
    return null;
  }

  return {
    sku: sku || undefined,
    code: code || undefined,
    ean: ean || undefined,
    name: name || undefined,
  };
};

const toProductSearchItems = (rawCandidates: unknown): ProductCandidate[] => {
  if (!Array.isArray(rawCandidates)) {
    return [];
  }

  const candidates: ProductCandidate[] = [];
  for (const item of rawCandidates) {
    const candidate = sanitizeProductCandidate(item);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
};

const dedupeCandidates = (
  candidates: ProductCandidate[]
): ProductCandidate[] => {
  const seen = new Set<string>();
  const result: ProductCandidate[] = [];

  for (const candidate of candidates) {
    const keyParts: string[] = [];
    if (candidate.sku) {
      keyParts.push(`sku:${candidate.sku.toLowerCase()}`);
    }
    const normalizedEan = normalizeLookupCode(candidate.ean ?? null);
    if (normalizedEan) {
      keyParts.push(`ean:${normalizedEan}`);
    }
    const normalizedCode = normalizeLookupCode(candidate.code ?? null);
    if (normalizedCode) {
      keyParts.push(`code:${normalizedCode}`);
    }

    if (keyParts.length === 0) {
      continue;
    }

    const key = keyParts.join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(candidate);
  }

  return result;
};

const normalizeLookupCode = (
  value: string | null | undefined
): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.replace(/\s+/g, "").toLowerCase();
};

const createNotFoundHttpError = (requestedCode: string): HttpError => {
  const productPath = `${API_BASE}/products/${encodeURIComponent(
    requestedCode
  )}`;
  let absoluteUrl = productPath;
  if (
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string"
  ) {
    try {
      absoluteUrl = new URL(productPath, window.location.origin).toString();
    } catch {
      absoluteUrl = productPath;
    }
  }

  const error = new Error("Status Code: 404; Not Found") as HttpError;
  error.status = 404;
  error.url = absoluteUrl;
  error.problem = {
    status: 404,
    title: "Not Found",
    detail: "Aucun produit ne correspond au code fourni.",
  };
  return error;
};

const hasMatchingProductCandidate = (
  candidates: ProductCandidate[],
  normalizedCode: string
): boolean => {
  return candidates.some((candidate) => {
    const codes = [
      normalizeLookupCode(candidate.code ?? null),
      normalizeLookupCode(candidate.sku ?? null),
      normalizeLookupCode(candidate.ean ?? null),
    ];
    return codes.some((value) => value === normalizedCode);
  });
};

const filterMatchingProductCandidates = (
  candidates: ProductCandidate[],
  normalizedCode: string | null
): ProductCandidate[] => {
  if (!normalizedCode) {
    return [];
  }
  return candidates.filter((candidate) => {
    const codes = [
      normalizeLookupCode(candidate.code ?? null),
      normalizeLookupCode(candidate.sku ?? null),
      normalizeLookupCode(candidate.ean ?? null),
    ];
    return codes.some((value) => value === normalizedCode);
  });
};

const tryResolveAmbiguousProduct = async (
  error: HttpError | null,
  fallbackCandidates: ProductCandidate[],
  requestedCode: string,
  requestWithBudget: BudgetedRequest
): Promise<Product | null> => {
  const problem = (error?.problem ??
    null) as ProductLookupConflictProblemLike | null;
  const matches = Array.isArray(problem?.matches) ? problem.matches : [];

  const candidates: ProductCandidate[] = [];
  for (const match of matches) {
    const candidate = sanitizeProductCandidate(match);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.push(...fallbackCandidates);

  const deduped = dedupeCandidates(candidates);
  if (deduped.length === 0) {
    return null;
  }

  for (const candidate of deduped) {
    if (!candidate.sku) {
      continue;
    }

    try {
      const rawDetails = await requestWithBudget(
        `${API_BASE}/products/${encodeURIComponent(candidate.sku)}/details`
      );
      const detailsRecord = (rawDetails ?? {}) as Record<string, unknown>;
      const enriched = sanitizeProductCandidate({
        ...candidate,
        ...detailsRecord,
      });
      if (!enriched) {
        continue;
      }

      const eanValue = enriched.ean ?? enriched.code ?? requestedCode;
      const nameValue = enriched.name ?? `Produit ${enriched.sku ?? eanValue}`;
      const detailGroup = pickFirstString(detailsRecord, ["group", "Group"]);
      const detailSubGroup =
        pickFirstString(detailsRecord, ["subGroup", "SubGroup"]) ??
        extractOriginalSubGroup(
          detailsRecord.attributes ?? detailsRecord.Attributes
        );

      return {
        ean: eanValue,
        name: nameValue,
        sku: enriched.sku ?? undefined,
        group: detailGroup ?? undefined,
        subGroup: detailSubGroup ?? undefined,
      };
    } catch (detailsError) {
      if (isHttpError(detailsError) && detailsError.status === 404) {
        continue;
      }
      continue;
    }
  }

  for (const candidate of deduped) {
    const eanValue = candidate.ean ?? candidate.code ?? requestedCode;
    if (!eanValue) {
      continue;
    }
    const nameValue = candidate.name ?? `Produit ${candidate.sku ?? eanValue}`;
    return {
      ean: eanValue,
      name: nameValue,
      sku: candidate.sku ?? undefined,
    };
  }

  return null;
};

const toTrimmedString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const pickFirstString = (
  source: Record<string, unknown>,
  keys: string[]
): string | null => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const candidate = toTrimmedString(source[key]);
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
};

const pickFirstNumber = (
  source: Record<string, unknown>,
  keys: string[]
): number | null => {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return null;
};

const extractOriginalSubGroup = (attributes: unknown): string | null => {
  if (!attributes) {
    return null;
  }
  if (typeof attributes === "string") {
    try {
      const parsed = JSON.parse(attributes) as unknown;
      return extractOriginalSubGroup(parsed);
    } catch {
      return null;
    }
  }
  if (typeof attributes !== "object") {
    return null;
  }
  try {
    const record = attributes as Record<string, unknown>;
    return pickFirstString(record, ["originalSousGroupe"]);
  } catch {
    return null;
  }
};

export const fetchProductByEan = async (
  ean: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<Product> => {
  const rawCode = (ean ?? "").replace(/\r|\n/g, "");
  if (rawCode.length === 0) {
    throw new Error("Code vide ou invalide");
  }

  const totalBudget = Math.max(
    500,
    options?.timeoutMs ?? PRODUCT_LOOKUP_TIMEOUT_MS
  );
  const startedAt = nowMs();
  const externalSignal = options?.signal ?? null;
  const requestWithBudget: BudgetedRequest = (url, init) => {
    const elapsed = nowMs() - startedAt;
    const remaining = totalBudget - elapsed;
    if (remaining <= 0) {
      throw new RequestTimeoutError(url, totalBudget);
    }
    const mergedInit: HttpRequestInit = {
      ...init,
      timeoutMs: remaining,
      signal: externalSignal ?? init?.signal,
    };
    return http(url, mergedInit);
  };

  const normalizedCode = normalizeLookupCode(rawCode);
  let searchCandidates: ProductCandidate[] = [];

  if (normalizedCode) {
    try {
      const params = new URLSearchParams({ code: rawCode, limit: "5" });
      const searchUrl = `${API_BASE}/products/search?${params.toString()}`;
      const rawResult = await requestWithBudget(searchUrl);
      const candidates = toProductSearchItems(rawResult);
      searchCandidates = dedupeCandidates(candidates);
      const hasMatch = hasMatchingProductCandidate(
        searchCandidates,
        normalizedCode
      );
      if (!hasMatch) {
        throw createNotFoundHttpError(rawCode);
      }

      const matchingCandidates = filterMatchingProductCandidates(
        searchCandidates,
        normalizedCode
      );
      const resolutionCandidates =
        matchingCandidates.length > 0 ? matchingCandidates : searchCandidates;
      if (resolutionCandidates.length > 0) {
        searchCandidates = resolutionCandidates;
      }
    } catch (error) {
      if (isHttpError(error) && error.status === 404) {
        throw error;
      }
      if (
        error instanceof Error &&
        error.message === "Status Code: 404; Not Found"
      ) {
        throw error;
      }
    }
  }

  try {
    const data = await requestWithBudget(
      `${API_BASE}/products/${encodeURIComponent(rawCode)}`
    );
    const baseRecord = (data ?? {}) as Record<string, unknown>;
    const baseSku = pickFirstString(baseRecord, ["sku", "Sku"]);
    const baseName = pickFirstString(baseRecord, ["name", "Name"]);
    const baseEan = pickFirstString(baseRecord, ["ean", "Ean"]);
    const baseGroup = pickFirstString(baseRecord, ["group", "Group"]);
    const resolvedSubGroup = pickFirstString(baseRecord, [
      "subGroup",
      "SubGroup",
    ]);

    let detailsGroup: string | null = null;
    let detailsSubGroup: string | null = null;
    let detailsStock: number | null = null;
    let detailsLastCountedAt: string | null = null;

    if (baseSku) {
      try {
        const detailsResponse = await requestWithBudget(
          `${API_BASE}/products/${encodeURIComponent(baseSku)}/details`
        );
        if (detailsResponse && typeof detailsResponse === "object") {
          const details = detailsResponse as Record<string, unknown>;
          detailsGroup = pickFirstString(details, ["group", "Group"]) ?? null;
          const rawDetailSubGroup = pickFirstString(details, [
            "subGroup",
            "SubGroup",
          ]);
          const attrs = details.attributes ?? details.Attributes;
          const fallbackSubGroup = extractOriginalSubGroup(attrs);
          detailsSubGroup = rawDetailSubGroup ?? fallbackSubGroup;
          detailsStock = pickFirstNumber(details, ["stock", "Stock"]);
          detailsLastCountedAt = pickFirstString(details, [
            "lastCountedAt",
            "LastCountedAt",
          ]);
        }
      } catch {
        // Ignore detail lookup failures; base product data is still usable.
      }
    }

    const product: Product = {
      ean: baseEan ?? rawCode,
      name: baseName ?? `Produit ${baseSku ?? baseEan ?? rawCode}`,
      sku: baseSku ?? undefined,
      group: detailsGroup ?? baseGroup ?? undefined,
      subGroup: detailsSubGroup ?? resolvedSubGroup ?? undefined,
    };

    const stock =
      pickFirstNumber(baseRecord, ["stock", "Stock"]) ?? detailsStock;
    if (stock != null) {
      product.stock = stock;
    }
    const lastCountedAt =
      pickFirstString(baseRecord, ["lastCountedAt", "LastCountedAt"]) ??
      detailsLastCountedAt;
    if (lastCountedAt) {
      product.lastCountedAt = lastCountedAt;
    }

    return product;
  } catch (error) {
    const err = error as HttpError;
    if (isHttpError(err) && err.status === 409) {
      const resolved = await tryResolveAmbiguousProduct(
        err,
        searchCandidates,
        rawCode,
        requestWithBudget
      );
      if (resolved) {
        return resolved;
      }
    }
    throw err;
  }
};

/* --------------------------- Runs start/complete -------------------------- */

export interface CompleteInventoryRunItem {
  ean: string;
  quantity: number;
  isManual: boolean;
}

export interface CompleteInventoryRunPayload {
  runId?: string | null;
  ownerUserId: string;
  countType: number;
  items: CompleteInventoryRunItem[];
}

export interface StartInventoryRunPayload {
  shopId: string;
  ownerUserId: string;
  countType: number;
}

export interface StartInventoryRunResponse {
  runId: string;
  inventorySessionId: string;
  locationId: string;
  countType: number;
  ownerDisplayName: string | null;
  ownerUserId: string | null;
  startedAtUtc: string;
}

export interface CompleteInventoryRunResponse {
  runId: string;
  inventorySessionId: string;
  locationId: string;
  countType: number;
  completedAtUtc: string;
  itemsCount: number;
  totalQuantity: number;
}

export const startInventoryRun = async (
  locationId: string,
  payload: StartInventoryRunPayload
): Promise<StartInventoryRunResponse> => {
  const url = `${API_BASE}/inventories/${encodeURIComponent(locationId)}/start`;
  return (await http(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: INVENTORY_RUN_MUTATION_TIMEOUT_MS,
  })) as StartInventoryRunResponse;
};

export const completeInventoryRun = async (
  locationId: string,
  payload: CompleteInventoryRunPayload,
  signal?: AbortSignal
): Promise<CompleteInventoryRunResponse> => {
  const url = `${API_BASE}/inventories/${encodeURIComponent(
    locationId
  )}/complete`;
  try {
    return (await http(url, {
      method: "POST",
      body: payload,
      signal,
    })) as CompleteInventoryRunResponse;
  } catch (error) {
    if (isHttpError(error)) {
      const messageFromBody = getHttpErrorMessage(error);
      const problemPayload =
        error.problem ?? (error.body ? { body: error.body } : undefined);

      if (error.status === 415) {
        throw Object.assign(
          new Error(
            "Type de contenu non pris en charge : une requête JSON est attendue (Content-Type: application/json)."
          ),
          { status: error.status, problem: problemPayload }
        );
      }

      let message: string;
      if (error.status === 400)
        message = messageFromBody ?? "Requête invalide.";
      else if (error.status === 404)
        // Le serveur distingue « zone introuvable » et « run introuvable » : on relaie son détail.
        message = messageFromBody ?? "Zone introuvable pour ce comptage.";
      else
        message =
          messageFromBody ??
          `Impossible de terminer le comptage (HTTP ${error.status}).`;

      throw Object.assign(new Error(message), {
        status: error.status,
        problem: problemPayload,
      });
    }

    throw error;
  }
};

export const restartInventoryRun = async (
  locationId: string,
  countType: CountType
): Promise<void> => {
  const searchParams = new URLSearchParams({ countType: String(countType) });
  await http(
    `${API_BASE}/inventories/${locationId}/restart?${searchParams.toString()}`,
    {
      method: "POST",
    }
  );
};

export const releaseInventoryRun = async (
  locationId: string,
  runId: string,
  ownerUserId: string
): Promise<void> => {
  const url = `${API_BASE}/inventories/${encodeURIComponent(
    locationId
  )}/release`;
  try {
    await http(url, {
      method: "POST",
      body: { runId, ownerUserId },
    });
  } catch (error) {
    if (isHttpError(error)) {
      const messageFromBody = getHttpErrorMessage(error);
      let message = `Impossible de libérer le comptage (HTTP ${error.status}).`;
      if (error.status === 404)
        message = messageFromBody ?? "Comptage introuvable.";
      else if (error.status === 409)
        message =
          messageFromBody ?? "Comptage déjà détenu par un autre utilisateur.";
      else if (error.status === 400)
        message = messageFromBody ?? "Requête invalide.";
      else if (messageFromBody) message = messageFromBody;

      throw Object.assign(new Error(message), {
        status: error.status,
        url: url,
        problem: (error as HttpError).problem,
      });
    }

    throw error;
  }
};

export interface ResetShopInventoryResponse {
  shopId: string;
  shopName?: string | null;
  zonesCleared: number;
  runsCleared: number;
  linesCleared: number;
  conflictsCleared: number;
  sessionsClosed: number;
}

export const resetShopInventory = async (
  shopId: string
): Promise<ResetShopInventoryResponse> => {
  const url = `${API_BASE}/shops/${encodeURIComponent(
    shopId
  )}/inventories/reset`;
  const response = (await http(url, {
    method: "POST",
  })) as ResetShopInventoryResponse | null;

  if (!response) {
    return {
      shopId,
      shopName: null,
      zonesCleared: 0,
      runsCleared: 0,
      linesCleared: 0,
      conflictsCleared: 0,
      sessionsClosed: 0,
    };
  }

  return response;
};
