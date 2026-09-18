import { env } from "./config.js";

const API = "https://api.webflow.com/v2";

export class WebflowError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.webflowToken}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (res.status === 429 && attempt < 5) {
      const wait = Number(res.headers.get("retry-after") ?? 10);
      await sleep(Math.min(wait, 60) * 1000);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let code = `HTTP_${res.status}`;
      let message = text.slice(0, 500);
      try {
        const body = JSON.parse(text);
        code = body.code ?? code;
        message = body.message ?? message;
      } catch { /* keep raw text */ }
      throw new WebflowError(res.status, code, message);
    }
    return JSON.parse(text) as T;
  }
}

export interface WebflowSite { id: string; displayName: string; shortName: string; lastPublished?: string }
export interface AssetFolder { id: string; displayName: string; parentFolder?: string | null }

export async function tokenInfo(): Promise<{ authorization: { authorizedTo?: { scopes?: string[] } } } & Record<string, unknown>> {
  return api("/token/introspect");
}

export async function listSites(): Promise<WebflowSite[]> {
  const r = await api<{ sites: WebflowSite[] }>("/sites");
  return r.sites;
}

export async function getSite(siteId: string): Promise<WebflowSite> {
  return api(`/sites/${siteId}`);
}

export async function listAssetFolders(siteId: string): Promise<AssetFolder[]> {
  const r = await api<{ assetFolders: AssetFolder[] }>(`/sites/${siteId}/asset_folders`);
  return r.assetFolders;
}

export async function createAssetFolder(siteId: string, displayName: string, parentFolder?: string): Promise<AssetFolder> {
  return api(`/sites/${siteId}/asset_folders`, {
    method: "POST",
    body: JSON.stringify(parentFolder ? { displayName, parentFolder } : { displayName }),
  });
}

export interface AssetCreateResponse {
  id: string;
  uploadUrl: string;
  uploadDetails: Record<string, string>;
  hostedUrl?: string;
  assetUrl?: string;
}

export async function createAssetMeta(siteId: string, fileName: string, fileHash: string, parentFolder?: string): Promise<AssetCreateResponse> {
  const body: Record<string, string> = { fileName, fileHash };
  if (parentFolder) body.parentFolder = parentFolder;
  return api(`/sites/${siteId}/assets`, { method: "POST", body: JSON.stringify(body) });
}

/** Second step of the upload flow: POST the file to the returned S3 URL. */
export async function uploadAssetFile(created: AssetCreateResponse, data: Buffer, fileName: string): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(created.uploadDetails ?? {})) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(data)]), fileName);
  const res = await fetch(created.uploadUrl, { method: "POST", body: form });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new WebflowError(res.status, "S3_UPLOAD_FAILED", (await res.text()).slice(0, 500));
  }
}
