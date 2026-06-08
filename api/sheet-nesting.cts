import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  buildDigifabsterHeaders,
  fetchDigifabsterJson,
  resolveDefaultTechnologySlug,
  syncNativeSourceToDigifabster,
} from "./autodesk_helpers/digifabster-sync";

const Drawing = require("dxf-writer");
const DxfParser = require("dxf-parser");

export const config = {
  maxDuration: 60,
};

type Point2 = { x: number; y: number };

type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

type SupportedEntity =
  | { type: "LINE"; points: [Point2, Point2] }
  | { type: "LWPOLYLINE" | "POLYLINE"; points: Point2[]; closed: boolean }
  | { type: "ARC"; center: Point2; radius: number; startAngle: number; endAngle: number }
  | { type: "CIRCLE"; center: Point2; radius: number };

type Placement = {
  partIndex: number;
  sheetIndex: number;
  sheetOriginX: number;
  x: number;
  y: number;
  rotationDeg: 0 | 90;
};

const DEFAULT_SHEET_WIDTH = 2000;
const DEFAULT_SHEET_HEIGHT = 1000;
const DEFAULT_PART_SPACING = 5;
const DEFAULT_SHEET_GAP = 40;
const MAX_PARTS_PER_REQUEST = 2000;

const createTraceId = () => `nesting-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const buildCorsHeaders = (req?: Request): Record<string, string> => {
  const origin = req?.headers.get("origin")?.trim();
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-vercel-protection-bypass",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
};

const json = (payload: unknown, status = 200, req?: Request) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...buildCorsHeaders(req),
    },
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const pickString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
};

const pickBoolean = (...values: unknown[]): boolean | null => {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
    }

    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
  }

  return null;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const pickPositiveNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }

  return null;
};

const pickPositiveInt = (...values: unknown[]): number | null => {
  const value = pickPositiveNumber(...values);
  if (value === null) {
    return null;
  }

  const integer = Math.floor(value);
  if (integer <= 0) {
    return null;
  }

  return integer;
};

const toPoint2 = (value: unknown): Point2 | null => {
  if (!isObject(value)) {
    return null;
  }

  const x = toNumber(value.x);
  const y = toNumber(value.y);
  if (x === null || y === null) {
    return null;
  }

  return { x, y };
};

const createEmptyBounds = (): Bounds => ({
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
  width: 0,
  height: 0,
});

const expandBounds = (bounds: Bounds, point: Point2) => {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
};

const finalizeBounds = (bounds: Bounds): Bounds | null => {
  if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX)) {
    return null;
  }

  return {
    ...bounds,
    width: Math.max(0, bounds.maxX - bounds.minX),
    height: Math.max(0, bounds.maxY - bounds.minY),
  };
};

const normalizeArcRange = (startAngle: number, endAngle: number) => {
  const tau = Math.PI * 2;
  let start = startAngle;
  let end = endAngle;

  while (end <= start) {
    end += tau;
  }

  return { start, end };
};

const sampleArcPoints = (
  center: Point2,
  radius: number,
  startAngle: number,
  endAngle: number,
  minSegments = 16,
): Point2[] => {
  const range = normalizeArcRange(startAngle, endAngle);
  const span = range.end - range.start;
  const segments = Math.max(minSegments, Math.ceil(span / (Math.PI / 12)));
  const points: Point2[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = range.start + (span * i) / segments;
    points.push({
      x: center.x + radius * Math.cos(t),
      y: center.y + radius * Math.sin(t),
    });
  }

  return points;
};

const parseSupportedEntities = (rawEntities: unknown[]): SupportedEntity[] => {
  const supported: SupportedEntity[] = [];

  for (const rawEntity of rawEntities) {
    if (!isObject(rawEntity) || typeof rawEntity.type !== "string") {
      continue;
    }

    const type = rawEntity.type.toUpperCase();

    if (type === "LINE") {
      const vertices = Array.isArray(rawEntity.vertices) ? rawEntity.vertices : [];
      const first = toPoint2(vertices[0]);
      const second = toPoint2(vertices[1]);
      if (first && second) {
        supported.push({ type: "LINE", points: [first, second] });
      }
      continue;
    }

    if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const vertices = Array.isArray(rawEntity.vertices) ? rawEntity.vertices : [];
      const points = vertices.map((item) => toPoint2(item)).filter((item): item is Point2 => Boolean(item));
      if (points.length >= 2) {
        supported.push({
          type: type as "LWPOLYLINE" | "POLYLINE",
          points,
          closed: rawEntity.shape === true || rawEntity.closed === true,
        });
      }
      continue;
    }

    if (type === "ARC") {
      const center = toPoint2(rawEntity.center);
      const radius = pickPositiveNumber(rawEntity.radius);
      const startAngle = toNumber(rawEntity.startAngle);
      const endAngle = toNumber(rawEntity.endAngle);

      if (center && radius !== null && startAngle !== null && endAngle !== null) {
        supported.push({
          type: "ARC",
          center,
          radius,
          startAngle,
          endAngle,
        });
      }
      continue;
    }

    if (type === "CIRCLE") {
      const center = toPoint2(rawEntity.center);
      const radius = pickPositiveNumber(rawEntity.radius);
      if (center && radius !== null) {
        supported.push({
          type: "CIRCLE",
          center,
          radius,
        });
      }
    }
  }

  return supported;
};

const computePartBounds = (entities: SupportedEntity[]): Bounds | null => {
  const bounds = createEmptyBounds();

  for (const entity of entities) {
    if (entity.type === "LINE") {
      expandBounds(bounds, entity.points[0]);
      expandBounds(bounds, entity.points[1]);
      continue;
    }

    if (entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") {
      for (const point of entity.points) {
        expandBounds(bounds, point);
      }
      continue;
    }

    if (entity.type === "ARC") {
      const arcPoints = sampleArcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle, 24);
      for (const point of arcPoints) {
        expandBounds(bounds, point);
      }
      continue;
    }

    if (entity.type === "CIRCLE") {
      expandBounds(bounds, { x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
      expandBounds(bounds, { x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
    }
  }

  return finalizeBounds(bounds);
};

const normalizeDxfFileName = (rawName: string) => {
  const clean = rawName
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .pop() || "nested.dxf";

  const withExtension = clean.toLowerCase().endsWith(".dxf") ? clean : `${clean}.dxf`;
  return withExtension.replace(/[^a-zA-Z0-9._-]/g, "_");
};

const fileNameFromUrl = (url: string | null) => {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).pop();
    if (!tail) {
      return null;
    }

    return decodeURIComponent(tail);
  } catch {
    return null;
  }
};

const simpleHash = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }

  return Math.abs(hash).toString(36);
};

const toBaseName = (fileName: string) => {
  const normalized = normalizeDxfFileName(fileName);
  const withoutExtension = normalized.replace(/\.dxf$/i, "");
  return withoutExtension || "nested";
};

const loadDxfText = async (params: {
  sourceUrl: string | null;
  dxfContent: string | null;
  dxfBase64: string | null;
}) => {
  if (typeof params.dxfContent === "string" && params.dxfContent.trim()) {
    return params.dxfContent;
  }

  if (typeof params.dxfBase64 === "string" && params.dxfBase64.trim()) {
    return Buffer.from(params.dxfBase64.trim(), "base64").toString("utf8");
  }

  if (!params.sourceUrl) {
    throw new Error("Provide source_url/sourceUrl, dxf_content/dxfContent, or dxf_base64/dxfBase64.");
  }

  const parsed = new URL(params.sourceUrl);
  if (parsed.protocol === "file:") {
    const filePath = fileURLToPath(parsed);
    return readFile(filePath, "utf8");
  }

  const response = await fetch(params.sourceUrl);
  if (!response.ok) {
    throw new Error(`Unable to download DXF source (${response.status}).`);
  }

  return response.text();
};

const pickSizeFromRecord = (record: Record<string, unknown>): { width: number | null; height: number | null } => {
  const candidates: Array<Record<string, unknown>> = [record];

  const nestedKeys = [
    "size",
    "sheet_size",
    "sheetSize",
    "default_sheet_size",
    "defaultSheetSize",
    "max_sheet_size",
    "maxSheetSize",
  ];

  for (const key of nestedKeys) {
    const nested = record[key];
    if (isObject(nested)) {
      candidates.push(nested);
    }
  }

  const nestedArrays = ["sheet_sizes", "sheetSizes", "sizes"];
  for (const key of nestedArrays) {
    const arrayValue = record[key];
    if (Array.isArray(arrayValue) && isObject(arrayValue[0])) {
      candidates.push(arrayValue[0]);
    }
  }

  const widthKeys = ["sheet_width", "sheetWidth", "size_x", "sizeX", "width", "x"];
  const heightKeys = ["sheet_height", "sheetHeight", "size_y", "sizeY", "height", "y"];

  for (const candidate of candidates) {
    const width = pickPositiveNumber(...widthKeys.map((key) => candidate[key]));
    const height = pickPositiveNumber(...heightKeys.map((key) => candidate[key]));
    if (width !== null && height !== null) {
      return { width, height };
    }
  }

  return { width: null, height: null };
};

const resolveSheetSizeFromContext = async (params: {
  technologySlug: string;
  machineId: number | null;
  materialId: number | null;
  warnings: string[];
}) => {
  const { technologySlug, machineId, materialId, warnings } = params;

  if (!machineId && !materialId) {
    return { width: null, height: null, source: null as string | null };
  }

  try {
    const headers = await buildDigifabsterHeaders();

    if (machineId) {
      const machineResult = await fetchDigifabsterJson(
        `/v2/machines/${encodeURIComponent(technologySlug)}/${machineId}/`,
        headers,
      );

      if (machineResult.ok && isObject(machineResult.data)) {
        const machineSize = pickSizeFromRecord(machineResult.data);
        if (machineSize.width !== null && machineSize.height !== null) {
          return { width: machineSize.width, height: machineSize.height, source: "digifabster_machine" };
        }
      }
    }

    if (materialId) {
      const materialResult = await fetchDigifabsterJson(
        `/v2/materials/${encodeURIComponent(technologySlug)}/${materialId}/`,
        headers,
      );

      if (materialResult.ok && isObject(materialResult.data)) {
        const materialSize = pickSizeFromRecord(materialResult.data);
        if (materialSize.width !== null && materialSize.height !== null) {
          return { width: materialSize.width, height: materialSize.height, source: "digifabster_material" };
        }
      }
    }
  } catch (error) {
    warnings.push(
      error instanceof Error
        ? `Unable to read DigiFabster defaults: ${error.message}`
        : "Unable to read DigiFabster defaults.",
    );
  }

  return { width: null, height: null, source: null as string | null };
};

const rotateLocalPoint = (point: Point2, rotationDeg: 0 | 90, originalPartHeight: number): Point2 => {
  if (rotationDeg === 90) {
    return {
      x: originalPartHeight - point.y,
      y: point.x,
    };
  }

  return point;
};

const buildLayout = (params: {
  partBounds: Bounds;
  quantity: number;
  sheetWidth: number;
  sheetHeight: number;
  spacing: number;
  allowRotation: boolean;
}) => {
  const { partBounds, quantity, sheetWidth, sheetHeight, spacing, allowRotation } = params;

  const buildCandidate = (rotationDeg: 0 | 90) => {
    const partWidth = rotationDeg === 90 ? partBounds.height : partBounds.width;
    const partHeight = rotationDeg === 90 ? partBounds.width : partBounds.height;

    const cols = Math.max(0, Math.floor((sheetWidth - spacing) / (partWidth + spacing)));
    const rows = Math.max(0, Math.floor((sheetHeight - spacing) / (partHeight + spacing)));

    return {
      rotationDeg,
      partWidth,
      partHeight,
      cols,
      rows,
      perSheetCapacity: cols * rows,
    };
  };

  const candidates = [buildCandidate(0 as const)];
  if (allowRotation) {
    candidates.push(buildCandidate(90 as const));
  }

  candidates.sort((a, b) => {
    if (b.perSheetCapacity !== a.perSheetCapacity) {
      return b.perSheetCapacity - a.perSheetCapacity;
    }

    if (b.cols !== a.cols) {
      return b.cols - a.cols;
    }

    return b.rows - a.rows;
  });

  const chosen = candidates[0];

  if (!chosen || chosen.perSheetCapacity <= 0) {
    return {
      chosen: null,
      placements: [] as Placement[],
      sheetCount: 0,
    };
  }

  const sheetCount = Math.ceil(quantity / chosen.perSheetCapacity);
  const sheetGap = Math.max(DEFAULT_SHEET_GAP, spacing * 4);
  const placements: Placement[] = [];

  for (let index = 0; index < quantity; index += 1) {
    const sheetIndex = Math.floor(index / chosen.perSheetCapacity);
    const inSheetIndex = index % chosen.perSheetCapacity;
    const row = Math.floor(inSheetIndex / chosen.cols);
    const col = inSheetIndex % chosen.cols;
    const sheetOriginX = sheetIndex * (sheetWidth + sheetGap);

    placements.push({
      partIndex: index,
      sheetIndex,
      sheetOriginX,
      x: spacing + col * (chosen.partWidth + spacing),
      y: spacing + row * (chosen.partHeight + spacing),
      rotationDeg: chosen.rotationDeg,
    });
  }

  return { chosen, placements, sheetCount };
};

const renderNestedDxf = (params: {
  entities: SupportedEntity[];
  partBounds: Bounds;
  placements: Placement[];
  sheetCount: number;
  sheetWidth: number;
  sheetHeight: number;
  traceId: string;
}) => {
  const { entities, partBounds, placements, sheetCount, sheetWidth, sheetHeight, traceId } = params;
  const drawing = new Drawing();

  drawing.setUnits("Millimeters");
  drawing.addLayer("SHEET", Drawing.ACI.YELLOW, "CONTINUOUS");
  drawing.addLayer("NESTED_PARTS", Drawing.ACI.WHITE, "CONTINUOUS");

  drawing.setActiveLayer("SHEET");
  for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
    const sheetOriginX = sheetIndex * (sheetWidth + Math.max(DEFAULT_SHEET_GAP, 25));
    drawing.drawRect(sheetOriginX, 0, sheetOriginX + sheetWidth, sheetHeight);
    drawing.drawText(sheetOriginX + 10, Math.max(10, sheetHeight - 15), 8, 0, `SHEET-${sheetIndex + 1}`);
  }

  const toPlacedPoint = (point: Point2, placement: Placement): Point2 => {
    const local = {
      x: point.x - partBounds.minX,
      y: point.y - partBounds.minY,
    };

    const rotated = rotateLocalPoint(local, placement.rotationDeg, partBounds.height);

    return {
      x: placement.sheetOriginX + placement.x + rotated.x,
      y: placement.y + rotated.y,
    };
  };

  drawing.setActiveLayer("NESTED_PARTS");

  for (const placement of placements) {
    for (const entity of entities) {
      if (entity.type === "LINE") {
        const p0 = toPlacedPoint(entity.points[0], placement);
        const p1 = toPlacedPoint(entity.points[1], placement);
        drawing.drawLine(p0.x, p0.y, p1.x, p1.y);
        continue;
      }

      if (entity.type === "LWPOLYLINE" || entity.type === "POLYLINE") {
        const points = entity.points
          .map((point) => toPlacedPoint(point, placement))
          .map((point) => [point.x, point.y] as [number, number]);

        if (points.length >= 2) {
          drawing.drawPolyline(points, entity.closed);
        }
        continue;
      }

      if (entity.type === "CIRCLE") {
        const sampled = sampleArcPoints(entity.center, entity.radius, 0, Math.PI * 2, 48)
          .map((point) => toPlacedPoint(point, placement))
          .map((point) => [point.x, point.y] as [number, number]);

        if (sampled.length >= 3) {
          drawing.drawPolyline(sampled, true);
        }
        continue;
      }

      if (entity.type === "ARC") {
        const sampled = sampleArcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle, 24)
          .map((point) => toPlacedPoint(point, placement))
          .map((point) => [point.x, point.y] as [number, number]);

        if (sampled.length >= 2) {
          drawing.drawPolyline(sampled, false);
        }
      }
    }
  }

  drawing.setActiveLayer("SHEET");
  drawing.drawText(10, Math.max(15, sheetHeight + 10), 6, 0, `TRACE:${traceId}`);

  return drawing.toDxfString();
};

export async function OPTIONS(req: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(req),
  });
}

export async function POST(req: Request) {
  const traceId = createTraceId();

  try {
    const body = await req.json().catch(() => null);
    if (!isObject(body)) {
      return json({ error: "Invalid JSON body." }, 400, req);
    }

    const sourceUrl = pickString(body.source_url, body.sourceUrl, body.url);
    const dxfContent = pickString(body.dxf_content, body.dxfContent);
    const dxfBase64 = pickString(body.dxf_base64, body.dxfBase64);

    if (!sourceUrl && !dxfContent && !dxfBase64) {
      return json(
        {
          error: "Missing DXF source.",
          details: "Provide source_url/sourceUrl, dxf_content/dxfContent, or dxf_base64/dxfBase64.",
        },
        400,
        req,
      );
    }

    const requestedFileName = pickString(body.source_file_name, body.sourceFileName, fileNameFromUrl(sourceUrl))
      || "source.dxf";
    const sourceFileName = normalizeDxfFileName(requestedFileName);

    if (!sourceFileName.toLowerCase().endsWith(".dxf")) {
      return json(
        {
          error: "DXF-only route.",
          details: "Only .dxf files are supported in v1.",
        },
        400,
        req,
      );
    }

    const quantity = pickPositiveInt(body.quantity, body.count, body.qty) || 1;
    if (quantity > MAX_PARTS_PER_REQUEST) {
      return json(
        {
          error: "Quantity too large.",
          details: `Maximum supported quantity is ${MAX_PARTS_PER_REQUEST} parts per request.`,
        },
        400,
        req,
      );
    }

    const allowRotation = pickBoolean(body.allow_rotation, body.allowRotation) ?? true;
    const syncDigifabster = pickBoolean(body.sync_digifabster, body.syncDigifabster) ?? true;
    const dryRun = pickBoolean(body.dry_run, body.dryRun) ?? false;
    const includeDxfContent = pickBoolean(body.include_dxf_content, body.includeDxfContent) ?? dryRun;

    const technologySlug = pickString(body.technology_slug, body.technologySlug) || resolveDefaultTechnologySlug();
    const machineId = pickPositiveInt(body.machine_id, body.machineId);
    const materialId = pickPositiveInt(body.material_id, body.materialId);

    const warnings: string[] = [];

    const requestedSheetWidth = pickPositiveNumber(body.sheet_width, body.sheetWidth);
    const requestedSheetHeight = pickPositiveNumber(body.sheet_height, body.sheetHeight);

    const defaults = await resolveSheetSizeFromContext({
      technologySlug,
      machineId,
      materialId,
      warnings,
    });

    const sheetWidth = requestedSheetWidth ?? defaults.width ?? DEFAULT_SHEET_WIDTH;
    const sheetHeight = requestedSheetHeight ?? defaults.height ?? DEFAULT_SHEET_HEIGHT;

    const spacing = pickPositiveNumber(body.spacing, body.part_spacing, body.partSpacing) ?? DEFAULT_PART_SPACING;

    const sourceText = await loadDxfText({ sourceUrl, dxfContent, dxfBase64 });

    const parser = new DxfParser();
    const parsed = parser.parseSync(sourceText) as { entities?: unknown[] } | null;
    const allEntities = Array.isArray(parsed?.entities) ? parsed.entities : [];
    const entities = parseSupportedEntities(allEntities);

    if (!entities.length) {
      return json(
        {
          error: "No supported DXF entities found.",
          details: "Supported entities: LINE, LWPOLYLINE, POLYLINE, ARC, CIRCLE.",
        },
        400,
        req,
      );
    }

    const partBounds = computePartBounds(entities);
    if (!partBounds || partBounds.width <= 0 || partBounds.height <= 0) {
      return json(
        {
          error: "Unable to compute part bounds.",
          details: "DXF geometry appears empty or invalid.",
        },
        400,
        req,
      );
    }

    const layout = buildLayout({
      partBounds,
      quantity,
      sheetWidth,
      sheetHeight,
      spacing,
      allowRotation,
    });

    if (!layout.chosen) {
      return json(
        {
          error: "Part does not fit on sheet.",
          details: `Part bounds ${partBounds.width.toFixed(3)} x ${partBounds.height.toFixed(3)} cannot fit into ${sheetWidth.toFixed(3)} x ${sheetHeight.toFixed(3)} with spacing ${spacing.toFixed(3)}.`,
        },
        400,
        req,
      );
    }

    const nestedDxf = renderNestedDxf({
      entities,
      partBounds,
      placements: layout.placements,
      sheetCount: layout.sheetCount,
      sheetWidth,
      sheetHeight,
      traceId,
    });

    const sourceBaseName = toBaseName(sourceFileName);
    const nestedFileName = normalizeDxfFileName(`${sourceBaseName}-nested-${Date.now()}.dxf`);

    let nestedFileUrl: string | null = null;
    const blobToken = process.env.BLOB_READ_WRITE_TOKEN?.trim() || "";

    if (!dryRun && blobToken) {
      try {
        const sourceSignature = simpleHash(`${sourceUrl || "inline"}|${sourceFileName}|${quantity}`);
        const blobPath = `sheet-nesting/${sourceSignature}/${nestedFileName}`;
        const uploaded = await put(blobPath, nestedDxf, {
          access: "public",
          contentType: "application/dxf",
          addRandomSuffix: false,
          token: blobToken,
        });
        nestedFileUrl = uploaded.url;
      } catch (error) {
        warnings.push(
          error instanceof Error
            ? `Blob upload failed: ${error.message}`
            : "Blob upload failed.",
        );
      }
    } else if (!blobToken) {
      warnings.push("BLOB_READ_WRITE_TOKEN is missing, nested file URL was not generated.");
    }

    const partId = pickString(body.part_id, body.partId);
    const version = pickString(body.version);

    let digifabsterUpload: Record<string, unknown> = {
      status: "skipped",
      reason: dryRun ? "dry_run" : "sync_disabled",
    };

    if (!dryRun && syncDigifabster) {
      if (!nestedFileUrl) {
        digifabsterUpload = {
          status: "skipped",
          reason: "nested_file_url_missing",
        };
      } else {
        try {
          const uploadUrn = `nesting:${simpleHash(`${sourceFileName}|${quantity}|${sheetWidth}|${sheetHeight}|${spacing}`)}`;
          const uploadResult = await syncNativeSourceToDigifabster({
            urn: uploadUrn,
            sourceUrl: nestedFileUrl,
            sourceFileName: nestedFileName,
            partId: partId || undefined,
            version: version || undefined,
            traceId,
          });

          digifabsterUpload = {
            status: uploadResult.status,
            source: uploadResult.source,
            objectModelId: uploadResult.objectModelId,
            orderId: uploadResult.orderId,
            sessionId: uploadResult.sessionId,
            quoteStatus: uploadResult.quoteStatus,
            reason: uploadResult.reason || null,
          };
        } catch (error) {
          digifabsterUpload = {
            status: "failed",
            reason: error instanceof Error ? error.message : "Digifabster sync failed.",
          };
        }
      }
    }

    const response: Record<string, unknown> = {
      success: true,
      traceId,
      source: {
        fileName: sourceFileName,
        sourceUrl: sourceUrl || null,
      },
      sheet: {
        width: sheetWidth,
        height: sheetHeight,
        source:
          requestedSheetWidth && requestedSheetHeight
            ? "request"
            : defaults.source || "fallback",
        technologySlug,
        machineId,
        materialId,
      },
      nesting: {
        engine: "single-part-grid-v1",
        rotationDeg: layout.chosen.rotationDeg,
        partWidth: layout.chosen.partWidth,
        partHeight: layout.chosen.partHeight,
        quantityRequested: quantity,
        partsPlaced: layout.placements.length,
        perSheetCapacity: layout.chosen.perSheetCapacity,
        sheetCount: layout.sheetCount,
        spacing,
        inputEntityCount: allEntities.length,
        supportedEntityCount: entities.length,
        unsupportedEntityCount: Math.max(0, allEntities.length - entities.length),
      },
      output: {
        fileName: nestedFileName,
        fileUrl: nestedFileUrl,
        bytes: Buffer.byteLength(nestedDxf, "utf8"),
      },
      digifabsterUpload,
      warnings,
    };

    if (!nestedFileUrl || includeDxfContent) {
      response.output = {
        ...(response.output as Record<string, unknown>),
        dxf: nestedDxf,
      };
    }

    return json(response, 200, req);
  } catch (error) {
    return json(
      {
        error: "Sheet nesting failed.",
        details: error instanceof Error ? error.message : "Unknown nesting error.",
      },
      500,
      req,
    );
  }
}
