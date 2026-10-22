import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useNavigate } from "react-router-dom";

import { fetchProductByEan, startInventoryRun } from "../../api/inventoryApi";
import {
  BarcodeScanner,
  type TorchController,
  type TorchState,
} from "../../components/BarcodeScanner";
import { ScannedRow } from "../../components/inventory/ScannedRow";
import { useInventory, type InventoryItemMutationResult } from "../../contexts/InventoryContext";
import type { Product } from "../../types/inventory";

import { useCamera, type CameraOptions } from "@/hooks/useCamera";
import { useScanDuplicateFeedback } from "@/hooks/useScanDuplicateFeedback";
import { useScanRejectionFeedback } from "@/hooks/useScanRejectionFeedback";
import {
  AbortedRequestError,
  RequestTimeoutError,
  type HttpError,
} from "@/lib/api/http";
import { decodeBarcodeFromFile } from "@/lib/scan/barcodeDetector";
import { describeCameraError } from "@/lib/scan/cameraErrors";
import { useShop } from "@/state/ShopContext";

const MAX_SCAN_LENGTH = 32;
const LOCK_RELEASE_DELAY = 700;
const isTestEnv =
  typeof import.meta !== "undefined" && import.meta.env?.MODE === "test";

const sanitizeScanValue = (value: string) => value.replace(/[\r\n\t]+/g, "");

const isScanLengthValid = (code: string) =>
  code.length > 0 && code.length <= MAX_SCAN_LENGTH;

type StatusTone = "info" | "success" | "warning";

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
  const [statusMessage, setStatusMessage] =
    useState<{ text: string; tone: StatusTone } | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightEan, setHighlightEan] = useState<string | null>(null);
  const [pendingScan, setPendingScan] = useState<{
    ean: string;
    startedAt: number;
  } | null>(null);
  const [pendingScanElapsedMs, setPendingScanElapsedMs] = useState(0);
  const highlightTimeoutRef = useRef<number | null>(null);
  const statusTimeoutRef = useRef<number | null>(null);
  const lockTimeoutRef = useRef<number | null>(null);
  const pendingScanControllerRef = useRef<AbortController | null>(null);
  const scanTokenRef = useRef(0);
  const lockedEanRef = useRef<string | null>(null);
  const resumeCameraOnVisibleRef = useRef(false);
  const lastVisibilityStateRef = useRef<string | null>(
    typeof document !== "undefined" ? document.visibilityState : null
  );
  const scheduleMeasureRef = useRef<(() => void) | null>(null);
  const pendingFocusEanRef = useRef<string | null>(null);
  const [matchMediaLandscape, setMatchMediaLandscape] = useState<boolean>(
    () => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return false;
      }
      return window.matchMedia("(orientation: landscape)").matches;
    }
  );
  const [viewportSize, setViewportSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [torchState, setTorchState] = useState<TorchState>({
    supported: false,
    enabled: false,
  });
  const triggerScanDuplicateFeedback = useScanDuplicateFeedback();
  const triggerScanRejectionFeedback = useScanRejectionFeedback();
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
  const [photoDecoding, setPhotoDecoding] = useState(false);

  const shopName = shop?.name ?? "Boutique";
  const ownerUserId = selectedUser?.id?.trim() ?? "";
  const locationId = location?.id?.trim() ?? "";
  const countTypeValue = typeof countType === "number" ? countType : null;
  const sessionRunId = typeof sessionId === "string" ? sessionId.trim() : "";
  const [hasCameraBooted, setHasCameraBooted] = useState(false);
  const clearPendingScanState = useCallback(() => {
    pendingScanControllerRef.current = null;
    setPendingScan(null);
    setPendingScanElapsedMs(0);
  }, []);

  const showStatusMessage = useCallback(
    (message: string | null, tone: StatusTone = "info") => {
      if (!message) {
        setStatusMessage(null);
        return;
      }
      setStatusMessage({ text: message, tone });
    },
    []
  );

  useEffect(() => {
    return () => {
      if (pendingScanControllerRef.current) {
        scanTokenRef.current += 1;
        pendingScanControllerRef.current.abort();
        clearPendingScanState();
      }
    };
  }, [clearPendingScanState]);

  useEffect(() => {
    if (!pendingScan) {
      setPendingScanElapsedMs((current) => (current === 0 ? current : 0));
      return;
    }
    setPendingScanElapsedMs(Date.now() - pendingScan.startedAt);
    const intervalId = window.setInterval(() => {
      setPendingScanElapsedMs(Date.now() - pendingScan.startedAt);
    }, 250);
    return () => window.clearInterval(intervalId);
  }, [pendingScan]);

  const commitViewportSize = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    const visualViewport = window.visualViewport;
    const nextWidth =
      visualViewport?.width ??
      window.innerWidth ??
      document.documentElement?.clientWidth ??
      0;
    const nextHeight =
      visualViewport?.height ??
      window.innerHeight ??
      document.documentElement?.clientHeight ??
      0;

    if (!nextWidth || !nextHeight) {
      return;
    }

    const rounded = {
      width: Math.round(nextWidth),
      height: Math.round(nextHeight),
    };

    setViewportSize((previous) => {
      if (!previous) {
        return rounded;
      }
      if (
        Math.abs(previous.width - rounded.width) <= 1 &&
        Math.abs(previous.height - rounded.height) <= 1
      ) {
        return previous;
      }
      return rounded;
    });

    if (typeof window.matchMedia !== "function") {
      setMatchMediaLandscape(rounded.width > rounded.height);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (isTestEnv) {
      return;
    }

    let rafId = 0;
    const schedule = () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        commitViewportSize();
      });
    };

    scheduleMeasureRef.current = schedule;
    schedule();
    const delayed = window.setTimeout(schedule, 160);

    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    window.addEventListener("pageshow", schedule);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", schedule);
    visualViewport?.addEventListener("scroll", schedule);

    return () => {
      scheduleMeasureRef.current = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      window.clearTimeout(delayed);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("pageshow", schedule);
      visualViewport?.removeEventListener("resize", schedule);
      visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [commitViewportSize]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return;
    }
    if (isTestEnv) {
      return;
    }
    const query = window.matchMedia("(orientation: landscape)");
    const handleChange = (event: MediaQueryListEvent) => {
      setMatchMediaLandscape(event.matches);
      commitViewportSize();
    };
    const handleLegacy = (event: MediaQueryListEvent) => {
      handleChange(event);
    };
    setMatchMediaLandscape(query.matches);
    commitViewportSize();
    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", handleChange);
      return () => {
        query.removeEventListener("change", handleChange);
      };
    }
    query.addListener(handleLegacy);
    return () => {
      query.removeListener(handleLegacy);
    };
  }, [commitViewportSize]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    if (isTestEnv) {
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
    if (typeof document === "undefined") {
      return;
    }
    if (isTestEnv) {
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
      } else {
        if (resumeCameraOnVisibleRef.current) {
          resumeCameraOnVisibleRef.current = false;
          void startCamera();
          requestAnimationFrame(() => scheduleMeasureRef.current?.());
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [cameraActive, startCamera, stopCamera]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (isTestEnv) {
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

  const viewportHeight = viewportSize?.height ?? null;
  const viewportWidth = viewportSize?.width ?? null;
  const isLandscape = useMemo(() => {
    if (viewportHeight !== null && viewportWidth !== null) {
      if (viewportWidth === viewportHeight) {
        return matchMediaLandscape;
      }
      return viewportWidth > viewportHeight;
    }
    return matchMediaLandscape;
  }, [matchMediaLandscape, viewportHeight, viewportWidth]);

  const cameraSectionPixels = useMemo(() => {
    if (!viewportHeight) {
      return null;
    }
    const minHeight = isLandscape ? 220 : 320;
    const reserve = isLandscape ? 180 : 240;
    const maxHeight = Math.max(viewportHeight - reserve, minHeight);
    const target = Math.round(viewportHeight * (isLandscape ? 0.5 : 0.58));
    return Math.min(Math.max(target, minHeight), maxHeight);
  }, [isLandscape, viewportHeight]);

  const viewportStyle = useMemo<CSSProperties | undefined>(() => {
    if (!viewportHeight) {
      return undefined;
    }
    return {
      minHeight: viewportHeight,
      height: viewportHeight,
    };
  }, [viewportHeight]);

  const cameraSectionStyle = useMemo<CSSProperties>(() => {
    if (!cameraSectionPixels) {
      return {
        minHeight: isLandscape ? "50vh" : "58vh",
      };
    }
    return {
      height: cameraSectionPixels,
      minHeight: cameraSectionPixels,
    };
  }, [cameraSectionPixels, isLandscape]);

  const bottomSectionPaddingStyle = useMemo<CSSProperties>(
    () => ({
      paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.5rem)",
    }),
    []
  );

  const bottomSectionStyle = useMemo<CSSProperties>(() => {
    if (!viewportHeight || !cameraSectionPixels) {
      return bottomSectionPaddingStyle;
    }
    const minimum = isLandscape ? 200 : 260;
    const available = Math.max(viewportHeight - cameraSectionPixels, minimum);
    return {
      ...bottomSectionPaddingStyle,
      height: available,
      minHeight: available,
      maxHeight: available,
    };
  }, [
    bottomSectionPaddingStyle,
    cameraSectionPixels,
    isLandscape,
    viewportHeight,
  ]);

  const topOverlayStyle = useMemo<CSSProperties>(
    () => ({
      paddingTop: `calc(env(safe-area-inset-top, 0px) + ${
        isLandscape ? 0.75 : 1.1
      }rem)`,
    }),
    [isLandscape]
  );

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

  useEffect(() => {
    return () => {
      resumeCameraOnVisibleRef.current = false;
      stopCamera();
      if (highlightTimeoutRef.current) {
        window.clearTimeout(highlightTimeoutRef.current);
        highlightTimeoutRef.current = null;
      }
      if (statusTimeoutRef.current) {
        window.clearTimeout(statusTimeoutRef.current);
        statusTimeoutRef.current = null;
      }
      if (lockTimeoutRef.current) {
        window.clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      lockedEanRef.current = null;
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!highlightEan) {
      return;
    }
    if (highlightTimeoutRef.current) {
      window.clearTimeout(highlightTimeoutRef.current);
    }
    highlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightEan(null);
      highlightTimeoutRef.current = null;
    }, 700);
  }, [highlightEan]);

  useEffect(() => {
    const targetEan = pendingFocusEanRef.current;
    if (!targetEan) {
      return;
    }
    const quantityInput = document.querySelector<HTMLInputElement>(
      `[data-ean="${targetEan}"] input[data-testid="quantity-input"]`
    );
    if (quantityInput) {
      requestAnimationFrame(() => {
        quantityInput.focus({ preventScroll: true });
        quantityInput.select?.();
      });
    }
    pendingFocusEanRef.current = null;
  }, [items]);

  useEffect(() => {
    if (!statusMessage) {
      return;
    }
    if (statusTimeoutRef.current) {
      window.clearTimeout(statusTimeoutRef.current);
    }
    statusTimeoutRef.current = window.setTimeout(() => {
      showStatusMessage(null);
      statusTimeoutRef.current = null;
    }, 2200);
  }, [showStatusMessage, statusMessage]);

  const totalQuantity = useMemo(
    () => items.reduce((acc, item) => acc + item.quantity, 0),
    [items]
  );

  const orderedItems = items;

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
    if (items.length > 0 && sessionRunId) {
      return sessionRunId;
    }
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
    items.length,
    locationId,
    ownerUserId,
    sessionRunId,
    setSessionId,
    shop,
  ]);

  const addProductToSession = useCallback(
    async (product: Product) => {
      try {
        await ensureActiveRun();
      } catch (error) {
        showStatusMessage(null);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Impossible de démarrer le comptage."
        );
        return null;
      }
      const result = addOrIncrementItem(product);
      if (result.status === 'existing') {
        const normalizedEan = product.ean?.trim();
        if (normalizedEan) {
          pendingFocusEanRef.current = normalizedEan;
        }
        triggerScanDuplicateFeedback();
      }
      return result;
    },
    [addOrIncrementItem, ensureActiveRun, showStatusMessage, triggerScanDuplicateFeedback]
  );

  const armScanLock = useCallback(
    (ean: string | null, delayMs: number = LOCK_RELEASE_DELAY) => {
      if (lockTimeoutRef.current) {
        window.clearTimeout(lockTimeoutRef.current);
        lockTimeoutRef.current = null;
      }
      lockedEanRef.current = ean;
      if (!ean) {
        return;
      }
      lockTimeoutRef.current = window.setTimeout(() => {
        lockedEanRef.current = null;
        lockTimeoutRef.current = null;
      }, Math.max(0, delayMs));
    },
    []
  );

  const refreshScanLock = useCallback(() => {
    const current = lockedEanRef.current;
    if (!current) {
      return;
    }
    armScanLock(current);
  }, [armScanLock]);

  const handleProductScanOutcome = useCallback(
    (product: Product, mutation: InventoryItemMutationResult) => {
      if (mutation.status === "existing") {
        showStatusMessage(`${product.name} déjà scanné précédemment`, "warning");
      } else {
        showStatusMessage(`${product.name} ajouté`, "success");
      }
      const normalizedEan = product.ean?.trim() ?? null;
      if (normalizedEan) {
        setHighlightEan(normalizedEan);
      } else {
        setHighlightEan(null);
      }
    },
    [showStatusMessage]
  );

  const handleCancelPendingScan = useCallback(() => {
    if (!pendingScanControllerRef.current) {
      return;
    }
    scanTokenRef.current += 1;
    pendingScanControllerRef.current.abort();
    clearPendingScanState();
    showStatusMessage(null);
    setErrorMessage("Lecture annulée.");
    armScanLock(null);
  }, [armScanLock, clearPendingScanState, showStatusMessage]);

  const handleDetected = useCallback(
    async (rawValue: string) => {
      const sanitized = sanitizeScanValue(rawValue);
      if (!sanitized) {
        return;
      }

      // Éviter les détections concurrentes pendant qu’un scan produit est en cours
      if (pendingScanControllerRef.current) {
        // Optionnel: petit feedback (bip/flash) pour signaler "patienter"
        triggerScanRejectionFeedback();
        return;
      }

      if (lockedEanRef.current && lockedEanRef.current === sanitized) {
        refreshScanLock();
        return;
      }

      if (!isScanLengthValid(sanitized)) {
        setErrorMessage(
          `Code ${sanitized} invalide : ${MAX_SCAN_LENGTH} caractères maximum.`
        );
        showStatusMessage(null);
        armScanLock(sanitized);
        return;
      }

      try {
        ensureScanPrerequisites();
      } catch (error) {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Impossible de lancer le scan."
        );
        showStatusMessage(null);
        armScanLock(null);
        return;
      }

      const scanToken = scanTokenRef.current + 1;
      scanTokenRef.current = scanToken;
      pendingScanControllerRef.current?.abort();
      const scanController = new AbortController();
      pendingScanControllerRef.current = scanController;
      setPendingScan({ ean: sanitized, startedAt: Date.now() });
      armScanLock(sanitized, 200); // petit lock court pour éviter les doubles lectures instantanées
      showStatusMessage(`Lecture de ${sanitized}.`);
      setErrorMessage(null);

      try {
        const product = await fetchProductByEan(sanitized, {
          signal: scanController.signal,
        });
        if (scanToken !== scanTokenRef.current) {
          return;
        }
        const mutation = await addProductToSession(product);
        if (scanToken !== scanTokenRef.current) {
          return;
        }
        if (mutation) {
          handleProductScanOutcome(product, mutation);
          armScanLock(sanitized, LOCK_RELEASE_DELAY); // lock standard de 700 ms
        }
      } catch (error) {
        if (scanToken !== scanTokenRef.current) {
          return;
        }
        if (error instanceof AbortedRequestError) {
          setErrorMessage(null);
          showStatusMessage(null);
        } else if (error instanceof RequestTimeoutError) {
          setErrorMessage(
            "Lecture du produit trop longue. Vérifiez la connexion et réessayez."
          );
          triggerScanRejectionFeedback();
          showStatusMessage(null);
        } else {
          const err = error as HttpError;
          if (err?.status === 404) {
            setErrorMessage(
              `Code ${sanitized} introuvable dans la liste des produits à inventorier.`
            );
            triggerScanRejectionFeedback();
          } else {
            setErrorMessage("Échec de la récupération du produit. Réessayez.");
          }
          showStatusMessage(null);
        }
      } finally {
        if (scanToken === scanTokenRef.current) {
          clearPendingScanState();
        }
      }
    },
    [
      addProductToSession,
      armScanLock,
      clearPendingScanState,
      ensureScanPrerequisites,
      handleProductScanOutcome,
      refreshScanLock,
      showStatusMessage,
      triggerScanRejectionFeedback,
    ]
  );
  const handlePickImage = useCallback(
    async (file: File) => {
      if (photoDecoding) {
        return;
      }
      setPhotoDecoding(true);
      setErrorMessage(null);
      showStatusMessage("Analyse de la photo…");
      try {
        const value = await decodeBarcodeFromFile(file);
        if (!value) {
          showStatusMessage(null);
          setErrorMessage(
            "Aucun code-barres lisible sur la photo. Rapprochez-vous et réessayez."
          );
          triggerScanRejectionFeedback();
          return;
        }
        armScanLock(null);
        await handleDetected(value);
      } catch {
        showStatusMessage(null);
        setErrorMessage("Lecture de la photo impossible. Réessayez.");
      } finally {
        setPhotoDecoding(false);
      }
    },
    [
      armScanLock,
      handleDetected,
      photoDecoding,
      showStatusMessage,
      triggerScanRejectionFeedback,
    ]
  );

  const handleSwitchCamera = useCallback(() => {
    void torchControllerRef.current?.set(false);
    void switchCamera();
  }, [switchCamera]);

  const handleGoBack = useCallback(() => {
    if (pendingScanControllerRef.current) {
      scanTokenRef.current += 1;
      pendingScanControllerRef.current.abort();
      clearPendingScanState();
      armScanLock(null);
    }
    void torchControllerRef.current?.set(false);
    resumeCameraOnVisibleRef.current = false;
    stopCamera();
    navigate("/inventory/session");
  }, [armScanLock, clearPendingScanState, navigate, stopCamera]);

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
    const controller = torchControllerRef.current;
    if (!controller) {
      return;
    }
    void controller.toggle();
  }, []);

  const handleDec = useCallback(
    (ean: string, quantity: number) => {
      if (quantity <= 1) {
        removeItem(ean);
        return;
      }
      setQuantity(ean, quantity - 1, { promote: false });
    },
    [removeItem, setQuantity]
  );

  const handleInc = useCallback(
    (ean: string, quantity: number) => {
      setQuantity(ean, quantity + 1, { promote: false });
    },
    [setQuantity]
  );

  const handleSetQuantity = useCallback(
    (ean: string, next: number | null) => {
      if (next === null) {
        return;
      }
      if (next <= 0) {
        removeItem(ean);
        return;
      }
      setQuantity(ean, next);
    },
    [removeItem, setQuantity]
  );

  const torchButtonActionLabel = torchState.enabled
    ? "Eteindre la lampe"
    : "Allumer la lampe";

  return (
    <div
      className="scan-camera-screen relative flex min-h-dvh h-dvh flex-col overflow-hidden bg-black text-white"
      data-testid="scan-camera-page"
      style={viewportStyle}
    >
      <div
        className="relative flex-none overflow-hidden"
        style={cameraSectionStyle}
      >
        <BarcodeScanner
          active={cameraActive}
          onDetected={handleDetected}
          onPickImage={handlePickImage}
          presentation="immersive"
          enableTorchToggle
          onTorchStateChange={handleTorchStateChange}
          torchControllerRef={torchControllerRef}
          camera={{ videoRef, active: cameraActive, error: cameraError }}
        />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-28 bg-linear-to-b from-black/80 via-black/40 to-transparent" />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between px-5 sm:px-8"
          style={topOverlayStyle}
        >
          <button
            type="button"
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm font-semibold text-white shadow-lg backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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
                className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:cursor-not-allowed disabled:opacity-60"
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
              className={`pointer-events-auto inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold shadow-lg backdrop-blur transition focus-visible:outline-none focus-visible:ring-2 ${
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
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col rounded-t-4xl bg-white text-slate-900 shadow-[0_-20px_48px_-32px_rgba(15,23,42,0.55)] transition-colors duration-300 dark:bg-slate-950 dark:text-white"
        style={bottomSectionStyle}
        data-testid="scan-sheet"
      >
        <div className="flex items-center justify-between gap-4 px-6 pt-6">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.28em] text-slate-400 dark:text-slate-500">
              {shopName}
            </p>
            <p className="mt-2 truncate text-lg font-semibold leading-tight text-slate-900 dark:text-white">
              {location?.label ?? "Zone inconnue"}
            </p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-900/90 px-3 py-1 text-sm font-semibold text-white dark:bg-slate-700/80">
            {totalQuantity} pièce{totalQuantity > 1 ? "s" : ""}
          </span>
        </div>
        <div className="space-y-2 px-6 pt-3">
          {pendingScan && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  Lecture de {pendingScan.ean}…{" "}
                  {Math.max(1, Math.round(pendingScanElapsedMs / 1000))} s
                </span>
                <button
                  type="button"
                  className="rounded-full border border-amber-300 px-3 py-1 text-xs font-semibold text-amber-900 transition hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:border-amber-500/50 dark:text-amber-50 dark:hover:bg-amber-500/20"
                  onClick={handleCancelPendingScan}
                >
                  Annuler
                </button>
              </div>
            </div>
          )}
          {statusMessage && (
            <div
              className={`rounded-2xl px-3 py-2 text-xs font-semibold ${
                statusMessage.tone === "warning"
                  ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-100"
                  : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200"
              }`}
            >
              {statusMessage.text}
            </div>
          )}
          {errorMessage && (
            <div className="rounded-2xl bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-600 dark:bg-rose-500/10 dark:text-rose-200">
              {errorMessage}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-10 pt-4">
          {orderedItems.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Scannez un article pour commencer le comptage.
            </p>
          ) : (
            <ul className="space-y-3">
              {orderedItems.map((item) => {
                const ean = item.product.ean;
                return (
                  <ScannedRow
                    key={item.id}
                    id={item.id}
                    ean={item.product.ean}
                    label={item.product.name}
                    sku={item.product.sku}
                    subGroup={item.product.subGroup}
                    qty={item.quantity}
                    highlight={highlightEan === item.product.ean}
                    hasConflict={Boolean(item.hasConflict)}
                    onInc={() => handleInc(ean, item.quantity)}
                    onDec={() => handleDec(ean, item.quantity)}
                    onSetQty={(value) => handleSetQuantity(ean, value)}
                  />
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ScanCameraPage;
