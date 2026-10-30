import { useEffect, useRef, useState } from "react";

import { getBarcodeDetector, type ScanDetector } from "@/lib/scan/barcodeDetector";
import { describeCameraError } from "@/lib/scan/cameraErrors";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function beep() {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) {
    return;
  }

  try {
    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.type = "sine";
    oscillator.frequency.value = 880;
    gain.gain.value = 0.05;
    oscillator.start();

    window.setTimeout(() => {
      try {
        oscillator.stop();
      } catch (error) {
        void error;
      }
      void context.close().catch(() => undefined);
    }, 120);
  } catch (error) {
    void error;
  }
}

function haptic() {
  if (typeof navigator.vibrate === "function") {
    navigator.vibrate(50);
  }
}

const isCameraSupported = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  (typeof window === "undefined" || window.isSecureContext !== false);

export function BarcodeCameraButton(props: { onDetected?: (value: string) => void }) {
  const supported = isCameraSupported();
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectorRef = useRef<ScanDetector | null>(null);

  function stop() {
    activeRef.current = false;
    setActive(false);
    const video = videoRef.current;
    if (video) {
      try {
        void video.pause();
      } catch (error) {
        void error;
      }
      video.srcObject = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    detectorRef.current = null;
  }

  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  async function start() {
    if (!supported) return;
    setError(null);
    try {
      detectorRef.current = await getBarcodeDetector(["EAN_13", "EAN_8", "CODE_128"]);
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const video = videoRef.current;
      if (video) {
        video.srcObject = streamRef.current;
        await video.play();
      }
      activeRef.current = true;
      setActive(true);
      requestAnimationFrame(scan);
    } catch (err) {
      const { message, technical } = describeCameraError(err);
      setError(technical ? `${message} (${technical})` : message);
      stop();
    }
  }

  async function scan() {
    const video = videoRef.current;
    const detector = detectorRef.current;
    if (!activeRef.current || !video || !detector) return;
    try {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        const codes = await detector.detect(video);
        if (codes && codes.length > 0) {
          const raw = String(codes[0].rawValue).trim();
          if (raw) {
            beep();
            haptic();
            props.onDetected?.(raw);
            stop();
            return;
          }
        }
      }
    } catch (error) {
      void error;
    }
    if (activeRef.current) {
      requestAnimationFrame(scan);
    }
  }

  if (!supported) {
    return (
      <button type="button" disabled title="Accès caméra indisponible dans ce navigateur">
        Caméra non supportée
      </button>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <button type="button" onClick={() => (active ? stop() : void start())}>
        {active ? "Arrêter caméra" : "Activer caméra"}
      </button>
      {active && <video ref={videoRef} style={{ width: 160, height: 120, background: "#000" }} muted playsInline />}
      {error && <span style={{ fontSize: 12, color: "#b91c1c" }}>{error}</span>}
    </span>
  );
}
