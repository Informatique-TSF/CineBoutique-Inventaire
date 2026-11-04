import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";

import { fetchProductByEan, startInventoryRun } from "../../api/inventoryApi";
import {
  BarcodeScanner,
  type ScanFrameTone,
  type TorchController,
  type TorchState,
} from "../../components/BarcodeScanner";
import {
  ListIcon,
  ScanCountSheet,
  ScanErrorSheet,
  ScanItemsSheet,
  ScanLookupSheet,
  ScanUndoToast,
} from "../../components/inventory/ScanSheets";
import { formatPieces } from "../../components/inventory/scanFormat";
import { useInventory } from "../../contexts/InventoryContext";
import type { InventoryItem, Product } from "../../types/inventory";

import { useCamera, type CameraOptions } from "@/hooks/useCamera";
import { useScanDuplicateFeedback } from "@/hooks/useScanDuplicateFeedback";
import { useScanRejectionFeedback } from "@/hooks/useScanRejectionFeedback";
import { useScanSuccessFeedback } from "@/hooks/useScanSuccessFeedback";
import {
  AbortedRequestError,
  RequestTimeoutError,
  type HttpError,
} from "@/lib/api/http";
import { decodeBarcodeFromFile } from "@/lib/scan/barcodeDetector";
import { describeCameraError } from "@/lib/scan/cameraErrors";
import { useShop } from "@/state/ShopContext";

const MAX_SCAN_LENGTH = 32;
/**
 * Après validation ou annulation, le même code est ignoré tant que la caméra continue de le voir,
 * puis pendant ce délai : on évite de rouvrir la fiche sur l’étiquette qu’on vient de traiter.
 */
export const SAME_CODE_COOLDOWN_MS = 2000;
/** Durée d’affichage du bandeau « +N … Annuler » après validation. */
export const UNDO_TOAST_DURATION_MS = 5000;

const isTestEnv =
  typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

const sanitizeScanValue = (value: string) => value.replace(/[\r\n\t]+/g, "");

const isScanLengthValid = (code: string) =>
  code.length > 0 && code.length <= MAX_SCAN_LENGTH;

/** Fiche ouverte par-dessus la caméra (la lecture est suspendue tant qu’elle est affichée). */
type ScanPanel =
  | { kind: "lookup"; code: string | null }
  | { kind: "count"; code: string; product: Product }
  | {
      kind: "error";
      code: string | null;
      title: string;
      message: string;
      hint?: string;
    }
  | { kind: "list" }
  | { kind: "edit"; ean: string };

type UndoToast = {
  id: number;
  ean: string;
  title: string;
  detail: string;
  /** Quantité avant validation (`null` : le produit n’était pas encore compté). */
  previousQuantity: number | null;
};

const findItem = (items: InventoryItem[], ean: string) =>
  items.find((item) => item.product.ean === ean);

export const ScanCameraPage = () => {
  const navigate = useNavigate();
  const { shop } = useShop();
  const {
    selectedUser,
    location,
    countType,
    items,
    addOrIncrementItem,
    setQuantity,
    removeItem,
    sessionId,
    setSessionId,
  } = useInventory();
  const [panel, setPanelState] = useState<ScanPanel | null>(null);
  const [toast, setToast] = useState<UndoToast | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoDecoding, setPhotoDecoding] = useState(false);
  const panelRef = useRef<ScanPanel | null>(null);
  const itemsRef = useRef(items);
  const toastSeqRef = useRef(0);
  const pendingScanControllerRef = useRef<AbortController | null>(null);
  const scanTokenRef = useRef(0);
  const codeLockRef = useRef<{ code: string; until: number } | null>(null);
  const resumeCameraOnVisibleRef = useRef(false);
  const lastVisibilityStateRef = useRef<string | null>(
    typeof document !== "undefined" ? document.visibilityState : null
  );
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  const [isLandscape, setIsLandscape] = useState(false);
  const [torchState, setTorchState] = useState<TorchState>({
    supported: false,
    enabled: false,
  });
  const triggerScanDuplicateFeedback = useScanDuplicateFeedback();
  const triggerScanRejectionFeedback = useScanRejectionFeedback();
  const successFeedback = useScanSuccessFeedback();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const torchControllerRef = useRef<TorchController | null>(null);
  // Les contraintes (1080p, mise au point continue, zoom) sont gérées par le hook.
  const cameraOptions = useMemo<CameraOptions>(
    () => ({ autoResumeOnVisible: false }),
    []
  );

  const {
    active: cameraActive,
    error: cameraError,
    stop: stopCamera,
    start: startCamera,
    canSwitchCamera,
    switchCamera,
  } = useCamera(videoRef, cameraOptions);

  const shopName = shop?.name ?? "Boutique";
  const locationLabel = location?.label ?? "Zone inconnue";
  const ownerUserId = selectedUser?.id?.trim() ?? "";
  const locationId = location?.id?.trim() ?? "";
  const countTypeValue = typeof countType === "number" ? countType : null;
  const sessionRunId = typeof sessionId === "string" ? sessionId.trim() : "";
  const [hasCameraBooted, setHasCameraBooted] = useState(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  /** Met à jour la fiche affichée ; la référence est lue par la caméra sans attendre le rendu. */
  const setPanel = useCallback((next: ScanPanel | null) => {
    panelRef.current = next;
    setPanelState(next);
  }, []);

  const lockCode = useCallback((code: string | null) => {
    codeLockRef.current = code
      ? { code, until: Date.now() + SAME_CODE_COOLDOWN_MS }
      : null;
  }, []);

  /** Vrai si ce code vient d’être traité ; prolonge le verrou tant que la caméra le voit. */
  const isCodeLocked = useCallback((code: string) => {
    const lock = codeLockRef.current;
    if (!lock || lock.code !== code) {
      return false;
    }
    const now = Date.now();
    if (now >= lock.until) {
      codeLockRef.current = null;
      return false;
    }
    lock.until = now + SAME_CODE_COOLDOWN_MS;
    return true;
  }, []);

  const abortPendingScan = useCallback(() => {
    scanTokenRef.current += 1;
    pendingScanControllerRef.current?.abort();
    pendingScanControllerRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      scanTokenRef.current += 1;
      pendingScanControllerRef.current?.abort();
      pendingScanControllerRef.current = null;
    };
  }, []);

  // Hauteur réelle de l’écran (barre d’adresse iOS comprise) et orientation.
  useEffect(() => {
    if (typeof window === "undefined" || isTestEnv) {
      return;
    }
    let rafId = 0;
    const measure = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const viewport = window.visualViewport;
        const width = viewport?.width ?? window.innerWidth;
        const height = viewport?.height ?? window.innerHeight;
        if (!width || !height) {
          return;
        }
        const rounded = Math.round(height);
        setViewportHeight((previous) =>
          previous !== null && Math.abs(previous - rounded) <= 1
            ? previous
            : rounded
        );
        setIsLandscape(width > height);
      });
    };
    measure();
    const delayed = window.setTimeout(measure, 160);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    window.addEventListener("pageshow", measure);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", measure);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      window.clearTimeout(delayed);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.removeEventListener("pageshow", measure);
      viewport?.removeEventListener("resize", measure);
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined" || isTestEnv) {
      return;
    }
    const { body, documentElement } = document;
    const previousOverflow = body.style.overflow;
    const previousOverscroll = documentElement.style.overscrollBehaviorY;

    body.style.overflow = "hidden";
    documentElement.style.overscrollBehaviorY = "contain";

    return () => {
      body.style.overflow = previousOverflow;
      documentElement.style.overscrollBehaviorY = previousOverscroll;
    };
  }, []);

  useEffect(() => {
    if (cameraActive) {
      setHasCameraBooted(true);
    }
  }, [cameraActive]);

  useEffect(() => {
    if (cameraError) {
      setHasCameraBooted(false);
    }
  }, [cameraError]);

  useEffect(() => {
    if (typeof document === "undefined" || isTestEnv) {
      return;
    }
    lastVisibilityStateRef.current = document.visibilityState;
    const handleVisibility = () => {
      const nextState = document.visibilityState;
      if (lastVisibilityStateRef.current === nextState) {
        return;
      }
      lastVisibilityStateRef.current = nextState;
      if (nextState === "hidden") {
        // Toujours relancer la caméra ensuite : sur iOS elle peut ne pas être "active" au moment du hide
        resumeCameraOnVisibleRef.current = true;
        stopCamera();
      } else if (resumeCameraOnVisibleRef.current) {
        resumeCameraOnVisibleRef.current = false;
        void startCamera();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (typeof window === "undefined" || isTestEnv) {
      return;
    }
    const handleLifecycle = () => {
      resumeCameraOnVisibleRef.current = false;
      stopCamera();
    };
    window.addEventListener("pagehide", handleLifecycle);
    window.addEventListener("beforeunload", handleLifecycle);
    return () => {
      window.removeEventListener("pagehide", handleLifecycle);
      window.removeEventListener("beforeunload", handleLifecycle);
    };
  }, [stopCamera]);

  useEffect(() => {
    return () => {
      resumeCameraOnVisibleRef.current = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!selectedUser) {
      navigate("/select-shop", { replace: true });
      return;
    }
    if (!locationId) {
      navigate("/inventory/location", { replace: true });
      return;
    }
    if (!countTypeValue) {
      navigate("/inventory/count-type", { replace: true });
    }
  }, [countTypeValue, locationId, navigate, selectedUser]);

  // Le bandeau « Annuler » disparaît seul après quelques secondes.
  useEffect(() => {
    if (!toast) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setToast((current) => (current?.id === toast.id ? null : current));
    }, UNDO_TOAST_DURATION_MS);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const viewportStyle = useMemo<CSSProperties | undefined>(
    () =>
      viewportHeight
        ? { minHeight: viewportHeight, height: viewportHeight }
        : undefined,
    [viewportHeight]
  );

  const topOverlayStyle = useMemo<CSSProperties>(
    () => ({
      paddingTop: `calc(env(safe-area-inset-top, 0px) + ${
        isLandscape ? 0.75 : 1.1
      }rem)`,
    }),
    [isLandscape]
  );

  const totalQuantity = useMemo(
    () => items.reduce((acc, item) => acc + item.quantity, 0),
    [items]
  );

  const summary = `${items.length} réf. · ${formatPieces(totalQuantity)}`;

  const cameraErrorDescription = useMemo(
    () => (cameraError ? describeCameraError(cameraError) : null),
    [cameraError]
  );

  const ensureScanPrerequisites = useCallback(() => {
    if (!shop?.id) {
      throw new Error(
        "Sélectionnez une boutique valide avant de scanner un produit."
      );
    }
    if (!ownerUserId) {
      throw new Error(
        "Sélectionnez un utilisateur avant de scanner un produit."
      );
    }
    if (!locationId) {
      throw new Error("Sélectionnez une zone avant de scanner un produit.");
    }
    if (!countTypeValue) {
      throw new Error(
        "Choisissez un type de comptage avant de scanner un produit."
      );
    }
  }, [countTypeValue, locationId, ownerUserId, shop?.id]);

  const ensureActiveRun = useCallback(async () => {
    if (sessionRunId) {
      return sessionRunId;
    }
    ensureScanPrerequisites();
    const response = await startInventoryRun(locationId, {
      shopId: shop!.id,
      ownerUserId,
      countType: countTypeValue!,
    });
    const nextRunId =
      typeof response.runId === "string" ? response.runId.trim() : "";
    if (nextRunId) {
      setSessionId(nextRunId);
      return nextRunId;
    }
    return null;
  }, [
    countTypeValue,
    ensureScanPrerequisites,
    locationId,
    ownerUserId,
    sessionRunId,
    setSessionId,
    shop,
  ]);

  /** Traite un code lu (caméra ou photo) : recherche du produit puis ouverture de la fiche. */
  const processCode = useCallback(
    async (rawValue: string) => {
      const code = sanitizeScanValue(rawValue);
      if (!code || isCodeLocked(code)) {
        return;
      }

      if (!isScanLengthValid(code)) {
        lockCode(code);
        triggerScanRejectionFeedback();
        setPanel({
          kind: "error",
          code,
          title: "Code non reconnu",
          message: `Code invalide : ${MAX_SCAN_LENGTH} caractères maximum.`,
        });
        return;
      }

      try {
        ensureScanPrerequisites();
      } catch (error) {
        setPanel({
          kind: "error",
          code,
          title: "Lecture impossible",
          message:
            error instanceof Error
              ? error.message
              : "Impossible de lancer le scan.",
        });
        return;
      }

      abortPendingScan();
      const scanToken = scanTokenRef.current;
      const controller = new AbortController();
      pendingScanControllerRef.current = controller;
      setToast(null);
      setSubmitError(null);
      setPanel({ kind: "lookup", code });

      try {
        const product = await fetchProductByEan(code, {
          signal: controller.signal,
        });
        if (scanToken !== scanTokenRef.current) {
          return;
        }
        const alreadyCounted = findItem(itemsRef.current, product.ean);
        if (alreadyCounted && alreadyCounted.quantity > 0) {
          triggerScanDuplicateFeedback();
        } else {
          successFeedback.play();
        }
        setPanel({ kind: "count", code, product });
      } catch (error) {
        if (scanToken !== scanTokenRef.current) {
          return;
        }
        if (error instanceof AbortedRequestError) {
          setPanel(null);
          return;
        }
        triggerScanRejectionFeedback();
        if (error instanceof RequestTimeoutError) {
          setPanel({
            kind: "error",
            code,
            title: "Lecture trop longue",
            message:
              "Lecture du produit trop longue. Vérifiez la connexion et réessayez.",
          });
        } else if ((error as HttpError)?.status === 404) {
          setPanel({
            kind: "error",
            code,
            title: "Code introuvable",
            message:
              "Ce code n’est pas dans la liste des produits à inventorier.",
            hint: "Rien n’a été compté. Vérifiez l’étiquette puis rescannez.",
          });
        } else {
          setPanel({
            kind: "error",
            code,
            title: "Lecture impossible",
            message: "Échec de la récupération du produit. Réessayez.",
          });
        }
      } finally {
        if (scanToken === scanTokenRef.current) {
          pendingScanControllerRef.current = null;
        }
      }
    },
    [
      abortPendingScan,
      ensureScanPrerequisites,
      isCodeLocked,
      lockCode,
      setPanel,
      successFeedback,
      triggerScanDuplicateFeedback,
      triggerScanRejectionFeedback,
    ]
  );

  const handleCameraDetected = useCallback(
    async (rawValue: string) => {
      // Fiche ouverte : la lecture est suspendue, on ignore toute détection tardive.
      if (panelRef.current) {
        return;
      }
      await processCode(rawValue);
    },
    [processCode]
  );

  const handlePickImage = useCallback(
    async (file: File) => {
      if (photoDecoding || panelRef.current) {
        return;
      }
      abortPendingScan();
      const token = scanTokenRef.current;
      setPhotoDecoding(true);
      setToast(null);
      setPanel({ kind: "lookup", code: null });
      try {
        const value = await decodeBarcodeFromFile(file);
        if (token !== scanTokenRef.current) {
          return;
        }
        if (!value) {
          triggerScanRejectionFeedback();
          setPanel({
            kind: "error",
            code: null,
            title: "Photo illisible",
            message:
              "Aucun code-barres lisible sur la photo. Rapprochez-vous et réessayez.",
          });
          return;
        }
        // Photo prise volontairement : on accepte même un code tout juste traité.
        lockCode(null);
        await processCode(value);
      } catch {
        if (token === scanTokenRef.current) {
          setPanel({
            kind: "error",
            code: null,
            title: "Photo illisible",
            message: "Lecture de la photo impossible. Réessayez.",
          });
        }
      } finally {
        setPhotoDecoding(false);
      }
    },
    [
      abortPendingScan,
      lockCode,
      photoDecoding,
      processCode,
      setPanel,
      triggerScanRejectionFeedback,
    ]
  );

  /** Ferme la fiche courante et ignore un moment le code qu’elle concernait. */
  const closePanelAndResume = useCallback(
    (code: string | null) => {
      if (code) {
        lockCode(code);
      }
      setSubmitError(null);
      setPanel(null);
    },
    [lockCode, setPanel]
  );

  const handleCancelLookup = useCallback(() => {
    const current = panelRef.current;
    abortPendingScan();
    closePanelAndResume(current?.kind === "lookup" ? current.code : null);
  }, [abortPendingScan, closePanelAndResume]);

  const handleConfirmCount = useCallback(
    async (quantity: number) => {
      const current = panelRef.current;
      if (!current || current.kind !== "count" || submitting) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        await ensureActiveRun();
      } catch (error) {
        setSubmitError(
          error instanceof Error && error.message
            ? error.message
            : "Impossible de démarrer le comptage. Réessayez."
        );
        return;
      } finally {
        setSubmitting(false);
      }
      if (panelRef.current !== current) {
        return;
      }
      const { product, code } = current;
      const previousQuantity =
        findItem(itemsRef.current, product.ean)?.quantity ?? null;
      addOrIncrementItem(product, { quantity });
      const total = (previousQuantity ?? 0) + quantity;
      const sku = product.sku?.trim();
      toastSeqRef.current += 1;
      setToast({
        id: toastSeqRef.current,
        ean: product.ean,
        previousQuantity,
        title: `+${quantity} · ${product.name}`,
        detail: `${sku ? `${sku} · ` : ""}total dans la zone : ${total}`,
      });
      closePanelAndResume(code);
    },
    [addOrIncrementItem, closePanelAndResume, ensureActiveRun, submitting]
  );

  const handleUndo = useCallback(() => {
    if (!toast) {
      return;
    }
    if (toast.previousQuantity === null) {
      removeItem(toast.ean);
    } else {
      setQuantity(toast.ean, toast.previousQuantity, { promote: false });
    }
    setToast(null);
  }, [removeItem, setQuantity, toast]);

  const handleOpenList = useCallback(() => {
    setToast(null);
    setPanel({ kind: "list" });
  }, [setPanel]);

  const handleCloseList = useCallback(() => {
    setPanel(null);
  }, [setPanel]);

  const handleEditItem = useCallback(
    (ean: string) => {
      setPanel({ kind: "edit", ean });
    },
    [setPanel]
  );

  const handleConfirmEdit = useCallback(
    (ean: string, quantity: number) => {
      setQuantity(ean, quantity, { promote: false });
      setPanel({ kind: "list" });
    },
    [setPanel, setQuantity]
  );

  const handleRemoveItem = useCallback(
    (ean: string) => {
      removeItem(ean);
      setPanel({ kind: "list" });
    },
    [removeItem, setPanel]
  );

  const handleSwitchCamera = useCallback(() => {
    void torchControllerRef.current?.set(false);
    void switchCamera();
  }, [switchCamera]);

  const handleGoBack = useCallback(() => {
    abortPendingScan();
    void torchControllerRef.current?.set(false);
    resumeCameraOnVisibleRef.current = false;
    stopCamera();
    navigate("/inventory/session");
  }, [abortPendingScan, navigate, stopCamera]);

  const handleTorchStateChange = useCallback((state: TorchState) => {
    setTorchState((current) => {
      if (
        current.supported === state.supported &&
        current.enabled === state.enabled
      ) {
        return current;
      }
      return state;
    });
  }, []);

  const handleTorchToggle = useCallback(() => {
    void torchControllerRef.current?.toggle();
  }, []);

  const editedItem =
    panel?.kind === "edit" ? findItem(items, panel.ean) ?? null : null;
  const countedQuantity =
    panel?.kind === "count"
      ? findItem(items, panel.product.ean)?.quantity ?? 0
      : 0;

  let frameTone: ScanFrameTone = "idle";
  if (panel?.kind === "lookup" && panel.code) {
    frameTone = "success";
  } else if (panel?.kind === "count") {
    frameTone = countedQuantity > 0 ? "warning" : "success";
  } else if (panel?.kind === "error") {
    frameTone = "error";
  }

  const torchButtonActionLabel = torchState.enabled
    ? "Eteindre la lampe"
    : "Allumer la lampe";

  let sheet: ReactNode = null;
  if (panel?.kind === "lookup") {
    sheet = <ScanLookupSheet code={panel.code} onCancel={handleCancelLookup} />;
  } else if (panel?.kind === "count") {
    sheet = (
      <ScanCountSheet
        key={`count-${panel.code}-${panel.product.ean}`}
        mode="count"
        product={panel.product}
        currentQuantity={countedQuantity}
        submitting={submitting}
        error={submitError}
        onConfirm={(quantity) => void handleConfirmCount(quantity)}
        onCancel={() => closePanelAndResume(panel.code)}
      />
    );
  } else if (panel?.kind === "error") {
    sheet = (
      <ScanErrorSheet
        title={panel.title}
        message={panel.message}
        code={panel.code}
        hint={panel.hint}
        onRetry={() => closePanelAndResume(panel.code)}
      />
    );
  } else if (panel?.kind === "edit" && editedItem) {
    sheet = (
      <ScanCountSheet
        key={`edit-${editedItem.id}`}
        mode="edit"
        product={editedItem.product}
        currentQuantity={editedItem.quantity}
        onConfirm={(quantity) =>
          handleConfirmEdit(editedItem.product.ean, quantity)
        }
        onCancel={handleOpenList}
        onRemove={() => handleRemoveItem(editedItem.product.ean)}
      />
    );
  } else if (panel?.kind === "list" || panel?.kind === "edit") {
    sheet = (
      <ScanItemsSheet
        shopName={shopName}
        locationLabel={locationLabel}
        summary={summary}
        items={items}
        onEdit={handleEditItem}
        onClose={handleCloseList}
      />
    );
  }

  // Plein écran, rendu directement dans <body> : la carte de l’assistant (flou d’arrière-plan)
  // piégerait sinon les éléments fixes, et le bas de l’écran (barre, fiches) sortirait de l’écran
  // du téléphone, le défilement étant bloqué pendant le scan.
  // Sur iOS, le son n’est autorisé qu’après un geste : chaque appui débloque le bip de lecture.
  return createPortal(
    <div
      className="scan-camera-screen fixed inset-0 z-30 flex h-dvh flex-col overflow-hidden bg-black text-white"
      data-testid="scan-camera-page"
      style={viewportStyle}
      onClickCapture={successFeedback.unlock}
    >
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <BarcodeScanner
          active={cameraActive}
          paused={panel !== null || photoDecoding}
          frameTone={frameTone}
          onDetected={handleCameraDetected}
          onPickImage={handlePickImage}
          presentation="immersive"
          enableTorchToggle
          onTorchStateChange={handleTorchStateChange}
          torchControllerRef={torchControllerRef}
          camera={{ videoRef, active: cameraActive, error: cameraError }}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-linear-to-b from-black/80 via-black/40 to-transparent" />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between px-4 sm:px-8"
          style={topOverlayStyle}
        >
          <button
            type="button"
            className="pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-black/60 px-4 text-sm font-semibold text-white shadow-lg backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            onClick={handleGoBack}
            data-testid="scan-camera-back"
          >
            <span aria-hidden className="text-base">
              ←
            </span>
            Retour
          </button>
          <div className="flex items-center gap-2">
            {canSwitchCamera && (
              <button
                type="button"
                className="pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-black/60 px-3.5 text-xs font-semibold text-white shadow-lg backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={handleSwitchCamera}
                aria-label="Changer de caméra"
                title="Changer de caméra"
                disabled={!cameraActive}
                data-testid="scan-camera-switch"
              >
                <span aria-hidden className="text-sm">⟲</span>
                Caméra
              </button>
            )}
            {torchState.supported && (
              <button
                type="button"
                className={`pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full px-3.5 text-xs font-semibold shadow-lg backdrop-blur transition focus-visible:outline-none focus-visible:ring-2 ${
                  torchState.enabled
                    ? "bg-amber-400/20 text-amber-100 hover:bg-amber-400/30 focus-visible:ring-amber-200"
                    : "bg-black/60 text-white hover:bg-black/70 focus-visible:ring-white/70"
                } disabled:cursor-not-allowed disabled:opacity-60`}
                onClick={handleTorchToggle}
                aria-pressed={torchState.enabled}
                aria-label={torchButtonActionLabel}
                title={torchButtonActionLabel}
                disabled={!cameraActive}
                data-testid="scan-camera-torch-toggle"
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full ${
                    torchState.enabled ? "bg-amber-200" : "bg-white/70"
                  }`}
                />
                Lampe
              </button>
            )}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-20 flex justify-center px-6">
          {!cameraActive && !cameraError && !hasCameraBooted && (
            <span className="rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white shadow-lg backdrop-blur">
              Démarrage caméra…
            </span>
          )}
          {!cameraActive && !cameraError && hasCameraBooted && (
            <span className="rounded-full bg-black/70 px-3 py-1 text-sm font-semibold text-white/80 shadow-lg backdrop-blur">
              Caméra en pause
            </span>
          )}
        </div>
        {cameraErrorDescription && (
          <div
            className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-8"
            data-testid="scan-camera-error"
          >
            <div className="max-w-sm rounded-3xl bg-black/70 px-5 py-4 text-center shadow-lg backdrop-blur">
              <p className="text-sm font-semibold text-rose-200">
                Caméra indisponible
              </p>
              <p className="mt-1 text-sm text-white">
                {cameraErrorDescription.message}
              </p>
              {cameraErrorDescription.technical && (
                <p className="mt-2 text-[11px] text-white/60">
                  {cameraErrorDescription.technical}
                </p>
              )}
            </div>
          </div>
        )}
        {toast && !panel && (
          <ScanUndoToast
            title={toast.title}
            detail={toast.detail}
            onUndo={handleUndo}
          />
        )}
      </div>

      <div
        className="flex-none px-3 pt-3"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.75rem)" }}
      >
        <div
          className="mx-auto flex h-[68px] max-w-lg items-center gap-3 rounded-[20px] bg-white pl-4 pr-2.5 text-slate-900 shadow-lg dark:bg-slate-900 dark:text-white"
          data-testid="scan-summary-bar"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight">
              {locationLabel}
            </p>
            <p
              className="truncate text-[13px] text-slate-600 dark:text-slate-300"
              data-testid="scan-summary"
            >
              {summary}
            </p>
          </div>
          <button
            type="button"
            className="flex h-12 flex-none items-center gap-2 rounded-[14px] bg-brand-600 px-4 text-[15px] font-semibold text-white transition active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
            onClick={handleOpenList}
            data-testid="scan-open-list"
          >
            <ListIcon />
            Liste
          </button>
        </div>
      </div>

      {panel && (
        <div
          className="pointer-events-none fixed inset-x-0 z-[41] flex justify-center"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 4.5rem)" }}
          aria-hidden
        >
          <span className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-[13px] font-semibold text-slate-200">
            <span className="block h-2 w-2 rounded-full bg-amber-400" />
            Lecture en pause
          </span>
        </div>
      )}
      {sheet}
    </div>,
    document.body
  );
};

export default ScanCameraPage;
