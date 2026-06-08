import { createHash } from "node:crypto";

export interface AutodeskEmbedAccount {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

const DEFAULT_ACCOUNT_ID = "autodesk-account-1";

const normalizeSecretValue = (value: string | undefined) => {
  return (value || "").replace(/[\r\n]+/g, "").trim();
};

const readPoolFromJson = (): AutodeskEmbedAccount[] => {
  const rawPool = normalizeSecretValue(process.env.AUTODESK_ACCOUNT_POOL_JSON);
  if (!rawPool) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawPool) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const accounts: AutodeskEmbedAccount[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const accountIdCandidate =
        (typeof record.accountId === "string" && record.accountId.trim())
        || (typeof record.id === "string" && record.id.trim())
        || null;
      const clientId = typeof record.clientId === "string" ? record.clientId.trim() : "";
      const clientSecret = typeof record.clientSecret === "string" ? normalizeSecretValue(record.clientSecret) : "";

      if (!clientId || !clientSecret) {
        continue;
      }

      accounts.push({
        accountId: accountIdCandidate || `autodesk-account-${accounts.length + 1}`,
        clientId,
        clientSecret,
      });
    }

    return accounts;
  } catch {
    return [];
  }
};

const readSingleAccountFallback = (): AutodeskEmbedAccount[] => {
  const clientId = normalizeSecretValue(
    process.env.AUTODESK_CLIENT_ID || process.env.APS_CLIENT_ID || process.env.CLIENT_ID
  );
  const clientSecret = normalizeSecretValue(
    process.env.AUTODESK_CLIENT_SECRET || process.env.APS_CLIENT_SECRET || process.env.CLIENT_SECRET
  );

  if (!clientId || !clientSecret) {
    return [];
  }

  return [
    {
      accountId: normalizeSecretValue(process.env.AUTODESK_ACCOUNT_ID) || DEFAULT_ACCOUNT_ID,
      clientId,
      clientSecret,
    },
  ];
};

const readIndexedFallback = (): AutodeskEmbedAccount[] => {
  const accounts: AutodeskEmbedAccount[] = [];

  for (let index = 1; index <= 12; index += 1) {
    const clientId = normalizeSecretValue(process.env[`AUTODESK_CLIENT_ID_${index}`]);
    const clientSecret = normalizeSecretValue(process.env[`AUTODESK_CLIENT_SECRET_${index}`]);
    if (!clientId || !clientSecret) {
      continue;
    }

    accounts.push({
      accountId: normalizeSecretValue(process.env[`AUTODESK_ACCOUNT_ID_${index}`]) || `autodesk-account-${index}`,
      clientId,
      clientSecret,
    });
  }

  return accounts;
};

let cachedPoolFingerprint = "";
let cachedPool: AutodeskEmbedAccount[] = [];

const getPoolFingerprint = () => {
  const relevant = [
    normalizeSecretValue(process.env.AUTODESK_ACCOUNT_POOL_JSON),
    normalizeSecretValue(process.env.AUTODESK_CLIENT_ID),
    normalizeSecretValue(process.env.AUTODESK_CLIENT_SECRET),
    normalizeSecretValue(process.env.APS_CLIENT_ID),
    normalizeSecretValue(process.env.APS_CLIENT_SECRET),
  ];

  for (let index = 1; index <= 12; index += 1) {
    relevant.push(normalizeSecretValue(process.env[`AUTODESK_CLIENT_ID_${index}`]));
    relevant.push(normalizeSecretValue(process.env[`AUTODESK_CLIENT_SECRET_${index}`]));
    relevant.push(normalizeSecretValue(process.env[`AUTODESK_ACCOUNT_ID_${index}`]));
  }

  return relevant.join("|");
};

export const getAutodeskAccountPool = () => {
  const fingerprint = getPoolFingerprint();
  if (cachedPool.length > 0 && fingerprint === cachedPoolFingerprint) {
    return cachedPool;
  }

  const poolFromJson = readPoolFromJson();
  const poolFromIndexed = readIndexedFallback();
  const singleFallback = readSingleAccountFallback();

  const nextPool = poolFromJson.length > 0
    ? poolFromJson
    : (poolFromIndexed.length > 0 ? poolFromIndexed : singleFallback);

  cachedPoolFingerprint = fingerprint;
  cachedPool = nextPool;
  return nextPool;
};

const hashToInt = (value: string) => {
  const digest = createHash("sha256").update(value).digest();
  return digest.readUInt32BE(0);
};

export const getAutodeskAccountForPart = (vercelPartId: string) => {
  const pool = getAutodeskAccountPool();
  if (pool.length === 0) {
    return null;
  }

  const index = hashToInt(vercelPartId) % pool.length;
  return pool[index];
};

export const getAutodeskAccountById = (accountId: string | null | undefined) => {
  if (!accountId) {
    return null;
  }

  const pool = getAutodeskAccountPool();
  return pool.find((account) => account.accountId === accountId) ?? null;
};
