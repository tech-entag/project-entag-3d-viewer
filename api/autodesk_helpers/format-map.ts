export type QuoteTargetFormat = "step" | "dwg" | null;

export type QuoteMode = "native" | "direct" | "none";

export interface FormatClassification {
  extension: string;
  viewerPriority: true;
  quote: {
    mode: QuoteMode;
    required: boolean;
    targetFormat: QuoteTargetFormat;
    reason: string;
  };
}

const DIGIFABSTER_NATIVE_DEFAULT = [
  "stl",
  "stla",
  "stlb",
  "step",
  "stp",
  "ste",
  "iges",
  "igs",
  "ige",
  "dxf",
  "dwg",
  "3mf",
  "wrl",
];

const STEP_DIRECT_DEFAULT = ["f3d", "fbx", "iam", "ipt", "smb", "smt", "wire"];
const DWG_DIRECT_DEFAULT = ["rvt", "f2d", "slddrw"];

const SHORT_SCOPE_DEFAULT = [
  ...DIGIFABSTER_NATIVE_DEFAULT,
  ...STEP_DIRECT_DEFAULT,
  ...DWG_DIRECT_DEFAULT,
];

const DIRECT_2D_NO_TRANSLATION_DEFAULT = ["dxf", "dwg", "f2d", "slddrw"];

const parseCsv = (value: string | undefined, fallback: string[]) => {
  if (!value || !value.trim()) {
    return new Set(fallback);
  }

  return new Set(
    value
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
};

export const getQuoteSupportedFormats = () =>
  parseCsv(process.env.QUOTE_SUPPORTED_FORMATS, SHORT_SCOPE_DEFAULT);

export const getDigifabsterNativeFormats = () =>
  parseCsv(process.env.DIGIFABSTER_NATIVE_FORMATS, DIGIFABSTER_NATIVE_DEFAULT);

export const getDirect2dNoTranslationFormats = () =>
  parseCsv(process.env.DIRECT_2D_NO_TRANSLATION_FORMATS, DIRECT_2D_NO_TRANSLATION_DEFAULT);

export const getExtension = (fileName: string) => {
  const normalized = fileName.toLowerCase().split("?")[0].split("#")[0];
  const index = normalized.lastIndexOf(".");
  if (index === -1 || index === normalized.length - 1) {
    return "";
  }

  return normalized.slice(index + 1);
};

export const classifySourceFormat = (fileName: string): FormatClassification => {
  const extension = getExtension(fileName);
  const quoteSupported = getQuoteSupportedFormats();
  const digifabsterNative = getDigifabsterNativeFormats();

  if (digifabsterNative.has(extension)) {
    return {
      extension,
      viewerPriority: true,
      quote: {
        mode: "native",
        required: false,
        targetFormat: null,
        reason: "Source format is already Digifabster-compatible.",
      },
    };
  }

  if (STEP_DIRECT_DEFAULT.includes(extension) && quoteSupported.has(extension)) {
    return {
      extension,
      viewerPriority: true,
      quote: {
        mode: "direct",
        required: true,
        targetFormat: "step",
        reason: "Direct STEP conversion is supported in short-scope mode.",
      },
    };
  }

  if (DWG_DIRECT_DEFAULT.includes(extension) && quoteSupported.has(extension)) {
    return {
      extension,
      viewerPriority: true,
      quote: {
        mode: "direct",
        required: true,
        targetFormat: "dwg",
        reason: "Direct DWG conversion is supported in short-scope mode.",
      },
    };
  }

  return {
    extension,
    viewerPriority: true,
    quote: {
      mode: "none",
      required: false,
      targetFormat: null,
      reason: "Format is outside configured short-scope quote conversion list.",
    },
  };
};

export const shouldSkipAutodeskTranslationForFormat = (extension: string) => {
  if (!extension) {
    return false;
  }

  return getDirect2dNoTranslationFormats().has(extension.toLowerCase());
};

export const shouldSkipAutodeskTranslationForSource = (fileName: string) => {
  const extension = getExtension(fileName);
  return shouldSkipAutodeskTranslationForFormat(extension);
};
