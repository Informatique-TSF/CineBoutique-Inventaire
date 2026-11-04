import { clsx } from "clsx";
import { useCallback, useEffect, useMemo, useRef, useState, useId } from "react";

import {
  createLocation,
  updateLocation,
  createShopUser,
  updateShopUser,
  disableShopUser,
} from "../../api/adminApi";
import {
  fetchLocations,
  resetShopInventory,
  updateLocationStatus,
} from "../../api/inventoryApi";
import type { ResetShopInventoryResponse } from "../../api/inventoryApi";
import { fetchShopUsers } from "../../api/shopUsers";
import { Card } from "../../components/Card";
import { EmptyState } from "../../components/EmptyState";
import { LoadingIndicator } from "../../components/LoadingIndicator";
import { Button } from "../../components/ui/Button";
import { FileUploadField } from "../../components/ui/FileUploadField";
import { Input } from "../../components/ui/Input";
import { useAsync } from "../../hooks/useAsync";
import type { Location } from "../../types/inventory";

import { ShopSettingsPanel } from "./ShopSettingsPanel";

import {
  CSV_ENCODING_OPTIONS,
  decodeCsvBuffer,
  type CsvEncoding,
} from "@/features/import/csvEncoding";
import { ResetInventoryModal } from "@/app/components/ResetInventoryModal";
import { formatResetInventorySummary } from "@/app/lib/resetSummary";
import { normalizeKey } from "@/features/import/csvMapping";
import { buildHeaders } from "@/lib/api/http";
import { useShop } from "@/state/ShopContext";
import type { ShopUser } from "@/types/user";

type FeedbackState = { type: "success" | "error"; message: string } | null;
type AdminSection = "locations" | "users" | "catalog" | "shop";

const ADMIN_SECTIONS: {
  id: AdminSection;
  label: string;
  description: string;
}[] = [
  {
    id: "locations",
    label: "Zones",
    description:
      "Ajustez les codes visibles sur les étiquettes et leurs libellés associés.",
  },
  {
    id: "users",
    label: "Utilisateurs",
    description:
      "Créez, mettez à jour ou désactivez les comptes des personnes autorisées à inventorier.",
  },
  {
    id: "catalog",
    label: "Produits",
    description:
      "Importez un fichier CSV pour compléter le catalogue de la boutique.",
  },
  {
    id: "shop",
    label: "Boutique",
    description:
      "Renseignez le code office MCS utilisé par le fichier d’import de stock en fin d’inventaire.",
  },
];

type SectionSwitcherProps = {
  activeSection: AdminSection;
  onChange: (section: AdminSection) => void;
};

const SectionSwitcher = ({ activeSection, onChange }: SectionSwitcherProps) => (
  <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
    <div>
      <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
        Paramétrage rapide
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Choisissez la rubrique à modifier. Les actions sont pensées pour un
        usage tactile ou souris.
      </p>
    </div>
    <div className="flex justify-start sm:justify-end">
      <div
        role="tablist"
        aria-label="Choix de la section d'administration"
        className="inline-grid w-full min-w-[200px] grid-flow-col auto-cols-fr gap-1 rounded-full bg-slate-100 p-0.5 text-sm font-semibold text-slate-600 shadow-inner dark:bg-slate-800 dark:text-slate-300 sm:w-auto"
      >
        {ADMIN_SECTIONS.map(({ id, label }) => {
          const isActive = id === activeSection;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={clsx(
                "rounded-full px-3 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400",
                isActive
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white"
                  : "hover:text-slate-900 dark:hover:text-white"
              )}
              onClick={() => onChange(id)}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  </Card>
);

const encodingLabelFor = (encoding: string | null | undefined) => {
  if (!encoding) {
    return null;
  }
  const option = CSV_ENCODING_OPTIONS.find(
    (candidate) => candidate.value === encoding
  );
  if (option) {
    return option.label;
  }
  if (encoding === "latin1") {
    return "Latin-1 (alias ISO-8859-1)";
  }
  return encoding;
};

type ImportSummary = {
  total: number | null;
  imported: number;
  inserted: number;
  updated: number | null;
  duplicateRewrites: number;
  errorCount: number;
  warningCount: number;
  alreadyPresent: number;
  unknownColumns: string[];
  encoding?: string | null;
  mode: "replace" | "merge";
};

type ImportResultSeverity = "success" | "warning" | "error";

type CatalogImportResultFeedback = {
  type: "result";
  severity: ImportResultSeverity;
  message: string;
  summary: ImportSummary;
  errorDetails: string[];
  warningDetails: string[];
};

type CatalogImportFeedback =
  | CatalogImportResultFeedback
  | { type: "info"; message: string }
  | { type: "error"; message: string; details?: string[] };

type ImportAccessStatus = {
  canReplace: boolean;
  lockReason: string | null;
  hasCountLines: boolean;
};

const CatalogImportPanel = ({
  description,
  refreshKey = 0,
}: {
  description: string;
  refreshKey?: number;
}) => {
  const { shop } = useShop();
  const [importStatus, setImportStatus] = useState<ImportAccessStatus | null>(
    null
  );
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [importMode, setImportMode] = useState<"replace" | "merge">("replace");
  const [file, setFile] = useState<File | null>(null);
  const [selectedEncoding, setSelectedEncoding] = useState<CsvEncoding>("auto");
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<CatalogImportFeedback | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchImportStatus = useCallback(async () => {
    if (!shop?.id) {
      setImportStatus(null);
      setStatusError(null);
      return;
    }

    setStatusLoading(true);
    setStatusError(null);

    try {
      const response = await fetch(
        `/api/shops/${shop.id}/products/import/status`,
        { headers: buildHeaders() }
      );

      if (response.status === 404) {
        setImportStatus({
          canReplace: true,
          lockReason: null,
          hasCountLines: false,
        });
        setStatusError(null);
        return;
      }

      if (!response.ok) {
        throw new Error(`status ${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown> | null;
      const record = payload ?? {};
      const hasCountLines =
        typeof record.hasCountLines === "boolean"
          ? record.hasCountLines
          : false;
      const canReplace =
        typeof record.canReplace === "boolean"
          ? record.canReplace
          : !hasCountLines;
      const lockReason =
        typeof record.lockReason === "string" &&
        record.lockReason.trim().length > 0
          ? record.lockReason
          : null;

      setImportStatus({ canReplace, lockReason, hasCountLines });
    } catch {
      setImportStatus(null);
      setStatusError("Impossible de récupérer l'état du catalogue.");
    } finally {
      setStatusLoading(false);
    }
  }, [shop?.id]);

  useEffect(() => {
    void fetchImportStatus();
  }, [fetchImportStatus, refreshKey]);

  useEffect(() => {
    if (importStatus?.canReplace === false) {
      setImportMode((previous) => (previous === "merge" ? previous : "merge"));
    }
  }, [importStatus?.canReplace]);

  useEffect(() => {
    if (!shop?.id) {
      setImportMode("replace");
    }
  }, [shop?.id]);

  const handleFileChange = (nextFile: File | null) => {
    setFile(nextFile);
    setSelectedEncoding("auto");
    setFeedback(null);
  };

  const resetFileInput = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setFile(null);
    setSelectedEncoding("auto");
  };

  const toInteger = (value: unknown) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.trunc(value);
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  };

  const toStringList = (value: unknown) => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item): item is string => item.length > 0);
  };

  const toImportErrorList = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }

        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const reason =
            typeof record.reason === "string"
              ? record.reason
              : typeof record.Reason === "string"
              ? record.Reason
              : "";
          const lineValue =
            typeof record.line === "number"
              ? record.line
              : typeof record.Line === "number"
              ? record.Line
              : null;
          const rawValue =
            typeof record.raw === "string"
              ? record.raw
              : typeof record.Raw === "string"
              ? record.Raw
              : "";

          const parts: string[] = [];
          if (lineValue && Number.isFinite(lineValue)) {
            parts.push(`Ligne ${lineValue}`);
          }
          if (reason) {
            parts.push(reason);
          }
          if (parts.length === 0 && rawValue) {
            parts.push(rawValue);
          }

          return parts.join(" — ").trim();
        }

        return "";
      })
      .filter((item): item is string => item.length > 0);
  };

  const toSkippedLineList = (value: unknown): string[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => {
        if (typeof entry === "string") {
          const trimmed = entry.trim();
          return trimmed.length > 0 ? trimmed : "";
        }

        if (entry && typeof entry === "object") {
          const record = entry as Record<string, unknown>;
          const lineNumber = toInteger(record.line ?? record.Line);
          const reason =
            typeof record.reason === "string"
              ? record.reason
              : typeof record.Reason === "string"
              ? record.Reason
              : "";
          const rawValue =
            typeof record.raw === "string"
              ? record.raw
              : typeof record.Raw === "string"
              ? record.Raw
              : "";

          const parts: string[] = [];
          if (lineNumber > 0) {
            parts.push(`Ligne ${lineNumber}`);
          }
          if (reason) {
            parts.push(reason);
          }
          if (parts.length === 0 && rawValue) {
            parts.push(rawValue);
          }

          return parts.join(" — ").trim();
        }

        return "";
      })
      .filter((entry): entry is string => entry.length > 0);
  };

  const toDuplicateWarningList = (value: unknown): string[] => {
    if (!value || typeof value !== "object") {
      return [];
    }

    const record = value as Record<string, unknown>;
    const entries = new Set<string>();

    const normalizeLines = (linesValue: unknown): number[] => {
      if (!Array.isArray(linesValue)) {
        return [];
      }
      return linesValue
        .map((item) => {
          if (typeof item === "number" && Number.isFinite(item)) {
            return Math.trunc(item);
          }
          if (typeof item === "string") {
            const parsed = Number.parseInt(item, 10);
            return Number.isNaN(parsed) ? null : parsed;
          }
          return null;
        })
        .filter((item): item is number => item !== null);
    };

    const collect = (rawList: unknown, label: "SKU" | "EAN") => {
      if (!Array.isArray(rawList)) {
        return;
      }
      rawList.forEach((entry) => {
        if (typeof entry === "string") {
          const formatted = entry.trim();
          if (formatted.length > 0) {
            entries.add(
              label === "SKU"
                ? `Doublon SKU ${formatted}`
                : `Doublon EAN ${formatted}`
            );
          }
          return;
        }

        if (!entry || typeof entry !== "object") {
          return;
        }
        const item = entry as Record<string, unknown>;
        const valueText =
          typeof item.value === "string"
            ? item.value
            : typeof item.Value === "string"
            ? item.Value
            : "";
        if (!valueText) {
          return;
        }
        const lines = normalizeLines(item.lines ?? item.Lines);
        const suffix = lines.length > 0 ? ` (lignes ${lines.join(", ")})` : "";
        const prefix = label === "SKU" ? "Doublon SKU" : "Doublon EAN";
        entries.add(`${prefix} ${valueText}${suffix}`);
      });
    };

    collect(record.skus ?? record.Skus, "SKU");
    collect(record.eans ?? record.Eans, "EAN");

    return Array.from(entries);
  };

  const countDuplicateSkuRewrites = (value: unknown): number => {
    if (!value || typeof value !== "object") {
      return 0;
    }

    const record = value as Record<string, unknown>;
    const rawList = record.skus ?? record.Skus;
    if (!Array.isArray(rawList)) {
      return 0;
    }

    let total = 0;

    rawList.forEach((entry) => {
      if (typeof entry === "string") {
        const formatted = entry.trim();
        if (formatted.length > 0) {
          total += 1;
        }
        return;
      }

      if (!entry || typeof entry !== "object") {
        return;
      }

      const item = entry as Record<string, unknown>;
      const rawLines = item.lines ?? item.Lines;

      let occurrences = 0;
      if (Array.isArray(rawLines)) {
        occurrences = rawLines.reduce<number>((acc, current) => {
          if (typeof current === "number" && Number.isFinite(current)) {
            return acc + 1;
          }
          if (typeof current === "string" && current.trim().length > 0) {
            return acc + 1;
          }
          return acc;
        }, 0);
      }

      if (occurrences === 0) {
        occurrences = 2;
      }

      if (occurrences > 1) {
        total += occurrences - 1;
      }
    });

    return total;
  };

  const splitCsvLine = (line: string): string[] => {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (inQuotes && index + 1 < line.length && line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (char === ";" && !inQuotes) {
        result.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    result.push(current);
    return result;
  };

  type MissingCsvValue = { line: number; raw: string; reason: string };

  const sanitizeCsvForImport = (
    text: string
  ): { sanitizedText: string; missingEanRecords: MissingCsvValue[] } => {
    const normalizedText = text.replace(/\r/g, "");
    const lines = normalizedText.split("\n");
    const sanitizedLines: string[] = [];
    const missingEanRecords: MissingCsvValue[] = [];

    let headerFields: string[] | null = null;
    let headerLength = 0;
    let eanIndex: number | null = null;
    let headerLine: string | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const rawLine = lines[index];
      const trimmed = rawLine.trim();

      if (!headerFields) {
        if (trimmed.length === 0) {
          continue;
        }
        headerLine = rawLine;
        sanitizedLines.push(rawLine);

        const parts = splitCsvLine(rawLine);
        headerFields = parts;
        headerLength = parts.length;
        const headerMap = new Map<string, number>();
        parts.forEach((value, position) => {
          const normalized = normalizeKey(value);
          if (!normalized || headerMap.has(normalized)) {
            return;
          }
          headerMap.set(normalized, position);
        });

        eanIndex = headerMap.get("ean") ?? null;
        continue;
      }

      if (trimmed.length === 0) {
        continue;
      }

      const parts = splitCsvLine(rawLine);
      while (parts.length < headerLength) {
        parts.push("");
      }

      if (
        eanIndex !== null &&
        eanIndex < parts.length &&
        (parts[eanIndex] ?? "").trim().length === 0
      ) {
        missingEanRecords.push({
          line: index + 1,
          raw: rawLine,
          reason: "EAN manquant",
        });
        continue;
      }

      sanitizedLines.push(rawLine);
    }

    if (sanitizedLines.length === 0 && headerLine) {
      sanitizedLines.push(headerLine);
    }

    return {
      sanitizedText:
        sanitizedLines.length > 0 ? sanitizedLines.join("\n") : normalizedText,
      missingEanRecords,
    };
  };

  const readFileAsArrayBuffer = async (input: File): Promise<ArrayBuffer> => {
    if (typeof input.arrayBuffer === "function") {
      return input.arrayBuffer();
    }

    return await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        if (reader.result instanceof ArrayBuffer) {
          resolve(reader.result);
          return;
        }
        if (typeof reader.result === "string") {
          resolve(new TextEncoder().encode(reader.result).buffer);
          return;
        }
        reject(new Error("Lecture du fichier impossible."));
      };
      reader.onerror = () => {
        reject(reader.error ?? new Error("Lecture du fichier impossible."));
      };
      reader.readAsArrayBuffer(input);
    });
  };

  const parseJson = (text: string) => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);

    if (!shop?.id) {
      setFeedback({
        type: "error",
        message: "Boutique introuvable. Veuillez recharger la page.",
      });
      return;
    }

    if (!file) {
      setFeedback({
        type: "error",
        message: "Sélectionnez un fichier CSV avant de lancer l'import.",
      });
      return;
    }

    if (importMode === "replace" && importStatus?.canReplace === false) {
      setFeedback({
        type: "error",
        message:
          "Le remplacement du catalogue est verrouillé. Choisissez “Compléter le catalogue” pour ajouter un fichier en complément.",
      });
      return;
    }

    const modeUsed = importMode;
    setSubmitting(true);
    try {
      const fd = new FormData();
      const buffer = await readFileAsArrayBuffer(file);
      const decoded = decodeCsvBuffer(buffer, selectedEncoding);
      const sanitization = sanitizeCsvForImport(decoded.text);
      const missingEanRecords = sanitization.missingEanRecords;
      const normalizedEncoding =
        selectedEncoding === "auto"
          ? decoded.detectedEncoding
          : selectedEncoding;
      const payloadText =
        sanitization.sanitizedText.trim().length > 0
          ? sanitization.sanitizedText
          : decoded.text;
      const utf8File = new File([payloadText], file.name, {
        type: "text/csv;charset=utf-8",
      });

      fd.set("file", utf8File);

      const params = new URLSearchParams({
        dryRun: "false",
        mode: importMode === "merge" ? "merge" : "replace",
      });
      const url = `/api/shops/${shop.id}/products/import?${params.toString()}`;
      const response = await fetch(url, {
        method: "POST",
        body: fd,
        headers: buildHeaders(),
      });
      const rawText = await response.text();
      const payload = rawText ? parseJson(rawText) : null;
      const record = (payload ?? {}) as Record<string, unknown>;

      if (response.status === 200) {
        const missingEanDetails = missingEanRecords.map(
          (record) => `Ligne ${record.line} — ${record.reason}`
        );
        const missingEanCount = missingEanRecords.length;
        const responseErrorsRaw = [
          ...toImportErrorList(record.errors),
          ...toImportErrorList(record.Errors),
        ];
        const skippedLinesRaw = [
          ...toSkippedLineList(record.skippedLines),
          ...toSkippedLineList(record.SkippedLines),
        ];
        const serverErrorEntries = Array.from(
          new Set([...responseErrorsRaw, ...skippedLinesRaw])
        );
        const serverErrorCount = serverErrorEntries.length;
        const errorDetails = Array.from(
          new Set([...serverErrorEntries, ...missingEanDetails])
        );

        const duplicateReportRaw = record.duplicates ?? record.Duplicates;
        const duplicateWarnings = toDuplicateWarningList(duplicateReportRaw);
        const duplicateRewriteCount =
          countDuplicateSkuRewrites(duplicateReportRaw);
        const messageWarnings = [
          ...toStringList(record.warningMessages),
          ...toStringList(record.WarningMessages),
          ...toStringList(record.warnings),
          ...toStringList(record.Warnings),
        ];
        const warningDetails = Array.from(
          new Set([...duplicateWarnings, ...messageWarnings])
        );

        const errorCount = errorDetails.length;
        const warningCount = warningDetails.length;

        const insertedCountRaw = Math.max(
          toInteger(record.inserted),
          toInteger(record.Inserted)
        );
        const updatedCountRaw = Math.max(
          toInteger(record.updated),
          toInteger(record.Updated)
        );
        const serverTotalFromRecord = (() => {
          const candidates: unknown[] = [record.total, record.Total];
          for (const candidate of candidates) {
            if (
              typeof candidate === "number" ||
              (typeof candidate === "string" && candidate.trim().length > 0)
            ) {
              return toInteger(candidate);
            }
          }
          return null;
        })();
        const serverTotal =
          serverTotalFromRecord ??
          (insertedCountRaw +
            Math.max(updatedCountRaw, 0) +
            serverErrorCount);
        const sanitizedTotal = serverTotal ?? 0;
        const fallbackInserted =
          insertedCountRaw > 0
            ? insertedCountRaw
            : Math.max(
                sanitizedTotal -
                  Math.max(updatedCountRaw, 0) -
                  serverErrorCount,
                0
              );
        const fallbackUpdatedRaw = Math.max(updatedCountRaw, 0);
        const fallbackUpdated =
          fallbackUpdatedRaw > 0
            ? fallbackUpdatedRaw
            : Math.max(
                sanitizedTotal - fallbackInserted - serverErrorCount,
                0
              );
        const importedCountRaw =
          insertedCountRaw + Math.max(updatedCountRaw, 0);
        const totalCount =
          serverTotal !== null
            ? serverTotal + missingEanCount
            : missingEanCount > 0
            ? missingEanCount
            : null;
        const importedFromTotal =
          totalCount !== null ? Math.max(totalCount - errorCount, 0) : null;
        const duplicateRewriteForSummary = duplicateRewriteCount;
        const updatesExcludingDuplicates = Math.max(
          fallbackUpdated - duplicateRewriteForSummary,
          0
        );
        const displayUpdated =
          updatesExcludingDuplicates > 0 ? updatesExcludingDuplicates : null;
        const importedBreakdownTotal =
          fallbackInserted +
          updatesExcludingDuplicates +
          duplicateRewriteForSummary;
        const fallbackImported = Math.max(
          importedCountRaw,
          fallbackInserted + fallbackUpdated,
          importedBreakdownTotal
        );
        const effectiveImported =
          importedFromTotal ?? fallbackImported;
        const alreadyPresentCount =
          serverTotal !== null
            ? Math.max(
                sanitizedTotal - effectiveImported - serverErrorCount,
                0
              )
            : 0;
        const unknownColumns = Array.from(
          new Set([
            ...toStringList(record.unknownColumns),
            ...toStringList(record.UnknownColumns),
          ])
        );
        const summary: ImportSummary = {
          total: totalCount,
          imported: effectiveImported,
          inserted: fallbackInserted,
          updated: displayUpdated,
          duplicateRewrites: duplicateRewriteForSummary,
          errorCount,
          warningCount,
          alreadyPresent: alreadyPresentCount,
          unknownColumns,
          encoding: encodingLabelFor(normalizedEncoding),
          mode: modeUsed,
        };

        if (errorCount > 0) {
          setFeedback({
            type: "result",
            severity: "error",
            message:
              "Import terminé avec erreurs. Les lignes listées n'ont pas été importées.",
            summary,
            errorDetails,
            warningDetails,
          });
          return;
        }

        if (warningCount > 0) {
          setFeedback({
            type: "result",
            severity: "warning",
            message:
              "Import terminé avec avertissements. Les éléments listés ont été importés.",
            summary,
            errorDetails,
            warningDetails,
          });
          resetFileInput();
          await fetchImportStatus();
          return;
        }

        setFeedback({
          type: "result",
          severity: "success",
          message: "Import terminé avec succès.",
          summary,
          errorDetails,
          warningDetails,
        });
        resetFileInput();
        await fetchImportStatus();
        return;
      }

      if (response.status === 204) {
        setFeedback({
          type: "info",
          message: "Aucun changement (fichier déjà importé).",
        });
        resetFileInput();
        await fetchImportStatus();
        return;
      }

      if (response.status === 423) {
        const reason = typeof record.reason === "string" ? record.reason : "";
        const message =
          typeof record.message === "string"
            ? record.message
            : reason === "catalog_locked"
            ? "Le catalogue est verrouillé : importez un fichier complémentaire ou purgez les comptages avant de remplacer le catalogue."
            : "Un import est déjà en cours.";

        setFeedback({ type: "error", message });

        if (reason === "catalog_locked") {
          setImportMode("merge");
          await fetchImportStatus();
        }
        return;
      }

      if (response.status === 413) {
        setFeedback({
          type: "error",
          message: "Fichier trop volumineux (25 MiB max).",
        });
        return;
      }

      if (response.status === 400) {
        const structuredErrors = [
          ...toImportErrorList(record.errors),
          ...toImportErrorList(record.Errors),
        ];
        const aggregatedDetails = [
          ...structuredErrors,
          ...toStringList(record.errorMessages ?? record.ErrorMessages),
          ...toStringList(record.details ?? record.Details),
          ...toStringList(record.unknownColumns ?? record.UnknownColumns),
        ];
        const uniqueDetails = Array.from(new Set(aggregatedDetails));
        const message =
          typeof record.message === "string"
            ? record.message
            : typeof record.error === "string"
            ? record.error
            : structuredErrors.length > 0
            ? "Le fichier CSV contient des lignes invalides."
            : rawText && rawText.trim().length > 0
            ? rawText
            : "Le fichier CSV est invalide.";
        setFeedback({
          type: "error",
          message,
          details: uniqueDetails.length > 0 ? uniqueDetails : undefined,
        });
        return;
      }

      const fallbackMessage =
        (typeof record.message === "string" && record.message) ||
        (typeof record.error === "string" && record.error) ||
        (rawText && rawText.trim().length > 0
          ? rawText
          : `Erreur inattendue (${response.status}).`);
      setFeedback({ type: "error", message: fallbackMessage });
    } catch {
      setFeedback({
        type: "error",
        message: "L'import a échoué. Vérifiez votre connexion et réessayez.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
            Catalogue produits (CSV)
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {description}
          </p>
        </div>
      </div>
      <form
        className="flex flex-col gap-4"
        onSubmit={handleSubmit}
        encType="multipart/form-data"
      >
        {statusError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-400/40 dark:bg-red-900/30 dark:text-red-100">
            {statusError}
          </div>
        )}

        {importStatus?.canReplace === false && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-200">
            <p className="font-semibold">Remplacement verrouillé</p>
            <p className="mt-1">
              Des produits importés ont déjà été utilisés dans des comptages.
              Importez un fichier complémentaire pour ajouter de nouvelles
              références.
            </p>
          </div>
        )}

        <FileUploadField
          ref={fileInputRef}
          name="file"
          label="Fichier CSV"
          accept=".csv,text/csv"
          file={file}
          onFileSelected={handleFileChange}
          disabled={submitting}
          description={
            importMode === "merge"
              ? "Votre fichier complétera le catalogue existant en ajoutant uniquement de nouvelles références."
              : "Remplace entièrement le catalogue de la boutique par le contenu du fichier."
          }
        />

        <label className="flex flex-col gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
          <span>Encodage du fichier</span>
          <select
            value={selectedEncoding}
            onChange={(event) => {
              setSelectedEncoding(event.target.value as CsvEncoding);
              setFeedback(null);
            }}
            disabled={submitting}
            className="w-full min-w-0 truncate rounded-lg border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-700 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200 sm:text-base"
          >
            {CSV_ENCODING_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="rounded-lg border border-slate-200 bg-white/70 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/40">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Mode d&apos;import
          </legend>
          {statusLoading && (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Vérification du statut du catalogue…
            </p>
          )}
          <div className="mt-2 space-y-3">
            <label
              aria-label="Remplacer le catalogue"
              className="flex cursor-pointer items-start gap-3"
            >
              <input
                type="radio"
                name="catalog-import-mode"
                value="replace"
                className="mt-1"
                checked={importMode === "replace"}
                disabled={submitting || importStatus?.canReplace === false}
                onChange={() => setImportMode("replace")}
              />
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  Remplacer le catalogue
                </span>
                <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
                  Supprime les références existantes avant l&apos;import.
                  Disponible uniquement tant qu&apos;aucun comptage n&apos;a
                  enregistré de produit.
                </span>
              </span>
            </label>
            <label
              aria-label="Compléter le catalogue"
              className="flex cursor-pointer items-start gap-3"
            >
              <input
                type="radio"
                name="catalog-import-mode"
                value="merge"
                className="mt-1"
                checked={importMode === "merge"}
                disabled={submitting}
                onChange={() => setImportMode("merge")}
              />
              <span>
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  Compléter le catalogue
                </span>
                <span className="mt-1 block text-xs text-slate-600 dark:text-slate-400">
                  Ajoute uniquement de nouvelles références sans purger le
                  catalogue actuel.
                </span>
              </span>
            </label>
          </div>
        </fieldset>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Button
            type="submit"
            disabled={submitting || !file}
            className="w-full sm:w-auto"
          >
            {submitting
              ? "Import en cours…"
              : importMode === "merge"
              ? "Importer en complément"
              : "Importer le CSV"}
          </Button>
        </div>
      </form>
      {feedback &&
        (feedback.type === "info" ? (
          <div
            role="status"
            className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-200"
          >
            <p className="font-medium">{feedback.message}</p>
          </div>
        ) : feedback.type === "error" ? (
          <div
            className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-400/40 dark:bg-red-900/30 dark:text-red-100"
            role="alert"
          >
            <div className="space-y-2">
              <p className="font-medium">{feedback.message}</p>
              {feedback.details && feedback.details.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {feedback.details.map((detail) => (
                    <li key={detail} className="max-w-full wrap-break-word">
                      {detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : (
          <div
            role={feedback.severity === "error" ? "alert" : "status"}
            className={clsx(
              "rounded-lg border p-4 text-sm",
              feedback.severity === "success" &&
                "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-900/20 dark:text-emerald-100",
              feedback.severity === "warning" &&
                "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-200",
              feedback.severity === "error" &&
                "border-red-200 bg-red-50 text-red-700 dark:border-red-400/40 dark:bg-red-900/30 dark:text-red-100"
            )}
          >
            <div className="space-y-3">
              <p className="font-medium">{feedback.message}</p>
              <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                {feedback.summary.total !== null && (
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-200">
                      Total lignes
                    </dt>
                    <dd className="text-slate-600 dark:text-slate-300">
                      {feedback.summary.total}
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="font-medium text-slate-700 dark:text-slate-200">
                    Produits importés
                  </dt>
                  <dd className="text-slate-600 dark:text-slate-300">
                    {feedback.summary.imported}
                  </dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700 dark:text-slate-200">
                    Créations
                  </dt>
                  <dd className="text-slate-600 dark:text-slate-300">
                    {feedback.summary.inserted}
                  </dd>
                </div>
                {feedback.summary.updated !== null && (
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-200">
                      Mises à jour
                    </dt>
                    <dd className="text-slate-600 dark:text-slate-300">
                      {feedback.summary.updated}
                    </dd>
                  </div>
                )}
                {feedback.summary.duplicateRewrites > 0 && (
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-200">
                      Doublons réécrits
                    </dt>
                    <dd className="text-slate-600 dark:text-slate-300">
                      {feedback.summary.duplicateRewrites}
                    </dd>
                  </div>
                )}
                {feedback.summary.mode === "merge" &&
                  feedback.summary.alreadyPresent > 0 && (
                    <div>
                      <dt className="font-medium text-slate-700 dark:text-slate-200">
                        Déjà présents dans le catalogue
                      </dt>
                      <dd className="text-slate-600 dark:text-slate-300">
                        {feedback.summary.alreadyPresent}
                      </dd>
                    </div>
                  )}
                {feedback.summary.mode === "merge" &&
                  feedback.summary.alreadyPresent > 0 && (
                    <div>
                      <dt className="font-medium text-slate-700 dark:text-slate-200">
                        Déjà présents en base
                      </dt>
                      <dd className="text-slate-600 dark:text-slate-300">
                        {feedback.summary.alreadyPresent}
                      </dd>
                    </div>
                  )}
                {feedback.summary.encoding && (
                  <div>
                    <dt className="font-medium text-slate-700 dark:text-slate-200">
                      Encodage utilisé
                    </dt>
                    <dd className="text-slate-600 dark:text-slate-300">
                      {feedback.summary.encoding}
                    </dd>
                  </div>
                )}
              </dl>
              {feedback.summary.unknownColumns.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">Colonnes inconnues</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {feedback.summary.unknownColumns.map((column) => (
                      <li
                        key={column}
                        className="max-w-full truncate"
                        title={column}
                      >
                        {column}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {feedback.errorDetails.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">
                    {`${feedback.errorDetails.length} ${
                      feedback.errorDetails.length > 1
                        ? "Lignes en erreur (non importées)"
                        : "Ligne en erreur (non importée)"
                    }`}
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {feedback.errorDetails.map((detail) => (
                      <li key={detail} className="max-w-full wrap-break-word">
                        {detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {feedback.warningDetails.length > 0 && (
                <div className="space-y-2">
                  <p className="font-medium">
                    {`${feedback.warningDetails.length} ${
                      feedback.warningDetails.length > 1
                        ? "Avertissements"
                        : "Avertissement"
                    }`}
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {feedback.warningDetails.map((detail) => (
                      <li key={detail} className="max-w-full wrap-break-word">
                        {detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        ))}
    </Card>
  );
};

type LocationListItemProps = {
  location: Location;
  onSave: (
    id: string,
    payload: { code: string; label: string }
  ) => Promise<void>;
  onDisable: (id: string) => Promise<void>;
  onEnable: (id: string) => Promise<void>;
};

const LocationListItem = ({
  location,
  onSave,
  onDisable,
  onEnable,
}: LocationListItemProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [code, setCode] = useState(location.code);
  const [label, setLabel] = useState(location.label);
  const [saving, setSaving] = useState(false);
  const [isDisabling, setIsDisabling] = useState(false);
  const [isEnabling, setIsEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disableConfirmationDialogRef = useRef<HTMLDialogElement | null>(null);
  const disableConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const disableDialogTitleId = `disable-location-dialog-title-${location.id}`;
  const disableDialogDescriptionId = `disable-location-dialog-description-${location.id}`;
  const isDisabled = location.disabled;

  useEffect(() => {
    if (!isEditing) {
      setCode(location.code);
      setLabel(location.label);
      setError(null);
    }
  }, [isEditing, location.code, location.label]);

  const handleCancel = () => {
    setCode(location.code);
    setLabel(location.label);
    setError(null);
    setIsEditing(false);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const nextCode = code.trim().toUpperCase();
    const nextLabel = label.trim();

    if (!nextCode) {
      setError("Le code est requis.");
      return;
    }

    if (!nextLabel) {
      setError("Le libellé est requis.");
      return;
    }

    if (nextCode === location.code && nextLabel === location.label) {
      setIsEditing(false);
      return;
    }

    setSaving(true);
    try {
      await onSave(location.id, { code: nextCode, label: nextLabel });
      setIsEditing(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "La mise à jour a échoué.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenDisableDialog = () => {
    setError(null);
    const dialog = disableConfirmationDialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    requestAnimationFrame(() => {
      disableConfirmButtonRef.current?.focus();
    });
  };

  const handleCancelDisableDialog = () => {
    disableConfirmationDialogRef.current?.close();
  };

  const handleConfirmDisableDialog = async () => {
    if (isDisabling) {
      return;
    }
    setIsDisabling(true);
    try {
      await onDisable(location.id);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de désactiver la zone.";
      setError(message);
    } finally {
      disableConfirmationDialogRef.current?.close();
      setIsDisabling(false);
    }
  };

  const handleEnable = async () => {
    if (!isDisabled || isEnabling) {
      return;
    }
    setError(null);
    setIsEnabling(true);
    try {
      await onEnable(location.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Impossible de réactiver la zone.";
      setError(message);
    } finally {
      setIsEnabling(false);
    }
  };

  return (
    <div
      data-testid="location-card"
      data-location-id={location.id}
      className={clsx(
        "flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition dark:border-slate-700 dark:bg-slate-900/70",
        isDisabled && "opacity-80"
      )}
    >
      {isEditing ? (
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4 sm:flex-row">
            <Input
              label="Code"
              name={`code-${location.id}`}
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              containerClassName="sm:w-32"
              maxLength={12}
              autoComplete="off"
              disabled={saving || isDisabling}
            />
            <Input
              label="Libellé"
              name={`label-${location.id}`}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              containerClassName="flex-1"
              autoComplete="off"
              disabled={saving || isDisabling}
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              className="py-3"
              disabled={saving || isDisabling}
            >
              {saving ? "Enregistrement…" : "Enregistrer"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={handleCancel}
              disabled={saving || isDisabling}
            >
              Annuler
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm font-semibold uppercase tracking-widest text-brand-500">
                {location.code}
              </p>
              {isDisabled && (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  Désactivée
                </span>
              )}
            </div>
            <p className="wrap-break-word text-lg font-semibold text-slate-900 dark:text-white">
              {location.label}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              variant="secondary"
              onClick={() => setIsEditing(true)}
              className="sm:self-start"
              disabled={isDisabled || saving || isDisabling || isEnabling}
            >
              Modifier
            </Button>
            {isDisabled ? (
              <Button
                variant="ghost"
                className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                onClick={handleEnable}
                disabled={saving || isDisabling || isEnabling}
              >
                Réactiver
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                onClick={handleOpenDisableDialog}
                disabled={saving || isDisabling || isEnabling}
              >
                Désactiver
              </Button>
            )}
          </div>
        </div>
      )}
      {error && !isEditing && (
        <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      <dialog
        ref={disableConfirmationDialogRef}
        aria-modal="true"
        aria-labelledby={disableDialogTitleId}
        aria-describedby={disableDialogDescriptionId}
        className="px-4"
      >
        <Card className="w-full max-w-lg shadow-elev-2">
          <div className="space-y-4">
            <p id={disableDialogTitleId} className="text-lg font-semibold">
              {`Désactiver ${location.code} ?`}
            </p>
            <p
              id={disableDialogDescriptionId}
              className="text-sm text-slate-600 dark:text-slate-300"
            >
              La zone désactivée ne sera plus proposée lors des inventaires tant
              qu&apos;elle n&apos;est pas réactivée.
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={handleCancelDisableDialog}
              disabled={isDisabling}
            >
              Annuler
            </Button>
            <Button
              ref={disableConfirmButtonRef}
              type="button"
              onClick={handleConfirmDisableDialog}
              className="bg-red-600 text-white shadow-soft hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 dark:bg-red-500 dark:hover:bg-red-400"
              disabled={isDisabling}
            >
              {isDisabling ? "Désactivation…" : "Confirmer la désactivation"}
            </Button>
          </div>
        </Card>
      </dialog>
    </div>
  );
};

type UserListItemProps = {
  user: ShopUser;
  onSave: (
    id: string,
    payload: { login: string; displayName: string; isAdmin: boolean }
  ) => Promise<void>;
  onDisable: (id: string) => Promise<void>;
  onEnable: (id: string) => Promise<void>;
};

const UserListItem = ({
  user,
  onSave,
  onDisable,
  onEnable,
}: UserListItemProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [login, setLogin] = useState(user.login);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [isAdmin, setIsAdmin] = useState(user.isAdmin);
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disableConfirmationDialogRef = useRef<HTMLDialogElement | null>(null);
  const disableConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const disableDialogTitleId = `disable-user-dialog-title-${user.id}`;
  const disableDialogDescriptionId = `disable-user-dialog-description-${user.id}`;
  const disableConfirmationMessage = `Désactiver ${user.displayName} ? L'utilisateur ne pourra plus se connecter tant qu'il n'est pas recréé.`;
  const isDisabled = user.disabled;

  useEffect(() => {
    if (!isEditing) {
      setLogin(user.login);
      setDisplayName(user.displayName);
      setIsAdmin(user.isAdmin);
      setError(null);
    }
  }, [isEditing, user.displayName, user.isAdmin, user.login]);

  const handleCancel = () => {
    setLogin(user.login);
    setDisplayName(user.displayName);
    setIsAdmin(user.isAdmin);
    setError(null);
    setIsEditing(false);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const nextLogin = login.trim();
    const nextDisplayName = displayName.trim();

    if (!nextLogin) {
      setError("L'identifiant est requis.");
      return;
    }

    if (!nextDisplayName) {
      setError("Le nom affiché est requis.");
      return;
    }

    if (
      nextLogin === user.login &&
      nextDisplayName === user.displayName &&
      isAdmin === user.isAdmin
    ) {
      setIsEditing(false);
      return;
    }

    setSaving(true);
    try {
      await onSave(user.id, {
        login: nextLogin,
        displayName: nextDisplayName,
        isAdmin,
      });
      setIsEditing(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "La mise à jour a échoué.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const performDisable = useCallback(async () => {
    if (isDisabled) {
      return;
    }
    setError(null);
    setDisabling(true);
    try {
      await onDisable(user.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "La désactivation a échoué.";
      setError(message);
    } finally {
      setDisabling(false);
    }
  }, [isDisabled, onDisable, user.id]);

  const handleOpenDisableDialog = useCallback(() => {
    if (isDisabled) {
      return;
    }
    const dialog = disableConfirmationDialogRef.current;
    if (dialog && typeof dialog.showModal === "function") {
      dialog.showModal();
      requestAnimationFrame(() => {
        disableConfirmButtonRef.current?.focus();
      });
      return;
    }

    if (window.confirm(disableConfirmationMessage)) {
      void performDisable();
    }
  }, [disableConfirmationMessage, isDisabled, performDisable]);

  const handleCancelDisableDialog = useCallback(() => {
    disableConfirmationDialogRef.current?.close();
  }, []);

  const handleConfirmDisableDialog = useCallback(() => {
    disableConfirmationDialogRef.current?.close();
    void performDisable();
  }, [performDisable]);

  const handleEnable = useCallback(async () => {
    if (!isDisabled || enabling) {
      return;
    }
    setError(null);
    setEnabling(true);
    try {
      await onEnable(user.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "La réactivation a échoué.";
      setError(message);
    } finally {
      setEnabling(false);
    }
  }, [enabling, isDisabled, onEnable, user.id]);

  return (
    <div
      className={clsx(
        "flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition dark:border-slate-700 dark:bg-slate-900/70",
        isDisabled && "opacity-80"
      )}
      data-testid="user-card"
      data-user-id={user.id}
    >
      {isEditing ? (
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4 lg:flex-row">
            <Input
              label="Identifiant"
              name={`login-${user.id}`}
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              containerClassName="lg:w-48"
              maxLength={64}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={saving || disabling || enabling}
            />
            <Input
              label="Nom affiché"
              name={`displayName-${user.id}`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              containerClassName="flex-1"
              autoComplete="name"
              disabled={saving || disabling || enabling}
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={isAdmin}
                onChange={(event) => setIsAdmin(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
                disabled={saving || disabling || enabling}
              />
              Administrateur
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="submit"
                className="py-3"
                disabled={saving || disabling || enabling}
              >
                {saving ? "Enregistrement…" : "Enregistrer"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleCancel}
                disabled={saving || disabling || enabling}
              >
                Annuler
              </Button>
            </div>
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
        </form>
      ) : (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold uppercase tracking-widest text-brand-500 wrap-break-word">
              {user.login}
            </p>
            <p className="text-lg font-semibold text-slate-900 dark:text-white wrap-break-word">
              {user.displayName}
            </p>
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {user.isAdmin ? "Administrateur" : "Standard"}
              </span>
              {isDisabled && (
                <span className="inline-flex items-center rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-300">
                  Désactivé
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-none sm:items-center">
            <Button
              variant="secondary"
              onClick={() => setIsEditing(true)}
              disabled={isDisabled || saving || disabling || enabling}
            >
              Modifier
            </Button>
            {isDisabled ? (
              <Button
                variant="ghost"
                className="text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300"
                onClick={handleEnable}
                disabled={saving || disabling || enabling}
              >
                Réactiver
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                onClick={handleOpenDisableDialog}
                disabled={saving || disabling || enabling}
              >
                Désactiver
              </Button>
            )}
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400 sm:ml-auto sm:w-full sm:text-right">
              {error}
            </p>
          )}
        </div>
      )}
      <dialog
        ref={disableConfirmationDialogRef}
        aria-modal="true"
        aria-labelledby={disableDialogTitleId}
        aria-describedby={disableDialogDescriptionId}
        className="px-4"
      >
        <Card className="w-full max-w-lg shadow-elev-2">
          <div className="space-y-4">
            <p id={disableDialogTitleId} className="text-lg font-semibold">
              {`Désactiver ${user.displayName} ?`}
            </p>
            <p
              id={disableDialogDescriptionId}
              className="text-sm text-slate-600 dark:text-slate-300"
            >
              L&apos;utilisateur ne pourra plus se connecter tant qu&apos;il
              n&apos;est pas recréé.
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={handleCancelDisableDialog}
              disabled={disabling}
            >
              Annuler
            </Button>
            <Button
              ref={disableConfirmButtonRef}
              type="button"
              onClick={handleConfirmDisableDialog}
              className="bg-red-600 text-white shadow-soft hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 dark:bg-red-500 dark:hover:bg-red-400"
              disabled={disabling}
            >
              {disabling ? "Désactivation…" : "Confirmer la désactivation"}
            </Button>
          </div>
        </Card>
      </dialog>
    </div>
  );
};

type LocationsPanelProps = {
  description: string;
};

type ConfirmDisableDialogState = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => Promise<void> | void;
};

const extractLocationStatusConflict = (
  error: unknown
): { lines: number | null } | null => {
  if (!error || typeof error !== "object") {
    return null;
  }
  const status = (error as { status?: number }).status;
  if (status !== 409) {
    return null;
  }
  const lines = (error as { counts?: { lines?: unknown } }).counts?.lines;
  return {
    lines: typeof lines === "number" && Number.isFinite(lines) ? lines : null,
  };
};

const LocationsPanel = ({ description }: LocationsPanelProps) => {
  const { shop } = useShop();

  const loadLocations = useCallback(() => {
    if (!shop?.id) {
      return Promise.resolve<Location[]>([]);
    }
    return fetchLocations(shop.id, { includeDisabled: true });
  }, [shop?.id]);

  const { data, loading, error, execute, setData } = useAsync(
    loadLocations,
    [loadLocations],
    {
      initialValue: [],
      immediate: Boolean(shop?.id),
    }
  );

  const [newLocationCode, setNewLocationCode] = useState("");
  const [newLocationLabel, setNewLocationLabel] = useState("");
  const [creatingLocation, setCreatingLocation] = useState(false);
  const [locationFeedback, setLocationFeedback] = useState<FeedbackState>(null);
  const [hideDisabledLocations, setHideDisabledLocations] = useState(true);
  const forceDisableDialogRef = useRef<HTMLDialogElement | null>(null);
  const forceDisableConfirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const forceDisableDialogTitleId = useId();
  const forceDisableDialogDescriptionId = useId();
  const [forceDisableDialogState, setForceDisableDialogState] =
    useState<ConfirmDisableDialogState | null>(null);
  const [forceDisableLoading, setForceDisableLoading] = useState(false);
  const toast = useMemo(
    () => ({
      success: (message: string) =>
        setLocationFeedback({ type: "success", message }),
    }),
    [setLocationFeedback]
  );

  const sortedLocations = useMemo(
    () => [...(data ?? [])].sort((a, b) => a.code.localeCompare(b.code)),
    [data]
  );

  const visibleLocations = useMemo(
    () =>
      hideDisabledLocations
        ? sortedLocations.filter((item) => !item.disabled)
        : sortedLocations,
    [hideDisabledLocations, sortedLocations]
  );

  const markLocationDisabled = useCallback(
    (targetId: string, disabled: boolean) => {
      setData((prev) =>
        prev?.map((item) => (item.id === targetId ? { ...item, disabled } : item)) ?? []
      );
    },
    [setData]
  );

  const refreshLocations = useCallback(async () => {
    try {
      const refreshed = await loadLocations();
      setData(refreshed);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de rafraîchir les zones.";
      setLocationFeedback({ type: "error", message });
    }
  }, [loadLocations, setData, setLocationFeedback]);

  const closeForceDisableDialog = useCallback(() => {
    forceDisableDialogRef.current?.close();
    setForceDisableDialogState(null);
    setForceDisableLoading(false);
  }, []);

  const openConfirmModal = useCallback(
    (state: ConfirmDisableDialogState) => {
      setForceDisableDialogState(state);
      setForceDisableLoading(false);
      const dialog = forceDisableDialogRef.current;
      if (dialog && typeof dialog.showModal === "function") {
        dialog.showModal();
        requestAnimationFrame(() => {
          forceDisableConfirmButtonRef.current?.focus();
        });
      }
    },
    []
  );

  const handleForceDisableCancel = useCallback(() => {
    closeForceDisableDialog();
  }, [closeForceDisableDialog]);

  const handleForceDisableConfirm = useCallback(async () => {
    if (!forceDisableDialogState) {
      closeForceDisableDialog();
      return;
    }
    setForceDisableLoading(true);
    try {
      await forceDisableDialogState.onConfirm();
      closeForceDisableDialog();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de désactiver la zone.";
      setLocationFeedback({ type: "error", message });
      setForceDisableLoading(false);
    }
  }, [closeForceDisableDialog, forceDisableDialogState]);

  const handleCreateLocation = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setLocationFeedback(null);

      const code = newLocationCode.trim().toUpperCase();
      const label = newLocationLabel.trim();

      if (!code || !label) {
        setLocationFeedback({
          type: "error",
          message: "Code et libellé sont requis.",
        });
        return;
      }

      setCreatingLocation(true);
      try {
        const created = await createLocation({ code, label });
        setData((prev) => [...(prev ?? []), created]);
        setNewLocationCode("");
        setNewLocationLabel("");
        setLocationFeedback({
          type: "success",
          message: "Zone créée avec succès.",
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Impossible de créer la zone. Réessayez.";
        setLocationFeedback({ type: "error", message });
      } finally {
        setCreatingLocation(false);
      }
    },
    [newLocationCode, newLocationLabel, setData]
  );

  const handleDisableLocation = async (id: string) => {
    setLocationFeedback(null);
    try {
      await updateLocationStatus(id, { isActive: false, force: false });
      markLocationDisabled(id, true);
      toast.success("Zone désactivée");
    } catch (err) {
      const conflict = extractLocationStatusConflict(err);
      if (conflict) {
        openConfirmModal({
          title: "Réinitialiser le comptage ?",
          message: conflict.lines
            ? `Cette zone a déjà été comptée (${conflict.lines} lignes). Si vous la désactivez, son comptage sera entièrement réinitialisé.`
            : "Cette zone a déjà été comptée. Si vous la désactivez, son comptage sera entièrement réinitialisé.",
          confirmLabel: "Oui, réinitialiser et désactiver",
          cancelLabel: "Annuler",
          onConfirm: async () => {
            await updateLocationStatus(id, { isActive: false, force: true });
            markLocationDisabled(id, true);
            toast.success("Zone désactivée et comptage réinitialisé");
            await refreshLocations();
          },
        });
        return;
      }
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de désactiver cette zone.";
      setLocationFeedback({ type: "error", message });
      throw (err instanceof Error ? err : new Error(message));
    }
  };

  const handleEnableLocation = async (id: string) => {
    setLocationFeedback(null);
    try {
      await updateLocationStatus(id, { isActive: true });
      markLocationDisabled(id, false);
      toast.success("Zone réactivée.");
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de réactiver cette zone.";
      setLocationFeedback({ type: "error", message });
      throw (err instanceof Error ? err : new Error(message));
    }
  };

  const handleUpdateLocation = async (
    id: string,
    payload: { code: string; label: string }
  ) => {
    setLocationFeedback(null);
    try {
      const updated = await updateLocation(id, payload);
      setData(
        (prev) =>
          prev?.map((item) => (item.id === updated.id ? updated : item)) ?? []
      );
      setLocationFeedback({ type: "success", message: "Zone mise à jour." });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de mettre à jour cette zone.";
      setLocationFeedback({ type: "error", message });
      throw new Error(message);
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
              Zones
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {description}
            </p>
          </div>
          <Button variant="ghost" onClick={() => execute()}>
            Actualiser
          </Button>
        </div>
      </div>
      <form
        data-testid="location-create-form"
        className="flex flex-col gap-4 sm:flex-row sm:items-end"
        onSubmit={handleCreateLocation}
      >
        <Input
          label="Code"
          name="newLocationCode"
          placeholder="Ex. A01"
          value={newLocationCode}
          onChange={(event) =>
            setNewLocationCode(event.target.value.toUpperCase())
          }
          containerClassName="sm:w-32"
          maxLength={12}
          autoComplete="off"
        />
        <Input
          label="Libellé"
          name="newLocationLabel"
          placeholder="Ex. Réserve, Comptoir"
          value={newLocationLabel}
          onChange={(event) => setNewLocationLabel(event.target.value)}
          containerClassName="flex-1"
          autoComplete="off"
        />
        <Button type="submit" disabled={creatingLocation} className="sm:self-end">
          {creatingLocation ? "Création…" : "Ajouter"}
        </Button>
      </form>
      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <input
          type="checkbox"
          checked={hideDisabledLocations}
          onChange={(event) => setHideDisabledLocations(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
        />
        Masquer les zones désactivées
      </label>
      {locationFeedback && (
        <p
          className={`text-sm ${
            locationFeedback.type === "success"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {locationFeedback.message}
        </p>
      )}
      {loading && <LoadingIndicator label="Chargement des zones" />}
      {Boolean(error) && (
        <EmptyState
          title="Erreur"
          description="Les zones n'ont pas pu être chargées."
        />
      )}
      {!loading && !error && (
        <div className="grid grid-cols-1 gap-4">
          {visibleLocations.length === 0 ? (
            sortedLocations.length > 0 && hideDisabledLocations ? (
              <EmptyState
                title="Aucune zone active"
                description="Toutes les zones sont désactivées. Décochez l'option ci-dessus pour les afficher."
              />
            ) : (
              <EmptyState
                title="Aucune zone"
                description="Ajoutez votre première zone pour démarrer."
              />
            )
          ) : (
            visibleLocations.map((locationItem) => (
              <LocationListItem
                key={locationItem.id}
                location={locationItem}
                onSave={handleUpdateLocation}
                onDisable={handleDisableLocation}
                onEnable={handleEnableLocation}
              />
            ))
          )}
        </div>
      )}
      <dialog
        ref={forceDisableDialogRef}
        aria-modal="true"
        aria-labelledby={forceDisableDialogTitleId}
        aria-describedby={forceDisableDialogDescriptionId}
        className="px-4"
        onCancel={(event) => {
          event.preventDefault();
          handleForceDisableCancel();
        }}
      >
        <Card className="w-full max-w-lg shadow-elev-2">
          <div className="space-y-4">
            <p id={forceDisableDialogTitleId} className="text-lg font-semibold">
              {forceDisableDialogState?.title ?? "Confirmation"}
            </p>
            <p
              id={forceDisableDialogDescriptionId}
              className="text-sm text-slate-600 dark:text-slate-300"
            >
              {forceDisableDialogState?.message ??
                "Cette action est irréversible."}
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={handleForceDisableCancel}
              disabled={forceDisableLoading}
            >
              {forceDisableDialogState?.cancelLabel ?? "Annuler"}
            </Button>
            <Button
              ref={forceDisableConfirmButtonRef}
              type="button"
              onClick={handleForceDisableConfirm}
              className="bg-red-600 text-white shadow-soft hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-red-300 dark:bg-red-500 dark:hover:bg-red-400"
              disabled={forceDisableLoading}
            >
              {forceDisableLoading
                ? "Désactivation…"
                : forceDisableDialogState?.confirmLabel ?? "Confirmer"}
            </Button>
          </div>
        </Card>
      </dialog>
    </Card>
  );
};

type UsersPanelProps = {
  description: string;
  isActive: boolean;
};

const UsersPanel = ({ description, isActive }: UsersPanelProps) => {
  const { shop } = useShop();

  const loadUsers = useCallback(() => {
    if (!shop?.id) {
      return Promise.resolve<ShopUser[]>([]);
    }
    return fetchShopUsers(shop.id, { includeDisabled: true });
  }, [shop?.id]);

  const { data, loading, error, execute, setData } = useAsync(
    loadUsers,
    [loadUsers],
    {
      initialValue: [],
      immediate: false,
    }
  );

  const [hasRequested, setHasRequested] = useState(false);
  const [newUserLogin, setNewUserLogin] = useState("");
  const [newUserDisplayName, setNewUserDisplayName] = useState("");
  const [newUserIsAdmin, setNewUserIsAdmin] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [userFeedback, setUserFeedback] = useState<FeedbackState>(null);
  const [hideDisabledUsers, setHideDisabledUsers] = useState(true);

  useEffect(() => {
    setHasRequested(false);
    setData([]);
  }, [setData, shop?.id]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (!shop?.id) {
      return;
    }
    if (hasRequested) {
      return;
    }
    setHasRequested(true);
    void execute().catch(() => undefined);
  }, [execute, hasRequested, isActive, shop?.id]);

  const sortedUsers = useMemo(() => {
    const list = data ?? [];
    return [...list].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "fr", { sensitivity: "base" })
    );
  }, [data]);

  const visibleUsers = useMemo(
    () =>
      hideDisabledUsers
        ? sortedUsers.filter((user) => !user.disabled)
        : sortedUsers,
    [hideDisabledUsers, sortedUsers]
  );

  const handleCreateUser = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setUserFeedback(null);

    const login = newUserLogin.trim();
    const displayName = newUserDisplayName.trim();

    if (!shop?.id) {
      setUserFeedback({
        type: "error",
        message: "Sélectionnez une boutique avant de créer un utilisateur.",
      });
      return;
    }

    if (!login || !displayName) {
      setUserFeedback({
        type: "error",
        message: "Identifiant et nom affiché sont requis.",
      });
      return;
    }

    setCreatingUser(true);
    try {
      const created = await createShopUser(shop.id, {
        login,
        displayName,
        isAdmin: newUserIsAdmin,
      });
      setData((prev) => [...(prev ?? []), created]);
      setNewUserLogin("");
      setNewUserDisplayName("");
      setNewUserIsAdmin(false);
      setUserFeedback({
        type: "success",
        message: "Utilisateur créé avec succès.",
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de créer l'utilisateur. Réessayez.";
      setUserFeedback({ type: "error", message });
    } finally {
      setCreatingUser(false);
    }
  };

  const handleUpdateUser = async (
    id: string,
    payload: { login: string; displayName: string; isAdmin: boolean }
  ): Promise<void> => {
    setUserFeedback(null);
    if (!shop?.id) {
      const message = "Boutique introuvable. Veuillez recharger la page.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }

    try {
      const updated = await updateShopUser(shop.id, { id, ...payload });
      setData(
        (prev) =>
          prev?.map((item) => (item.id === updated.id ? updated : item)) ?? []
      );
      setUserFeedback({ type: "success", message: "Utilisateur mis à jour." });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de mettre à jour l'utilisateur.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }
  };

  const handleDisableUser = async (id: string): Promise<void> => {
    setUserFeedback(null);
    if (!shop?.id) {
      const message = "Boutique introuvable. Veuillez recharger la page.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }

    try {
      const disabled = await disableShopUser(shop.id, id);
      setData(
        (prev) =>
          prev?.map((item) => (item.id === disabled.id ? disabled : item)) ?? []
      );
      setUserFeedback({ type: "success", message: "Utilisateur désactivé." });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de désactiver l'utilisateur.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }
  };

  const handleEnableUser = async (id: string): Promise<void> => {
    setUserFeedback(null);
    if (!shop?.id) {
      const message = "Boutique introuvable. Veuillez recharger la page.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }

    const currentUser = data?.find((item) => item.id === id);
    if (!currentUser) {
      const message = "Utilisateur introuvable dans la liste locale.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }

    try {
      const enabled = await updateShopUser(shop.id, {
        id,
        login: currentUser.login,
        displayName: currentUser.displayName,
        isAdmin: currentUser.isAdmin,
        disabled: false,
      });
      setData(
        (prev) =>
          prev?.map((item) => (item.id === enabled.id ? enabled : item)) ?? []
      );
      setUserFeedback({ type: "success", message: "Utilisateur réactivé." });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Impossible de réactiver l'utilisateur.";
      setUserFeedback({ type: "error", message });
      throw new Error(message);
    }
  };

  const handleRefresh = () => {
    if (!shop?.id) {
      setUserFeedback({
        type: "error",
        message: "Boutique introuvable. Impossible de rafraîchir.",
      });
      return;
    }
    setUserFeedback(null);
    setHasRequested(true);
    void execute().catch(() => undefined);
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
            Utilisateurs
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {description}
          </p>
        </div>
        <Button variant="ghost" onClick={handleRefresh}>
          Actualiser
        </Button>
      </div>
      <form
        className="flex flex-col gap-4"
        data-testid="user-create-form"
        onSubmit={handleCreateUser}
      >
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap">
            <Input
              label="Identifiant"
              name="newUserLogin"
              placeholder="Ex. camille"
              value={newUserLogin}
              onChange={(event) => setNewUserLogin(event.target.value)}
              containerClassName="sm:w-48"
              maxLength={64}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <Input
              label="Nom affiché"
              name="newUserDisplayName"
              placeholder="Ex. Camille Dupont"
              value={newUserDisplayName}
              onChange={(event) => setNewUserDisplayName(event.target.value)}
              containerClassName="flex-1"
              autoComplete="name"
            />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="flex items-center gap-3 text-sm font-medium text-slate-700 dark:text-slate-200">
              <input
                type="checkbox"
                checked={newUserIsAdmin}
                onChange={(event) => setNewUserIsAdmin(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
              />
              Administrateur
            </label>
            <Button type="submit" disabled={creatingUser} className="py-3">
              {creatingUser ? "Création…" : "Ajouter"}
            </Button>
          </div>
        </div>
      </form>
      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <input
          type="checkbox"
          checked={hideDisabledUsers}
          onChange={(event) => setHideDisabledUsers(event.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600"
        />
        Masquer les utilisateurs désactivés
      </label>
      {userFeedback && (
        <p
          className={`text-sm ${
            userFeedback.type === "success"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-red-600 dark:text-red-400"
          }`}
        >
          {userFeedback.message}
        </p>
      )}
      {loading && <LoadingIndicator label="Chargement des utilisateurs" />}
      {Boolean(error) && hasRequested && (
        <EmptyState
          title="Erreur"
          description="Les utilisateurs n'ont pas pu être chargés."
        />
      )}
      {!loading && !error && hasRequested && (
        <div className="grid grid-cols-1 gap-4">
          {visibleUsers.length === 0 ? (
            sortedUsers.length > 0 && hideDisabledUsers ? (
              <EmptyState
                title="Aucun utilisateur actif"
                description="Tous les comptes sont désactivés. Décochez l'option ci-dessus pour les afficher."
              />
            ) : (
              <EmptyState
                title="Aucun utilisateur"
                description="Ajoutez un premier compte pour démarrer."
              />
            )
          ) : (
            visibleUsers.map((user) => (
              <UserListItem
                key={user.id}
                user={user}
                onSave={handleUpdateUser}
                onDisable={handleDisableUser}
                onEnable={handleEnableUser}
              />
            ))
          )}
        </div>
      )}
    </Card>
  );
};
type InventoryResetPanelProps = {
  onResetSuccess?: () => void;
};

const InventoryResetPanel = ({ onResetSuccess }: InventoryResetPanelProps) => {
  const { shop } = useShop();
  const shopId = shop?.id?.trim() ?? "";
  const shopDisplayName = shop?.name?.trim();
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resettingInventory, setResettingInventory] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [lastResetSummary, setLastResetSummary] =
    useState<ResetShopInventoryResponse | null>(null);

  useEffect(() => {
    setLastResetSummary(null);
  }, [shopId]);

  const handleOpenModal = useCallback(() => {
    setResetError(null);
    setResetModalOpen(true);
  }, []);

  const handleCloseModal = useCallback(() => {
    if (resettingInventory) {
      return;
    }
    setResetModalOpen(false);
  }, [resettingInventory]);

  const handleConfirmReset = useCallback(async () => {
    if (!shopId) {
      setResetError("Boutique introuvable.");
      return;
    }
    setResetError(null);
    setResettingInventory(true);
    try {
      const summary = await resetShopInventory(shopId);
      setLastResetSummary(summary);
      setResetModalOpen(false);
      onResetSuccess?.();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Impossible de réinitialiser les comptages.";
      setResetError(message);
    } finally {
      setResettingInventory(false);
    }
  }, [onResetSuccess, shopId]);

  const resetSummaryMessage = useMemo(
    () => formatResetInventorySummary(lastResetSummary),
    [lastResetSummary]
  );

  const dismissSummary = useCallback(() => {
    setLastResetSummary(null);
  }, []);

  const canReset = Boolean(shopId);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
          Réinitialiser les comptages
        </h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Supprime tous les comptages, lignes et conflits pour{" "}
          {shopDisplayName ?? "la boutique sélectionnée"} afin de relancer un
          inventaire complet.
        </p>
      </div>
      {resetSummaryMessage && (
        <div className="flex items-start justify-between gap-4 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-100">
          <div>
            <p className="font-semibold">Inventaire réinitialisé</p>
            <p className="mt-1">{resetSummaryMessage}</p>
          </div>
          <button
            type="button"
            onClick={dismissSummary}
            className="rounded-full border border-brand-200 p-1 text-brand-600 transition hover:bg-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 dark:border-brand-500/40 dark:text-brand-100 dark:hover:bg-brand-500/20"
            aria-label="Masquer le message de confirmation"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Action irréversible : toutes les lignes et sessions seront supprimées.
        </p>
        <Button
          variant="danger"
          onClick={handleOpenModal}
          disabled={!canReset || resettingInventory}
        >
          {resettingInventory ? "Réinitialisation…" : "Réinitialiser les comptages"}
        </Button>
      </div>
      <ResetInventoryModal
        open={resetModalOpen}
        loading={resettingInventory}
        error={resetError}
        onCancel={handleCloseModal}
        onConfirm={handleConfirmReset}
      />
    </Card>
  );
};

export const AdminLocationsPage = () => {
  const [activeSection, setActiveSection] = useState<AdminSection>("locations");
  const [resetRefreshKey, setResetRefreshKey] = useState(0);
  const activeDefinition =
    ADMIN_SECTIONS.find((section) => section.id === activeSection) ??
    ADMIN_SECTIONS[0];
  const handleResetSuccess = useCallback(() => {
    setResetRefreshKey((value) => value + 1);
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <InventoryResetPanel onResetSuccess={handleResetSuccess} />
      <SectionSwitcher
        activeSection={activeSection}
        onChange={setActiveSection}
      />
      {activeSection === "locations" ? (
        <LocationsPanel description={activeDefinition.description} />
      ) : activeSection === "users" ? (
        <UsersPanel
          description={activeDefinition.description}
          isActive={activeSection === "users"}
        />
      ) : activeSection === "shop" ? (
        <ShopSettingsPanel description={activeDefinition.description} />
      ) : (
        <CatalogImportPanel
          description={activeDefinition.description}
          refreshKey={resetRefreshKey}
        />
      )}
    </div>
  );
};
