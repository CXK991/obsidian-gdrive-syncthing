/**
 * 插件配置项、同步索引与状态类型定义。
 */

import type { CloudFileInfo } from "./gdrive/GDriveClient";

/** 插件设置（保存在 data.json） */
export interface GDriveSyncSettings {
  /** Google OAuth 客户端 ID */
  clientId: string;
  /** Google OAuth 客户端密钥 */
  clientSecret: string;
  /** 长期刷新令牌 */
  refreshToken: string;
  /** 短期访问令牌（持久化缓存，可自动刷新） */
  accessToken: string;
  /** Access Token 过期时间（epoch ms） */
  tokenExpiresAt: number;
  /** OAuth 重定向地址 */
  redirectUri: string;
  /** Google Drive 同步根目录名称 */
  syncRootName: string;
  /** Google Drive 同步根目录 ID（自动创建后回填） */
  syncRootFolderId: string;
  /** 云端轮询间隔（秒），0 表示禁用 */
  pollIntervalSec: number;
  /** 应用启动时自动同步 */
  syncOnStartup: boolean;
  /** 本地事件防抖毫秒数 */
  debounceMs: number;
  /** 排除的本地/云端相对路径（每行一个） */
  excludedPaths: string[];
  /** 云端删除时移入回收站而非永久删除 */
  useTrashForDeletes: boolean;
  /** 上次同步时间（epoch ms） */
  lastSyncAt: number;
  /** 上次同步状态描述 */
  lastSyncStatus: string;
}

export const DEFAULT_SETTINGS: GDriveSyncSettings = {
  clientId: "",
  clientSecret: "",
  refreshToken: "",
  accessToken: "",
  tokenExpiresAt: 0,
  redirectUri: "http://localhost:8080/",
  syncRootName: "Sync_Obsidian",
  syncRootFolderId: "",
  pollIntervalSec: 60,
  syncOnStartup: true,
  debounceMs: 1000,
  excludedPaths: [".obsidian", ".trash", ".git"],
  useTrashForDeletes: true,
  lastSyncAt: 0,
  lastSyncStatus: "",
};

/** 同步索引中单个文件的元数据 */
export interface IndexEntry {
  /** 相对路径（相对仓库根目录，使用 / 分隔） */
  relativePath: string;
  /** 本地修改时间（epoch ms） */
  localMtime: number;
  /** 本地文件大小（字节） */
  localSize: number;
  /** 本地内容 SHA-256 十六进制散列 */
  localHash: string | null;
  /** Google Drive 文件 ID */
  fileId: string;
  /** 云端修改时间（epoch ms） */
  cloudModifiedTime: number;
  /** 云端 MD5 散列 */
  cloudMd5: string | null;
  /** 云端文件大小（字节） */
  cloudSize: number | null;
}

/** 同步索引文件（.obsidian/gdrive-sync-index.json） */
export interface SyncIndex {
  version: number;
  rootFolderId: string;
  /** relativePath → 索引条目 */
  entries: Record<string, IndexEntry>;
}

/** 本地文件扫描信息 */
export interface LocalFileInfo {
  relativePath: string;
  mtime: number;
  size: number;
}

export type SyncActionKind = "upload" | "download" | "deleteLocal" | "deleteCloud" | "conflict";

/** 删除冲突的恢复方式（本地已删但云端已改 → 恢复下载；云端已删但本地已改 → 恢复上传） */
export type SyncActionVariant = "recoverUpload" | "recoverDownload";

/** 一次同步中针对单个文件的动作 */
export interface SyncAction {
  kind: SyncActionKind;
  relativePath: string;
  reason: string;
  /** 用于区分“删除冲突”的恢复动作 */
  variant?: SyncActionVariant;
  fileId?: string;
  local?: LocalFileInfo;
  cloud?: CloudFileInfo;
}

export type SyncStatus = "idle" | "syncing" | "paused" | "error" | "needs-auth";

/** 一次同步的统计结果 */
export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedCloud: number;
  conflicts: number;
  skipped: number;
  errors: number;
}