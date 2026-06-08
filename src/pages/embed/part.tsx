import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  DEFAULT_ACCEPTED_FILE_TYPES,
  DEFAULT_MAX_FILE_SIZE_BYTES,
  EMBED_BUBBLE_SOURCE,
  EMBED_EVENT_VERSION,
  EMBED_VERCEL_SOURCE,
  isEmbedMode,
  normalizeOptionalString,
  type EmbedMode,
} from "../../helpers/embed-contracts";

interface EmbedSessionResponse {
  embedSessionId: string;
  guestToken: string;
  mode: EmbedMode;
  bubbleOrderId: string | null;
  status: "session_created" | "session_resumed";
  expiresAt: string;
  acceptedFileTypes: string[];
  maxFileSizeBytes: number;
}

interface EmbedUploadResponse {
  vercelPartId: string;
  sourceFileId: string;
  fileName: string;
  fileSizeBytes: number;
  status: "uploaded";
}

interface EmbedPartStatePayload {
  vercelPartId: string;
  status: "uploaded" | "processing" | "ready" | "failed";
  processingStage: string;
  processingStatus: "queued" | "inprogress" | "success" | "failed";
  viewer?: {
    status: "queued" | "inprogress" | "success" | "failed";
    mode?: "local" | "cloud";
    localModelUrl?: string | null;
    localError?: string | null;
    urn?: string | null;
  } | null;
  quote?: {
    upload?: {
      objectModelId: number | null;
      orderId: number | null;
      sessionId: string | null;
    } | null;
  } | null;
  defaultsSnapshot?: {
    snapshotId: string;
    status: "ready" | "pending" | "failed";
    defaults: {
      machine: { id: number | null; title: string | null };
      material: { id: number | null; title: string | null };
      tolerance: string | null;
      postproduction: string[];
      quantity: number;
      leadTime: string | null;
      technologySlug: string | null;
    };
    pricing: {
      currency: string;
      unitPrice: number | null;
      setupPrice: number | null;
      totalPrice: number | null;
      leadTimeDays: number | null;
    };
    warnings: string[];
  } | null;
  digifabster?: {
    objectModelId: number | null;
    orderId: number | null;
    sessionId: string | null;
  };
  failure?: {
    code: string | null;
    message: string | null;
  };
}

interface EmbedPartStateApiResponse {
  success: boolean;
  state: EmbedPartStatePayload;
}

interface EmbedViewerApiResponse {
  vercelPartId: string;
  viewerStatus: "ready" | "processing" | "failed";
  viewerUrl?: string;
  thumbnailUrl?: string | null;
  retryAfterMs?: number;
  stage?: string;
  error?: string;
}

interface EmbedDefaultsApiResponse {
  vercelPartId: string;
  status: "ready" | "pending" | "failed";
  defaultConfigSnapshotId?: string;
  digifabsterObjectModelId?: number | null;
  digifabsterOrderId?: number | null;
  defaults?: {
    machine: { id: number | null; title: string | null };
    material: { id: number | null; title: string | null };
    tolerance: string | null;
    postproduction: string[];
    quantity: number;
    leadTime: string | null;
    technologySlug: string | null;
  };
  pricing?: {
    currency: string;
    unitPrice: number | null;
    setupPrice: number | null;
    totalPrice: number | null;
    leadTimeDays: number | null;
  };
  warnings?: string[];
}

interface EmbedRepriceApiResponse {
  vercelPartId: string;
  status: "ready";
  pricing: {
    currency: string;
    unitPrice: number | null;
    setupPrice: number | null;
    totalPrice: number | null;
    leadTimeDays: number | null;
  };
  selectedConfig: {
    machine: { id: number | null; title: string | null };
    material: { id: number | null; title: string | null };
    tolerance: string | null;
    postproduction: string[];
    quantity: number;
    leadTime: string | null;
    technologySlug: string | null;
  };
  warnings: string[];
}

interface EmbedQueryState {
  mode: EmbedMode | null;
  parentOrigin: string | null;
  bubbleOrderId: string | null;
  guestToken: string | null;
  requestId: string | null;
  locale: string | null;
  theme: string | null;
  errors: string[];
}

type BubbleHostMessageType =
  | "bubble.embed.init"
  | "bubble.embed.requestState"
  | "bubble.embed.linkOrder"
  | "bubble.embed.reprice"
  | "bubble.embed.reset";

type VercelEmbedMessageType =
  | "vercel.embed.ready"
  | "vercel.embed.session.created"
  | "vercel.embed.upload.started"
  | "vercel.embed.processing.stage"
  | "vercel.embed.part.created"
  | "vercel.embed.viewer.ready"
  | "vercel.embed.defaults.ready"
  | "vercel.embed.reprice.completed"
  | "vercel.embed.part.ready"
  | "vercel.embed.error";

interface BubbleHostEnvelope {
  source?: string;
  type?: BubbleHostMessageType;
  version?: string;
  requestId?: string;
  payload?: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeOrigin = (value: string | null) => {
  const candidate = normalizeOptionalString(value);
  if (!candidate) {
    return null;
  }

  try {
    const normalized = new URL(candidate).origin;
    return normalized === "null" ? null : normalized;
  } catch {
    return null;
  }
};

const parseEmbedQuery = (): EmbedQueryState => {
  const params = new URLSearchParams(window.location.search);
  const modeRaw = normalizeOptionalString(params.get("mode"));
  const parentOrigin = normalizeOrigin(params.get("parentOrigin"));
  const bubbleOrderId = normalizeOptionalString(params.get("bubbleOrderId"));
  const guestToken = normalizeOptionalString(params.get("guestToken"));
  const requestId = normalizeOptionalString(params.get("requestId"));
  const locale = normalizeOptionalString(params.get("locale"));
  const theme = normalizeOptionalString(params.get("theme"));
  const errors: string[] = [];

  const mode = isEmbedMode(modeRaw) ? modeRaw : null;
  if (!mode) {
    errors.push("mode must be 'new' or 'existing'.");
  }

  if (!parentOrigin) {
    errors.push("parentOrigin must be a valid URL origin.");
  }

  if (mode === "existing" && !bubbleOrderId) {
    errors.push("mode=existing requires bubbleOrderId.");
  }

  if (mode === "new" && bubbleOrderId) {
    errors.push("mode=new cannot include bubbleOrderId.");
  }

  return {
    mode,
    parentOrigin,
    bubbleOrderId,
    guestToken,
    requestId,
    locale,
    theme,
    errors,
  };
};

const resolveApiError = async (response: Response) => {
  try {
    const payload = (await response.json()) as { error?: string; details?: string };
    if (payload.error && payload.details) {
      return `${payload.error} ${payload.details}`;
    }

    if (payload.error) {
      return payload.error;
    }
  } catch {
    // Response body is not JSON.
  }

  return `Request failed with status ${response.status}.`;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(1)} ${units[index]}`;
};

const parseRepricePayload = (payload: unknown) => {
  if (!isObject(payload)) {
    return null;
  }

  const parsed: Record<string, unknown> = {};

  if (typeof payload.machineId === "number") {
    parsed.machineId = payload.machineId;
  }

  if (typeof payload.materialId === "number") {
    parsed.materialId = payload.materialId;
  }

  if (typeof payload.quantity === "number" && payload.quantity > 0) {
    parsed.quantity = payload.quantity;
  }

  if (typeof payload.toleranceId === "string" && payload.toleranceId.trim()) {
    parsed.toleranceId = payload.toleranceId.trim();
  }

  if (Array.isArray(payload.postproductionIds)) {
    parsed.postproductionIds = payload.postproductionIds.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0
    );
  }

  return parsed;
};

function EmbedPartWorkbench() {
  const query = useMemo(() => parseEmbedQuery(), []);
  const [session, setSession] = useState<EmbedSessionResponse | null>(null);
  const [statusMessage, setStatusMessage] = useState("Waiting for host handshake...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [lastUpload, setLastUpload] = useState<EmbedUploadResponse | null>(null);
  const [partState, setPartState] = useState<EmbedPartStatePayload | null>(null);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [defaultsState, setDefaultsState] = useState<EmbedDefaultsApiResponse | null>(null);

  const stageFingerprintRef = useRef<string | null>(null);
  const viewerReadySentRef = useRef(false);
  const defaultsReadySentRef = useRef(false);
  const partReadySentRef = useRef(false);

  const acceptedFileTypes = session?.acceptedFileTypes ?? [...DEFAULT_ACCEPTED_FILE_TYPES];
  const maxFileSizeBytes = session?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const acceptedFileTypesLabel = acceptedFileTypes.join(", ");
  const acceptedFileTypesValue = acceptedFileTypes.join(",");
  const maxFileSizeLabel = formatBytes(maxFileSizeBytes);

  const postEmbedEvent = useCallback(
    (
      type: VercelEmbedMessageType,
      payload: Record<string, unknown>,
      sessionContext: EmbedSessionResponse | null,
      options?: { vercelPartId?: string | null }
    ) => {
      if (!query.parentOrigin) {
        return;
      }

      const message = {
        source: EMBED_VERCEL_SOURCE,
        type,
        version: EMBED_EVENT_VERSION,
        requestId: query.requestId ?? undefined,
        timestamp: new Date().toISOString(),
        embedSessionId: sessionContext?.embedSessionId ?? null,
        mode: sessionContext?.mode ?? query.mode,
        bubbleOrderId: sessionContext?.bubbleOrderId ?? query.bubbleOrderId ?? null,
        vercelPartId: options?.vercelPartId ?? null,
        payload,
      };

      window.parent.postMessage(message, query.parentOrigin);
    },
    [query.bubbleOrderId, query.mode, query.parentOrigin, query.requestId]
  );

  const emitPartCreated = useCallback(
    (sessionContext: EmbedSessionResponse, upload: EmbedUploadResponse) => {
      postEmbedEvent(
        "vercel.embed.part.created",
        {
          vercelPartId: upload.vercelPartId,
          sourceFileId: upload.sourceFileId,
          sourceFileName: upload.fileName,
          sourceFileSizeBytes: upload.fileSizeBytes,
          status: upload.status,
        },
        sessionContext,
        { vercelPartId: upload.vercelPartId }
      );
    },
    [postEmbedEvent]
  );

  const resetPartDerivedState = useCallback(() => {
    stageFingerprintRef.current = null;
    viewerReadySentRef.current = false;
    defaultsReadySentRef.current = false;
    partReadySentRef.current = false;
    setPartState(null);
    setViewerUrl(null);
    setDefaultsState(null);
  }, []);

  useEffect(() => {
    if (query.errors.length > 0) {
      const message = `Invalid embed URL: ${query.errors.join(" ")}`;
      setErrorMessage(message);
      setStatusMessage("Embed initialization failed.");

      if (query.parentOrigin) {
        postEmbedEvent(
          "vercel.embed.error",
          {
            code: "invalid_embed_url",
            message,
            stage: "failed",
            retryable: false,
          },
          null
        );
      }

      return;
    }

    setStatusMessage("Host connected. Creating embed session...");

    postEmbedEvent(
      "vercel.embed.ready",
      {
        capabilities: [
          "session-bootstrap",
          "postmessage-contract-v1",
          "direct-file-upload",
          "pipeline-polling",
          "viewer-defaults-events",
          "reprice-command",
        ],
        acceptedFileTypes: [...DEFAULT_ACCEPTED_FILE_TYPES],
        maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
        requiresInit: true,
        supportsGuestSessions: true,
      },
      null
    );

    let cancelled = false;

    const createSession = async () => {
      const response = await fetch("/api/embed/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: query.mode,
          parentOrigin: query.parentOrigin,
          bubbleOrderId: query.bubbleOrderId,
          guestToken: query.guestToken,
          requestId: query.requestId,
          locale: query.locale,
          theme: query.theme,
        }),
      });

      if (!response.ok) {
        throw new Error(await resolveApiError(response));
      }

      const payload = (await response.json()) as EmbedSessionResponse;
      if (cancelled) {
        return;
      }

      setSession(payload);
      setErrorMessage(null);
      setStatusMessage(payload.status === "session_resumed" ? "Session resumed." : "Session created.");

      postEmbedEvent(
        "vercel.embed.session.created",
        {
          embedSessionId: payload.embedSessionId,
          guestToken: payload.guestToken,
          status: payload.status,
          expiresAt: payload.expiresAt,
          acceptedFileTypes: payload.acceptedFileTypes,
          maxFileSizeBytes: payload.maxFileSizeBytes,
        },
        payload
      );
    };

    createSession().catch((createSessionError) => {
      if (cancelled) {
        return;
      }

      const message =
        createSessionError instanceof Error
          ? createSessionError.message
          : "Failed to create embed session.";

      setErrorMessage(message);
      setStatusMessage("Embed session creation failed.");
      postEmbedEvent(
        "vercel.embed.error",
        {
          code: "embed_session_create_failed",
          message,
          stage: "failed",
          retryable: true,
        },
        null
      );
    });

    return () => {
      cancelled = true;
    };
  }, [postEmbedEvent, query]);

  useEffect(() => {
    if (!session || !lastUpload) {
      return;
    }

    let cancelled = false;
    let timerId: number | null = null;

    const partId = lastUpload.vercelPartId;

    const scheduleNext = (delayMs = 5000) => {
      if (cancelled) {
        return;
      }

      timerId = window.setTimeout(() => {
        void pollCycle();
      }, delayMs);
    };

    const pollCycle = async () => {
      try {
        const stateResponse = await fetch(`/api/embed/parts/${encodeURIComponent(partId)}?refresh=1`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.guestToken}`,
          },
        });

        if (!stateResponse.ok) {
          throw new Error(await resolveApiError(stateResponse));
        }

        const statePayload = (await stateResponse.json()) as EmbedPartStateApiResponse;
        if (cancelled) {
          return;
        }

        const state = statePayload.state;
        setPartState(state);

        const stageFingerprint = `${state.processingStage}:${state.processingStatus}`;
        if (stageFingerprintRef.current !== stageFingerprint) {
          stageFingerprintRef.current = stageFingerprint;

          postEmbedEvent(
            "vercel.embed.processing.stage",
            {
              vercelPartId: partId,
              stage: state.processingStage,
              status: state.processingStatus,
              partStatus: state.status,
              message:
                state.status === "failed"
                  ? state.failure?.message || "Part processing failed."
                  : "Part processing state updated.",
            },
            session,
            { vercelPartId: partId }
          );
        }

        const viewerResponse = await fetch(`/api/embed/parts/${encodeURIComponent(partId)}/viewer`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.guestToken}`,
          },
        });
        const viewerPayload = (await viewerResponse.json()) as EmbedViewerApiResponse;

        if (!cancelled && viewerResponse.ok && viewerPayload.viewerStatus === "ready" && viewerPayload.viewerUrl) {
          setViewerUrl(viewerPayload.viewerUrl);
          if (!viewerReadySentRef.current) {
            viewerReadySentRef.current = true;
            postEmbedEvent(
              "vercel.embed.viewer.ready",
              {
                vercelPartId: partId,
                viewerUrl: viewerPayload.viewerUrl,
                thumbnailUrl: viewerPayload.thumbnailUrl ?? null,
              },
              session,
              { vercelPartId: partId }
            );
          }
        }

        const defaultsResponse = await fetch(`/api/embed/parts/${encodeURIComponent(partId)}/defaults`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${session.guestToken}`,
          },
        });
        const defaultsPayload = (await defaultsResponse.json()) as EmbedDefaultsApiResponse;

        if (!cancelled && (defaultsResponse.ok || defaultsResponse.status === 202)) {
          setDefaultsState(defaultsPayload);

          if (defaultsPayload.status === "ready" && defaultsPayload.defaults && defaultsPayload.pricing) {
            if (!defaultsReadySentRef.current) {
              defaultsReadySentRef.current = true;
              postEmbedEvent(
                "vercel.embed.defaults.ready",
                {
                  vercelPartId: partId,
                  defaultConfigSnapshotId: defaultsPayload.defaultConfigSnapshotId ?? null,
                  digifabsterObjectModelId: defaultsPayload.digifabsterObjectModelId ?? null,
                  digifabsterOrderId: defaultsPayload.digifabsterOrderId ?? null,
                  defaults: defaultsPayload.defaults,
                  pricing: defaultsPayload.pricing,
                  warnings: defaultsPayload.warnings ?? [],
                },
                session,
                { vercelPartId: partId }
              );
            }
          }
        }

        const viewerReady = Boolean(viewerPayload.viewerStatus === "ready" && viewerPayload.viewerUrl);
        const hasDigifabsterObjectModel = Boolean(state.digifabster?.objectModelId);
        const defaultsReady = defaultsPayload.status === "ready";
        const canComplete = viewerReady && (!hasDigifabsterObjectModel || defaultsReady);

        if (state.status === "failed") {
          setStatusMessage("Processing failed.");
          if (!partReadySentRef.current) {
            partReadySentRef.current = true;
            postEmbedEvent(
              "vercel.embed.error",
              {
                code: state.failure?.code || "part_processing_failed",
                message: state.failure?.message || "Part processing failed.",
                stage: state.processingStage,
                retryable: true,
              },
              session,
              { vercelPartId: partId }
            );
          }
          return;
        }

        if (canComplete || state.status === "ready") {
          setStatusMessage("Part ready for Bubble handoff.");
          if (!partReadySentRef.current) {
            partReadySentRef.current = true;
            postEmbedEvent(
              "vercel.embed.part.ready",
              {
                vercelPartId: partId,
                status: "ready",
                processingStage: state.processingStage,
                viewerUrl: viewerPayload.viewerUrl ?? state.viewer?.localModelUrl ?? null,
                defaults: defaultsPayload.defaults ?? state.defaultsSnapshot?.defaults ?? null,
                pricing: defaultsPayload.pricing ?? state.defaultsSnapshot?.pricing ?? null,
                warnings: defaultsPayload.warnings ?? state.defaultsSnapshot?.warnings ?? [],
              },
              session,
              { vercelPartId: partId }
            );
          }
          return;
        }

        setStatusMessage(`Processing ${lastUpload.fileName}: ${state.processingStage}...`);
        scheduleNext(viewerPayload.retryAfterMs && viewerPayload.retryAfterMs > 0 ? viewerPayload.retryAfterMs : 5000);
      } catch (pollError) {
        if (cancelled) {
          return;
        }

        const message = pollError instanceof Error ? pollError.message : "Failed to poll part processing state.";
        setErrorMessage(message);
        setStatusMessage("Processing status check failed.");

        postEmbedEvent(
          "vercel.embed.error",
          {
            code: "embed_processing_poll_failed",
            message,
            stage: partState?.processingStage ?? "autodesk_processing",
            retryable: true,
          },
          session,
          { vercelPartId: partId }
        );

        scheduleNext(7000);
      }
    };

    void pollCycle();

    return () => {
      cancelled = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [lastUpload, partState?.processingStage, postEmbedEvent, session]);

  useEffect(() => {
    if (!query.parentOrigin || query.errors.length > 0) {
      return;
    }

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.origin !== query.parentOrigin) {
        return;
      }

      if (!isObject(event.data)) {
        return;
      }

      const hostEnvelope = event.data as BubbleHostEnvelope;
      if (hostEnvelope.source !== EMBED_BUBBLE_SOURCE || hostEnvelope.version !== EMBED_EVENT_VERSION) {
        return;
      }

      if (hostEnvelope.type === "bubble.embed.init") {
        setStatusMessage((currentStatus) => {
          return currentStatus.startsWith("Session") ? currentStatus : "Host initialized.";
        });
        return;
      }

      if (hostEnvelope.type === "bubble.embed.requestState" && session) {
        postEmbedEvent(
          "vercel.embed.session.created",
          {
            embedSessionId: session.embedSessionId,
            guestToken: session.guestToken,
            status: "session_resumed",
            expiresAt: session.expiresAt,
            acceptedFileTypes: session.acceptedFileTypes,
            maxFileSizeBytes: session.maxFileSizeBytes,
          },
          session
        );

        if (lastUpload) {
          emitPartCreated(session, lastUpload);
        }

        if (partState) {
          postEmbedEvent(
            "vercel.embed.processing.stage",
            {
              vercelPartId: partState.vercelPartId,
              stage: partState.processingStage,
              status: partState.processingStatus,
              partStatus: partState.status,
            },
            session,
            { vercelPartId: partState.vercelPartId }
          );
        }

        if (viewerUrl && lastUpload) {
          postEmbedEvent(
            "vercel.embed.viewer.ready",
            {
              vercelPartId: lastUpload.vercelPartId,
              viewerUrl,
              thumbnailUrl: null,
            },
            session,
            { vercelPartId: lastUpload.vercelPartId }
          );
        }

        if (defaultsState?.status === "ready" && defaultsState.defaults && defaultsState.pricing && lastUpload) {
          postEmbedEvent(
            "vercel.embed.defaults.ready",
            {
              vercelPartId: lastUpload.vercelPartId,
              defaultConfigSnapshotId: defaultsState.defaultConfigSnapshotId ?? null,
              digifabsterObjectModelId: defaultsState.digifabsterObjectModelId ?? null,
              digifabsterOrderId: defaultsState.digifabsterOrderId ?? null,
              defaults: defaultsState.defaults,
              pricing: defaultsState.pricing,
              warnings: defaultsState.warnings ?? [],
            },
            session,
            { vercelPartId: lastUpload.vercelPartId }
          );
        }
      }

      if (hostEnvelope.type === "bubble.embed.reprice") {
        if (!session || !lastUpload) {
          postEmbedEvent(
            "vercel.embed.error",
            {
              code: "reprice_without_part",
              message: "Cannot reprice before a part is uploaded and linked.",
              stage: "reprice_processing",
              retryable: false,
            },
            session,
            { vercelPartId: lastUpload?.vercelPartId ?? null }
          );
          return;
        }

        const parsedPayload = parseRepricePayload(hostEnvelope.payload);
        if (!parsedPayload) {
          postEmbedEvent(
            "vercel.embed.error",
            {
              code: "invalid_reprice_payload",
              message: "bubble.embed.reprice payload must be an object.",
              stage: "reprice_processing",
              retryable: false,
            },
            session,
            { vercelPartId: lastUpload.vercelPartId }
          );
          return;
        }

        postEmbedEvent(
          "vercel.embed.processing.stage",
          {
            vercelPartId: lastUpload.vercelPartId,
            stage: "reprice_processing",
            status: "inprogress",
            message: "Submitting repricing request.",
          },
          session,
          { vercelPartId: lastUpload.vercelPartId }
        );

        fetch(`/api/embed/parts/${encodeURIComponent(lastUpload.vercelPartId)}/reprice`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.guestToken}`,
          },
          body: JSON.stringify(parsedPayload),
        })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(await resolveApiError(response));
            }

            const payload = (await response.json()) as EmbedRepriceApiResponse;

            setDefaultsState((prev) => {
              return {
                vercelPartId: payload.vercelPartId,
                status: "ready",
                defaultConfigSnapshotId: prev?.defaultConfigSnapshotId,
                digifabsterObjectModelId: prev?.digifabsterObjectModelId,
                digifabsterOrderId: prev?.digifabsterOrderId,
                defaults: payload.selectedConfig,
                pricing: payload.pricing,
                warnings: payload.warnings,
              };
            });

            postEmbedEvent(
              "vercel.embed.processing.stage",
              {
                vercelPartId: payload.vercelPartId,
                stage: "reprice_processing",
                status: "success",
                message: "Repricing finished.",
              },
              session,
              { vercelPartId: payload.vercelPartId }
            );

            postEmbedEvent(
              "vercel.embed.reprice.completed",
              {
                vercelPartId: payload.vercelPartId,
                pricing: payload.pricing,
                selectedConfig: payload.selectedConfig,
                warnings: payload.warnings,
              },
              session,
              { vercelPartId: payload.vercelPartId }
            );
          })
          .catch((repriceError) => {
            const message = repriceError instanceof Error ? repriceError.message : "Failed to reprice part.";
            setErrorMessage(message);

            postEmbedEvent(
              "vercel.embed.error",
              {
                code: "embed_reprice_failed",
                message,
                stage: "reprice_processing",
                retryable: true,
              },
              session,
              { vercelPartId: lastUpload.vercelPartId }
            );
          });
      }

      if (hostEnvelope.type === "bubble.embed.reset") {
        setSelectedFile(null);
        setLastUpload(null);
        setErrorMessage(null);
        setStatusMessage("Host requested a fresh upload state.");
        resetPartDerivedState();
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
    };
  }, [
    defaultsState,
    emitPartCreated,
    lastUpload,
    partState,
    postEmbedEvent,
    query.errors.length,
    query.parentOrigin,
    resetPartDerivedState,
    session,
    viewerUrl,
  ]);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setSelectedFile(nextFile);
  };

  const onUpload = async () => {
    if (!session) {
      setErrorMessage("Create session before uploading a file.");
      return;
    }

    if (!selectedFile) {
      setErrorMessage("Choose a file before uploading.");
      return;
    }

    if (selectedFile.size > maxFileSizeBytes) {
      setErrorMessage(`Selected file exceeds max size ${maxFileSizeLabel}.`);
      return;
    }

    setIsUploading(true);
    setErrorMessage(null);
    setStatusMessage(`Uploading ${selectedFile.name}...`);

    postEmbedEvent(
      "vercel.embed.upload.started",
      {
        embedSessionId: session.embedSessionId,
        fileName: selectedFile.name,
        fileSizeBytes: selectedFile.size,
        status: "uploading",
      },
      session
    );

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch(`/api/embed/sessions/${encodeURIComponent(session.embedSessionId)}/files`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.guestToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error(await resolveApiError(response));
      }

      const payload = (await response.json()) as EmbedUploadResponse;
      setLastUpload(payload);
      resetPartDerivedState();
      setStatusMessage(`Uploaded ${payload.fileName} (${formatBytes(payload.fileSizeBytes)}).`);

      postEmbedEvent(
        "vercel.embed.processing.stage",
        {
          vercelPartId: payload.vercelPartId,
          stage: "upload_received",
          status: "success",
          message: "Source file accepted by Vercel.",
        },
        session,
        { vercelPartId: payload.vercelPartId }
      );

      emitPartCreated(session, payload);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "Failed to upload source file.";
      setErrorMessage(message);
      setStatusMessage("Upload failed.");

      postEmbedEvent(
        "vercel.embed.error",
        {
          code: "embed_upload_failed",
          message,
          stage: "upload_received",
          retryable: true,
        },
        session
      );
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <main
      style={{
        minHeight: "100vh",
        background: "linear-gradient(160deg, #f8fbf8 0%, #edf6ef 100%)",
        color: "#1f3a27",
        fontFamily: "Akshar, sans-serif",
        padding: "24px",
      }}
    >
      <section
        style={{
          maxWidth: "920px",
          margin: "0 auto",
          background: "#ffffff",
          border: "1px solid #d7e8da",
          borderRadius: "14px",
          padding: "24px",
          boxShadow: "0 10px 30px rgba(12, 44, 22, 0.08)",
        }}
      >
        <h1 style={{ marginTop: 0, marginBottom: "12px", fontSize: "32px" }}>Embedded Part Workbench</h1>
        <p style={{ marginTop: 0, marginBottom: "18px", color: "#2f5c3b" }}>{statusMessage}</p>

        {errorMessage && (
          <p
            style={{
              background: "#fff3f3",
              border: "1px solid #ffd0d0",
              color: "#8a1f1f",
              borderRadius: "10px",
              padding: "12px",
              marginTop: 0,
            }}
          >
            {errorMessage}
          </p>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", rowGap: "8px", columnGap: "10px" }}>
          <strong>Mode</strong>
          <span>{query.mode ?? "invalid"}</span>

          <strong>Parent Origin</strong>
          <span>{query.parentOrigin ?? "invalid"}</span>

          <strong>Bubble Order</strong>
          <span>{query.bubbleOrderId ?? "(none)"}</span>

          <strong>Embed Session</strong>
          <span>{session?.embedSessionId ?? "(not created yet)"}</span>

          <strong>Session Expires</strong>
          <span>{session?.expiresAt ?? "(pending)"}</span>

          <strong>Allowed Types</strong>
          <span>{acceptedFileTypesLabel}</span>

          <strong>Max File Size</strong>
          <span>{maxFileSizeLabel}</span>

          <strong>Last Upload</strong>
          <span>{lastUpload ? `${lastUpload.fileName} (${lastUpload.vercelPartId})` : "(none yet)"}</span>

          <strong>Processing Stage</strong>
          <span>{partState?.processingStage ?? "(waiting)"}</span>

          <strong>Viewer URL</strong>
          <span>{viewerUrl ?? "(not ready yet)"}</span>

          <strong>Defaults Snapshot</strong>
          <span>{defaultsState ? defaultsState.status : "(not ready yet)"}</span>
        </div>

        <div
          style={{
            marginTop: "20px",
            paddingTop: "16px",
            borderTop: "1px solid #e1ece4",
            display: "flex",
            gap: "10px",
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <input
            type="file"
            accept={acceptedFileTypesValue}
            disabled={!session || isUploading}
            onChange={onFileChange}
          />
          <button
            type="button"
            disabled={!session || !selectedFile || isUploading}
            onClick={onUpload}
            style={{
              border: "none",
              borderRadius: "8px",
              background: isUploading ? "#9ab8a4" : "#2f8f56",
              color: "#fff",
              fontSize: "16px",
              padding: "10px 16px",
              cursor: !session || !selectedFile || isUploading ? "not-allowed" : "pointer",
            }}
          >
            {isUploading ? "Uploading..." : "Upload Source File"}
          </button>
          {selectedFile && (
            <span style={{ color: "#2f5c3b", fontSize: "14px" }}>
              {selectedFile.name} ({formatBytes(selectedFile.size)})
            </span>
          )}
        </div>
      </section>
    </main>
  );
}

export default EmbedPartWorkbench;
