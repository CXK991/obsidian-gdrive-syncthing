/**
 * 本地与云端索引元数据比对库。
 *
 * - 维护 .obsidian/gdrive-sync-index.json（相对路径、mtime、fileId、云端 modifiedTime、SHA-256/MD5 散列）；
 * - 对比生成上传 / 下载 / 删除 / 冲突动作计划；
 * - 全部本地读写使用 this.app.vault.adapter，兼容 iOS / Android 移动端。
 */

import { App } from "obsidian";
import type { CloudFileInfo } from "../gdrive/GDriveClient";
import type { GDriveSyncSettings, IndexEntry, LocalFileInfo, SyncAction, SyncIndex } from "../types";

export const INDEX_PATH = ".obsidian/gdrive-sync-index.json";

export class IndexManager {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => GDriveSyncSettings,
  ) {}

  /** 判断相对路径是否命中排除规则 */
  isExcluded(relativePath: string): boolean {
    const normalized = relativePath.replace(/^\/+/, "");
    for (const raw of this.getSettings().excludedPaths) {
      const rule = raw.trim().replace(/^\/+|\/+$/g, "");
      if (!rule) continue;
      if (normalized === rule || normalized.startsWith(rule + "/")) return true;
    }
    return false;
  }

  /** 读取本地索引；不存在或损坏时返回空索引 */
  async loadIndex(): Promise<SyncIndex> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(INDEX_PATH)) {
        const text = await adapter.read(INDEX_PATH);
        const parsed = JSON.parse(text) as Partial<SyncIndex>;
        if (parsed && typeof parsed === "object") {
          return {
            version: 1,
            rootFolderId: typeof parsed.rootFolderId === "string" ? parsed.rootFolderId : "",
            entries: parsed.entries && typeof parsed.entries === "object" ? parsed.entries : {},
          };
        }
      }
    } catch (error) {
      console.warn("[gdrive-syncthing] 读取索引失败，将重建索引：", error);
    }
    return { version: 1, rootFolderId: "", entries: {} };
  }

  async saveIndex(index: SyncIndex): Promise<void> {
    await this.app.vault.adapter.write(INDEX_PATH, JSON.stringify(index, null, 2));
  }

  /** 扫描本地全部文件（跳过排除路径） */
  async scanLocalFiles(): Promise<Map<string, LocalFileInfo>> {
    const result = new Map<string, LocalFileInfo>();
    for (const file of this.app.vault.getFiles()) {
      if (this.isExcluded(file.path)) continue;
      result.set(file.path, { relativePath: file.path, mtime: file.stat.mtime, size: file.stat.size });
    }
    return result;
  }

  /** 计算缓冲区 SHA-256（Web Crypto，无额外依赖） */
  async hashBuffer(data: ArrayBuffer): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
  }

  /** 计算本地文件 SHA-256；读取失败返回 null */
  async hashFile(relativePath: string): Promise<string | null> {
    try {
      const data = await this.app.vault.adapter.readBinary(relativePath);
      return await this.hashBuffer(data);
    } catch (error) {
      console.warn(`[gdrive-syncthing] 计算本地散列失败：${relativePath}`, error);
      return null;
    }
  }

  /** 本地是否相对索引发生变化 */
  isLocalChanged(entry: IndexEntry, local: LocalFileInfo): boolean {
    return entry.localMtime !== local.mtime || entry.localSize !== local.size;
  }

  /** 云端是否相对索引发生变化（时间戳或文件 ID 变更） */
  isCloudChanged(entry: IndexEntry, cloud: CloudFileInfo): boolean {
    return entry.cloudModifiedTime !== cloud.modifiedTimeMs || entry.fileId !== cloud.id;
  }

  /**
   * 核心比对：根据索引与两侧现状生成动作计划。
   *
   * 规则（Syncthing 语义）：
   * - 仅本地变动 → 上传；仅云端变动 → 下载；双向无变动 → 跳过；
   * - 双向同时变动 → 冲突（保留本地原名，云端版本生成 .sync-conflict-* 副本）；
   * - 本地已改 + 云端已删 → 恢复上传（防止删除覆盖新内容）；
   * - 本地已删 + 云端已改 → 恢复下载（防止误删覆盖新内容）；
   * - 本地/云端单侧删除且对侧未变动 → 传播删除。
   */
  buildPlan(index: SyncIndex, localFiles: Map<string, LocalFileInfo>, cloudFiles: Map<string, CloudFileInfo>): SyncAction[] {
    const actions: SyncAction[] = [];

    for (const [relPath, entry] of Object.entries(index.entries)) {
      const local = localFiles.get(relPath);
      const cloud = cloudFiles.get(relPath);

      if (local && cloud) {
        const localChanged = this.isLocalChanged(entry, local);
        const cloudChanged = this.isCloudChanged(entry, cloud);
        if (localChanged && cloudChanged) {
          actions.push({ kind: "conflict", relativePath: relPath, reason: "本地与云端同时修改", local, cloud, fileId: entry.fileId });
        } else if (localChanged) {
          actions.push({ kind: "upload", relativePath: relPath, reason: "仅本地修改", local, cloud, fileId: entry.fileId });
        } else if (cloudChanged) {
          actions.push({ kind: "download", relativePath: relPath, reason: "仅云端修改", local, cloud, fileId: entry.fileId });
        }
      } else if (local && !cloud) {
        if (this.isLocalChanged(entry, local)) {
          actions.push({
            kind: "upload",
            variant: "recoverUpload",
            relativePath: relPath,
            reason: "本地已修改但云端已删除（删除冲突，恢复上传）",
            local,
            fileId: entry.fileId,
          });
        } else {
          actions.push({ kind: "deleteLocal", relativePath: relPath, reason: "云端已删除", local, fileId: entry.fileId });
        }
      } else if (!local && cloud) {
        if (this.isCloudChanged(entry, cloud)) {
          actions.push({
            kind: "download",
            variant: "recoverDownload",
            relativePath: relPath,
            reason: "本地已删除但云端已修改（删除冲突，恢复下载）",
            cloud,
            fileId: entry.fileId,
          });
        } else {
          actions.push({ kind: "deleteCloud", relativePath: relPath, reason: "本地已删除", cloud, fileId: entry.fileId });
        }
      }
    }

    for (const [relPath, local] of localFiles) {
      if (index.entries[relPath]) continue;
      const cloud = cloudFiles.get(relPath);
      if (!cloud) {
        actions.push({ kind: "upload", relativePath: relPath, reason: "本地新增文件", local });
      } else {
        actions.push({ kind: "conflict", relativePath: relPath, reason: "本地与云端均新增（无同步记录）", local, cloud });
      }
    }

    for (const [relPath, cloud] of cloudFiles) {
      if (index.entries[relPath] || localFiles.has(relPath)) continue;
      actions.push({ kind: "download", relativePath: relPath, reason: "云端新增文件", cloud });
    }

    return actions;
  }
}