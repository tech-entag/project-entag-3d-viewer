'use client'

import { useEffect, useState } from "react";

const TOKEN_LOOKUP_DEFAULT_ATTEMPTS = 300;
const CACHE_ONLY_LOOKUP_DEFAULT_ATTEMPTS = 24;
const LOOKUP_ATTEMPT_LIMIT = 900;
const TOKEN_LOOKUP_DEFAULT_INTERVAL_MS = 4000;
const CACHE_ONLY_LOOKUP_DEFAULT_INTERVAL_MS = 5000;
const LOOKUP_INTERVAL_LIMIT_MS = 60000;
const AUTODESK_READY_TIMEOUT_MS = 8000;
const AUTODESK_READY_POLL_INTERVAL_MS = 50;
const LOCAL_ONLY_UNAVAILABLE_MESSAGE = "No local viewer source is ready for this URN yet. Cloud fallback is disabled.";

const normalizeRequestedToken = (value: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "undefined" || normalized === "null") {
    return null;
  }

  return trimmed;
};

const waitForAutodeskViewing = async () => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < AUTODESK_READY_TIMEOUT_MS) {
    const autodesk = (window as Window & { Autodesk?: typeof Autodesk }).Autodesk;
    if (
      autodesk?.Viewing
      && typeof autodesk.Viewing.GuiViewer3D === "function"
      && typeof autodesk.Viewing.Initializer === "function"
    ) {
      return autodesk;
    }

    await new Promise((resolve) => setTimeout(resolve, AUTODESK_READY_POLL_INTERVAL_MS));
  }

  return null;
};

function Viewer() {
  const searchParams = new URLSearchParams(window.location.search);
  const requestedUrn = searchParams.get("urn");
  const requestedToken = normalizeRequestedToken(
    searchParams.get("access_token") || searchParams.get("accessToken")
  );
  const requestedLocalModelUrl = searchParams.get("localModelUrl") || searchParams.get("bubbleUrl");
  const requestedLookupAttempts = Number(searchParams.get("lookupAttempts"));
  const requestedLookupIntervalMs = Number(searchParams.get("lookupIntervalMs"));

  const [urn] = useState<string | null>(requestedUrn);
  const [localModelUrl] = useState<string | null>(requestedLocalModelUrl);
  const [resolvedLocalModelUrl, setResolvedLocalModelUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const shouldResolveUrnToLocal = Boolean(urn && !requestedLocalModelUrl);
  const [urnResolutionCompleted, setUrnResolutionCompleted] = useState<boolean>(!shouldResolveUrnToLocal);

  const effectiveLocalModelUrl = localModelUrl || resolvedLocalModelUrl;
  const localModelUrlFromQuery = searchParams.get("localModelUrl") || searchParams.get("bubbleUrl");
  const modelUrlToLoad = effectiveLocalModelUrl || localModelUrlFromQuery;
  const isLocalMode = Boolean(modelUrlToLoad);

  useEffect(() => {
    if (!urn || requestedLocalModelUrl || resolvedLocalModelUrl) {
      setUrnResolutionCompleted(true);
      return;
    }

    let isCancelled = false;
    const defaultMaxAttempts = requestedToken ? TOKEN_LOOKUP_DEFAULT_ATTEMPTS : CACHE_ONLY_LOOKUP_DEFAULT_ATTEMPTS;
    const defaultRetryDelayMs = requestedToken
      ? TOKEN_LOOKUP_DEFAULT_INTERVAL_MS
      : CACHE_ONLY_LOOKUP_DEFAULT_INTERVAL_MS;
    const maxAttempts = Number.isFinite(requestedLookupAttempts) && requestedLookupAttempts > 0
      ? Math.min(Math.floor(requestedLookupAttempts), LOOKUP_ATTEMPT_LIMIT)
      : defaultMaxAttempts;
    const retryDelayMs = Number.isFinite(requestedLookupIntervalMs) && requestedLookupIntervalMs > 0
      ? Math.min(Math.floor(requestedLookupIntervalMs), LOOKUP_INTERVAL_LIMIT_MS)
      : defaultRetryDelayMs;

    setUrnResolutionCompleted(false);

    const resolveUrnToLocalBubble = async () => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (isCancelled) {
          return;
        }

        try {
          const lookupParams = new URLSearchParams({
            urn,
          });
          if (requestedToken) {
            lookupParams.set("access_token", requestedToken);
          }

          const response = await fetch(`/api/viewer-source?${lookupParams.toString()}`);

          if (response.ok) {
            const payload = await response.json() as { localModelUrl?: string; bubbleUrl?: string };
            const nextLocalModelUrl = payload?.localModelUrl || payload?.bubbleUrl;
            if (!isCancelled && nextLocalModelUrl) {
              setResolvedLocalModelUrl(nextLocalModelUrl);
              setUrnResolutionCompleted(true);
              return;
            }
          } else if (response.status === 404) {
            // Local source is still being prepared; continue polling.
          } else if (response.status === 503) {
            throw new Error("Local viewer cache is unavailable (blob token missing).");
          } else {
            let message = `Viewer source lookup failed (${response.status}).`;
            try {
              const payload = await response.json() as { error?: string; details?: string };
              if (payload?.error) {
                message = payload.error;
              }
              if (payload?.details) {
                message = `${message} ${payload.details}`;
              }
            } catch {
              // Keep fallback message when response is not JSON.
            }
            throw new Error(message);
          }
        } catch (error) {
          console.error("URN local source lookup failed:", error);
          if (!isCancelled) {
            setErrorMessage("Failed to resolve local viewer source from URN.");
            setIsLoading(false);
            setUrnResolutionCompleted(true);
          }
          return;
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          if (isCancelled) {
            return;
          }
        }
      }

      if (!isCancelled) {
        setErrorMessage(LOCAL_ONLY_UNAVAILABLE_MESSAGE);
        setIsLoading(false);
        setUrnResolutionCompleted(true);
      }
    };

    resolveUrnToLocalBubble();

    return () => {
      isCancelled = true;
    };
  }, [
    urn,
    requestedToken,
    requestedLocalModelUrl,
    resolvedLocalModelUrl,
    requestedLookupAttempts,
    requestedLookupIntervalMs,
  ]);

  useEffect(() => {
    if (urn && !modelUrlToLoad && !urnResolutionCompleted) {
      return;
    }

    if (!isLocalMode) {
      setIsLoading(false);
      setErrorMessage(
        urn
          ? LOCAL_ONLY_UNAVAILABLE_MESSAGE
          : "Missing viewer params. Provide localModelUrl/bubbleUrl or urn for local lookup."
      );
      return;
    }

    const initializeViewer = async () => {
      const viewerDiv = document.getElementById("viewer");
      if (!viewerDiv) {
        console.error("Viewer div not found");
        setErrorMessage("Viewer container is missing.");
        setIsLoading(false);
        return;
      }

      const autodesk = await waitForAutodeskViewing();
      if (!autodesk?.Viewing) {
        setErrorMessage("Autodesk viewer runtime is unavailable.");
        setIsLoading(false);
        return;
      }

      const options = {
        env: "Local",
      };

      autodesk.Viewing.Initializer(options, () => {
        const viewer = new autodesk.Viewing.GuiViewer3D(viewerDiv, {});

        viewer.addEventListener(autodesk.Viewing.GEOMETRY_LOADED_EVENT, function () {
          document.body.setAttribute("data-viewer-loaded", "true");
          viewer.fitToView();
          setIsLoading(false);
        });

        const attachExplode = () => {
          const explodeButton = document.getElementById("explode");
          let explodeState = false;
          explodeButton?.addEventListener("click", () => {
            explodeState = !explodeState;
            viewer.explode(explodeState ? 1 : 0);
          });
        };

        viewer.start();

        if (!modelUrlToLoad) {
          setErrorMessage(LOCAL_ONLY_UNAVAILABLE_MESSAGE);
          setIsLoading(false);
          return;
        }

        viewer.loadModel(
          modelUrlToLoad,
          {},
          () => {
            document.body.setAttribute("data-viewer-loaded", "true");
            attachExplode();
            setIsLoading(false);
          },
          (err: unknown) => {
            console.error("Error loading local model:", err);
            setErrorMessage("Failed to load local SVF model.");
            setIsLoading(false);
          }
        );
      });
    };

    initializeViewer();
  }, [
    urn,
    modelUrlToLoad,
    isLocalMode,
    urnResolutionCompleted,
  ]);

  return (
    <>
      <div
        id="viewer"
        style={{
          width: "100%",
          height: "100vh",
          background: "#f1f1f1",
          position: "absolute",
        }}
      >
        {isLoading && (
          <div style={{
            position: "absolute",
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: "100%",
            height: "100vh",
            zIndex: 100,
            pointerEvents: 'none'
          }}>
            <div
              style={{
                width: "50px",
                height: "50px",
                border: "4px solid #f3f3f3",
                borderTop: "4px solid #036d35",
                borderRadius: "50%",
                animation: "spin 1s linear infinite",
              }}
            ></div>
            <style>
              {`
                @keyframes spin {
                  0% { transform: rotate(0deg); }
                  100% { transform: rotate(360deg); }
                }
              `}
            </style>
          </div>
        )}
        {!isLoading && errorMessage && (
          <div
            style={{
              position: "absolute",
              bottom: 20,
              left: 20,
              zIndex: 120,
              background: "#fff3f3",
              border: "1px solid #ffd0d0",
              color: "#8a1f1f",
              padding: "8px 10px",
              borderRadius: 8,
              fontSize: 14,
              fontFamily: "sans-serif",
            }}
          >
            {errorMessage}
          </div>
        )}
      </div>
    </>
  );
}

export default Viewer;
