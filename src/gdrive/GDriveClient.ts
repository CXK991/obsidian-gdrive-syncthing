/**
 * Google Drive REST API v3 封装。
 *
 * - OAuth 2.0：支持授权码换取令牌、Refresh Token 自动换取 Access Token；
 * - 上传（multipart/related，手动构造边界，兼容桌面与移动端 WebView）；
 * - 下载、递归列出、创建目录、删除/移入回收站；
 * - 全部基于原生 fetch，无额外运行时依赖。
 */

import type { GDriveSyncSettings } from "../types";
import { errorMessage, sleep } from "../utils";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveFilePayload {
  id: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  md5Checksum?: string | null;
  size?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface CloudFileInfo {
  id: string;
  name: string;
  mimeType: string;
  /** 相对同步根目录的路径 */
  relPath: string;
  /** 云端修改时间（epoch ms） */
  modifiedTimeMs: number;
  md5Checksum: string | null;
  size: number | null;
  parents: string[];
}

export interface UploadedFileInfo {
  id: string;
  name: string;
  modifiedTimeMs: number;
  md5Checksum: string | null;
  size: number | null;
}

export class GDriveApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GDriveApiError";
    this.status = status;
  }
}

export class GDriveClient {
  constructor(
    private readonly settings: GDriveSyncSettings,
    private readonly persistTokens: () => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  // ---------- OAuth 2.0 ----------

  /** 确保存在未过期的 Access Token，必要时用 Refresh Token 自动刷新 */
  async ensureAccessToken(): Promise<string> {
    if (this.settings.accessToken && this.settings.tokenExpiresAt > Date.now() + 60_000) {
      return this.settings.accessToken;
    }
    if (!this.settings.refreshToken) {
      const error = new Error("未配置 Refresh Token。请在设置中填写 Client ID / Client Secret / Refresh Token，或重新完成授权。");
      (error as { needsAuth?: boolean }).needsAuth = true;
      throw error;
    }
    await this.refreshAccessToken();
    return this.settings.accessToken;
  }

  private async refreshAccessToken(): Promise<void> {
    const body = new URLSearchParams();
    body.set("client_id", this.settings.clientId);
    body.set("client_secret", this.settings.clientSecret);
    body.set("refresh_token", this.settings.refreshToken);
    body.set("grant_type", "refresh_token");
    const data = await this.postTokenRequest(body);
    const accessToken = data.access_token as string | undefined;
    if (!accessToken) throw new Error("认证服务器未返回 access_token");
    this.settings.accessToken = accessToken;
    this.settings.tokenExpiresAt = Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000;
    await this.persistTokens();
    this.log("已刷新 Access Token");
  }

  /** 生成 OAuth 授权链接（access_type=offline + prompt=consent 保证返回 Refresh Token） */
  createAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.settings.clientId,
      redirect_uri: this.settings.redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /** 用一次性授权码换取 Access Token 与 Refresh Token */
  async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string | null; expiresAt: number }> {
    const body = new URLSearchParams();
    body.set("client_id", this.settings.clientId);
    body.set("client_secret", this.settings.clientSecret);
    body.set("code", code);
    body.set("redirect_uri", redirectUri);
    body.set("grant_type", "authorization_code");
    const data = await this.postTokenRequest(body);
    const accessToken = data.access_token as string | undefined;
    if (!accessToken) throw new Error("认证服务器未返回 access_token");
    const expiresAt = Date.now() + (Number(data.expires_in ?? 3600) - 60) * 1000;
    return {
      accessToken,
      refreshToken: typeof data.refresh_token === "string" && data.refresh_token.length > 0 ? data.refresh_token : null,
      expiresAt,
    };
  }

  private async postTokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (error) {
      throw new Error(`无法连接 Google 认证服务器：${errorMessage(error)}`);
    }
    if (!response.ok) {
      let data: Record<string, unknown> | null = null;
      try {
        data = (await response.json()) as Record<string, unknown>;
      } catch {
        // 忽略解析失败
      }
      const errorType = (data?.error as string) ?? "";
      const reason = (data?.error_description as string) ?? errorType ?? `HTTP ${response.status}`;
      if (errorType === "invalid_grant" || /Bad Request/.test(reason)) {
        throw new Error("获取令牌失败：授权码无效、已过期或已被使用。请重新点击「生成授权链接」获取新授权码，复制后立即换取令牌");
      }
      if (errorType === "invalid_client") {
        throw new Error("获取令牌失败：Client ID 或 Client Secret 错误，请检查设置");
      }
      if (errorType === "redirect_uri_mismatch") {
        throw new Error("获取令牌失败：Redirect URI 与授权时不一致，请保持两者相同（rclone 凭据使用 http://127.0.0.1:53682/）");
      }
      throw new Error(`获取令牌失败：${reason}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  // ---------- 基础请求 ----------

  private async fetchWithAuth(url: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const token = await this.ensureAccessToken();
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Authorization: `Bearer ${token}`,
    };
    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } catch (error) {
      throw new Error(`网络请求失败：${errorMessage(error)}。请检查网络连接后重试。`);
    }
    if (response.status === 401 && !retried) {
      this.log("Access Token 已失效，正在刷新后重试…");
      this.settings.accessToken = "";
      this.settings.tokenExpiresAt = 0;
      await this.persistTokens();
      return this.fetchWithAuth(url, init, true);
    }
    return response;
  }

  private async request<T>(
    method: string,
    url: string,
    options: { body?: BodyInit; headers?: Record<string, string> } = {},
    retried = false,
  ): Promise<T> {
    const response = await this.fetchWithAuth(url, { method, body: options.body, headers: options.headers }, retried);
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // 忽略解析失败
      }
      if (!retried && (response.status === 429 || this.isQuotaError(body))) {
        this.log("Google API 配额繁忙，等待 30 秒后自动重试…");
        await sleep(30_000);
        return this.request<T>(method, url, options, true);
      }
      throw new GDriveApiError(this.friendlyError(response.status, body), response.status);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return JSON.parse(text) as T;
  }

  private friendlyError(status: number, body: unknown): string {
    const message = (body as { error?: { message?: string } } | null)?.error?.message;
    switch (status) {
      case 400:
        return `请求参数错误：${message ?? "Google Drive 拒绝了该请求"}`;
      case 401:
        return "认证失败：Access Token 无效或已过期";
      case 403:
        if (message && /quota exceeded|rateLimitExceeded|Queries per minute/i.test(message)) {
          return "Google Drive 配额繁忙：当前项目每分钟请求数超限（rclone 公共凭据为全球共享）。请稍后重试，或创建自己的 Google Cloud 凭据获得独立配额";
        }
        return `权限不足：${message ?? "请检查 OAuth 授权范围与 Drive API 是否已启用"}`;
      case 404:
        return "云端资源不存在：文件或目录可能已被移动/删除";
      case 409:
        return "云端状态冲突：文件可能刚被其他设备修改，请稍后重试";
      case 429:
        return "请求过于频繁：已触发 Google API 限流，请稍后重试";
      case 500:
      case 502:
      case 503:
      case 504:
        return "Google Drive 服务暂时不可用，请稍后重试";
      default:
        return message ? `请求失败：${message}` : `请求失败（HTTP ${status}）`;
    }
  }

  /** 判断是否为 Google API 配额/限流错误（403 Quota exceeded / rateLimitExceeded / 429） */
  private isQuotaError(body: unknown): boolean {
    const message = (body as { error?: { message?: string } } | null)?.error?.message ?? "";
    return /quota exceeded|rateLimitExceeded|userRateLimitExceeded|Queries per minute/i.test(message);
  }

  // ---------- Drive 文件操作 ----------

  /** 查找或创建同步根目录，返回目录 ID */
  async ensureRootFolder(name: string): Promise<string> {
    const query = `name = '${name.replace(/'/g, "\\'")}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`;
    const url = `${API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=10&supportsAllDrives=true`;
    const data = await this.request<{ files?: DriveFilePayload[] }>("GET", url);
    const found = data.files?.find((file) => file.id);
    if (found) {
      this.log(`使用已有同步根目录：${name} (${found.id})`);
      return found.id;
    }
    const id = await this.createFolder(name, "root");
    this.log(`已创建同步根目录：${name} (${id})`);
    return id;
  }

  /** 递归列出同步根目录下的全部文件与子目录（跳过排除路径） */
  async listFilesRecursive(
    rootFolderId: string,
    isExcluded: (relPath: string) => boolean,
  ): Promise<{ files: CloudFileInfo[]; folders: Map<string, string> }> {
    const files: CloudFileInfo[] = [];
    const folders = new Map<string, string>();
    folders.set("", rootFolderId);
    const queue: Array<{ id: string; rel: string }> = [{ id: rootFolderId, rel: "" }];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${current.id}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,parents)",
          pageSize: "1000",
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
        });
        if (pageToken) params.set("pageToken", pageToken);
        const data = await this.request<{ nextPageToken?: string; files?: DriveFilePayload[] }>(
          "GET",
          `${API_BASE}/files?${params.toString()}`,
        );
        for (const item of data.files ?? []) {
          const name = item.name ?? "";
          const relPath = current.rel ? `${current.rel}/${name}` : name;
          if (isExcluded(relPath)) continue;
          if (item.mimeType === FOLDER_MIME) {
            folders.set(relPath, item.id);
            queue.push({ id: item.id, rel: relPath });
          } else {
            files.push({
              id: item.id,
              name: item.name ?? "",
              mimeType: item.mimeType ?? "application/octet-stream",
              relPath,
              modifiedTimeMs: item.modifiedTime ? Date.parse(item.modifiedTime) || Date.now() : Date.now(),
              md5Checksum: item.md5Checksum ?? null,
              size: item.size != null && item.size !== "" ? Number(item.size) : null,
              parents: item.parents ?? [],
            });
          }
        }
        pageToken = data.nextPageToken;
      } while (pageToken);
    }
    return { files, folders };
  }

  /** 创建文件夹，返回文件夹 ID */
  async createFolder(name: string, parentId: string): Promise<string> {
    const data = await this.request<DriveFilePayload>("POST", `${API_BASE}/files?supportsAllDrives=true`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return data.id;
  }

  /**
   * 上传（新建或更新）文件，返回云端元数据。
   *
   * 采用 Google 官方 resumable 两段式上传，最大限度规避不同 WebView 的兼容问题：
   * 1. 第一步：用与「创建文件夹」完全相同的 JSON 请求初始化上传会话（返回 Location 上传地址）；
   * 2. 第二步：把文件内容 PUT 到 Google 返回的上传地址（URL 由 Google 生成，内容不会被误解析）。
   * parents 只在新建时的初始化请求中设置（Google 禁止在更新请求中直接写 parents）。
   */
  async uploadFile(options: { parentId: string; name: string; mimeType: string; data: ArrayBuffer; fileId?: string }): Promise<UploadedFileInfo> {
    const metadata: Record<string, unknown> = { name: options.name, mimeType: options.mimeType };
    if (!options.fileId) metadata.parents = [options.parentId];
    const initUrl = options.fileId
      ? `${API_BASE}/files/${options.fileId}?uploadType=resumable&supportsAllDrives=true`
      : `${API_BASE}/files?uploadType=resumable&supportsAllDrives=true`;
    const initResponse = await this.fetchWithAuth(initUrl, {
      method: options.fileId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata),
    });
    if (!initResponse.ok) {
      let body: unknown = null;
      try {
        body = await initResponse.json();
      } catch {
        // 忽略解析失败
      }
      throw new GDriveApiError(this.friendlyError(initResponse.status, body), initResponse.status);
    }
    const location = initResponse.headers.get("Location");
    if (!location) throw new Error("Google 未返回上传会话地址（缺少 Location 头），请重试");

    const uploadResponse = await this.fetchWithAuth(location, {
      method: "PUT",
      headers: { "Content-Type": options.mimeType },
      body: options.data,
    });
    if (!uploadResponse.ok) {
      let body: unknown = null;
      try {
        body = await uploadResponse.json();
      } catch {
        // 忽略解析失败
      }
      throw new GDriveApiError(this.friendlyError(uploadResponse.status, body), uploadResponse.status);
    }
    const result = (await uploadResponse.json()) as DriveFilePayload;
    return {
      id: result.id,
      name: result.name ?? options.name,
      modifiedTimeMs: result.modifiedTime ? Date.parse(result.modifiedTime) || Date.now() : Date.now(),
      md5Checksum: result.md5Checksum ?? null,
      size: result.size != null && result.size !== "" ? Number(result.size) : null,
    };
  }

  /** 下载文件内容（二进制） */
  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    const response = await this.fetchWithAuth(`${API_BASE}/files/${fileId}?alt=media&supportsAllDrives=true`);
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // 忽略解析失败
      }
      throw new GDriveApiError(this.friendlyError(response.status, body), response.status);
    }
    return response.arrayBuffer();
  }

  /** 将文件移入云端回收站（可恢复） */
  async trashFile(fileId: string): Promise<void> {
    await this.request("PATCH", `${API_BASE}/files/${fileId}?supportsAllDrives=true`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
  }

  /** 永久删除云端文件 */
  async deleteFile(fileId: string): Promise<void> {
    await this.request("DELETE", `${API_BASE}/files/${fileId}?supportsAllDrives=true`);
  }

  /** 获取当前授权用户信息（用于测试连接） */
  async getUserInfo(): Promise<{ displayName: string; email: string }> {
    const data = await this.request<{ user?: { displayName?: string; emailAddress?: string } }>(
      "GET",
      `${API_BASE}/about?fields=user(displayName,emailAddress)`,
    );
    return {
      displayName: data.user?.displayName ?? "未知用户",
      email: data.user?.emailAddress ?? "未知邮箱",
    };
  }


}