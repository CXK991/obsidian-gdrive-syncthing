/**
 * 双向同步主引擎。
 *
 * - 监听本地 vault 事件（modify/create/delete/rename），带防抖；
 * - 支持启动同步、定时轮询、手动触发；
 * - 单实例互斥执行 + 排队重跑，避免并发写索引；
 * - 所有本地读写统一走 this.app.vault.adapter，移动端无缝兼容。
 */

import { App, EventRef, TAbstractFile, TFile } from "obsidian";
import type { UploadedFileInfo } from "../gdrive/GDriveClient";
import { GDriveClient } from "../gdrive/GDriveClient";
import type { GDriveSyncSettings, IndexEntry, SyncAction, SyncIndex, SyncResult, SyncStatus } from "../types";
import { basename, dirname, errorMessage, mimeForName } from "../utils";
import { ConflictResolver } from "./ConflictResolver";
import { INDEX_PATH, IndexManager } from "./IndexManager";

export interface SyncContext {
  app: App;
  settings: GDriveSyncSettings;
  saveSettings(): Promise<void>;
  log(message: string): void;
  notice(message: string, timeout?: number): void;
  setStatus(status: SyncStatus): void;
  /** 实时进度反馈（状态栏等） */
  progress(text: string): void;
}

export class SyncEngine {
  private readonly eventRefs: EventRef[] = [];
  private debounceTimer: number | null = null;
  private pollTimer: number | null = null;
  private syncInProgress = false;
  private pendingRun = false;
  private paused = false;
  private disposed = false;

  constructor(
    private readonly context: SyncContext,
    private readonly client: GDriveClient,
    private readonly indexManager: IndexManager,
    private readonly conflictResolver: ConflictResolver,
  ) {}

  /** 注册本地 Vault 事件监听（modify/create/delete/rename），带防抖 */
  registerVaultEvents(): void {
    const vault = this.context.app.vault;
    const handler = (file: TAbstractFile, oldPath?: string): void => {
      if (this.disposed || this.paused) return;
      const changedPath = oldPath ?? file.path;
      if (changedPath === INDEX_PATH || changedPath.startsWith(".obsidian/")) return;
      this.scheduleSync("本地变动", this.context.settings.debounceMs);
    };
    this.eventRefs.push(vault.on("modify", (file) => handler(file)));
    this.eventRefs.push(vault.on("create", (file) => handler(file)));
    this.eventRefs.push(vault.on("delete", (file) => handler(file)));
    this.eventRefs.push(vault.on("rename", (file, oldPath) => handler(file, oldPath)));
  }

  /** 防抖调度一次同步 */
  scheduleSync(reason: string, delayMs = this.context.settings.debounceMs): void {
    if (this.disposed) return;
    if (this.paused) {
      this.context.notice("GDrive 同步已暂停，请先执行命令「暂停 / 恢复 GDrive 同步」恢复后再试", 5000);
      return;
    }
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSync(reason);
    }, Math.max(0, delayMs));
  }

  /** 启动云端轮询（间隔可配置，0 表示禁用） */
  startPolling(): void {
    this.stopPolling();
    const seconds = this.context.settings.pollIntervalSec;
    if (!seconds || seconds <= 0) return;
    this.pollTimer = window.setInterval(() => {
      this.scheduleSync("定时轮询", 0);
    }, seconds * 1000);
  }

  stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  togglePause(): boolean {
    this.paused = !this.paused;
    if (this.paused) {
      if (this.debounceTimer !== null) {
        window.clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.context.setStatus("paused");
      this.context.notice("GDrive 同步已暂停");
    } else {
      this.context.setStatus("idle");
      this.context.notice("GDrive 同步已恢复");
      this.scheduleSync("恢复同步", 300);
    }
    return this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 清除本地索引，下次同步全量比对（不删除任何文件） */
  async resetIndex(): Promise<void> {
    const adapter = this.context.app.vault.adapter;
    try {
      if (await adapter.exists(INDEX_PATH)) await adapter.remove(INDEX_PATH);
    } catch (error) {
      this.context.log(`清除索引失败：${errorMessage(error)}`);
    }
    this.context.settings.syncRootFolderId = "";
    await this.context.saveSettings();
    this.context.notice("同步索引已清除，下次同步将进行全量比对", 5000);
    this.scheduleSync("索引重置", 300);
  }

  /** 执行一轮完整双向同步 */
  async runSync(reason: string): Promise<void> {
    if (this.disposed || this.paused) return;
    if (this.syncInProgress) {
      this.pendingRun = true;
      return;
    }
    this.syncInProgress = true;
    const ctx = this.context;
    const startedAt = Date.now();
    let failed = false;
    const result: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedCloud: 0, conflicts: 0, skipped: 0, errors: 0 };
    try {
      ctx.setStatus("syncing");
      ctx.progress("同步中… 正在连接 Google Drive");
      ctx.log(`开始同步（原因：${reason}）`);

      await this.client.ensureAccessToken();
      ctx.progress("同步中… 准备云端同步目录");
      const rootFolderId = await this.client.ensureRootFolder(ctx.settings.syncRootName);
      if (ctx.settings.syncRootFolderId !== rootFolderId) {
        ctx.settings.syncRootFolderId = rootFolderId;
        await ctx.saveSettings();
      }

      const index = await this.indexManager.loadIndex();
      index.rootFolderId = rootFolderId;
      const localFiles = await this.indexManager.scanLocalFiles();
      const cloud = await this.client.listFilesRecursive(rootFolderId, (path) => this.indexManager.isExcluded(path));
      const cloudByPath = new Map(cloud.files.map((file) => [file.relPath, file]));
      const folderIds = cloud.folders;
      const actions = this.indexManager.buildPlan(index, localFiles, cloudByPath);
      const errors: string[] = [];
      const totalActions = actions.length;
      ctx.progress(`同步中… 共 ${totalActions} 项操作`);

      for (let i = 0; i < actions.length; i++) {
        const action = actions[i];
        if (this.disposed || this.paused) break;
        try {
          ctx.progress(`同步中… [${i + 1}/${totalActions}] ${this.actionLabel(action)}`);
          await this.executeAction(index, action, folderIds, result);
        } catch (error) {
          result.errors++;
          errors.push(`${action.relativePath}：${errorMessage(error)}`);
          ctx.log(`操作失败 [${action.kind}] ${action.relativePath}：${errorMessage(error)}`);
        }
      }

      // 清理两侧都不存在的索引条目
      for (const relPath of Object.keys(index.entries)) {
        if (!localFiles.has(relPath) && !cloudByPath.has(relPath)) delete index.entries[relPath];
      }
      await this.indexManager.saveIndex(index);

      ctx.settings.lastSyncAt = Date.now();
      ctx.settings.lastSyncStatus = result.errors > 0 ? `完成，但有 ${result.errors} 个错误` : "成功";
      await ctx.saveSettings();

      const total = result.uploaded + result.downloaded + result.deletedLocal + result.deletedCloud + result.conflicts + result.skipped;
      if (total > 0 || result.errors > 0) {
        ctx.notice(
          `GDrive 同步完成：上传 ${result.uploaded}，下载 ${result.downloaded}，删除 ${result.deletedLocal + result.deletedCloud}，冲突 ${result.conflicts}，跳过 ${result.skipped}${result.errors > 0 ? `，错误 ${result.errors}` : ""}`,
          6000,
        );
      } else {
        ctx.notice("GDrive 同步完成：没有检测到需要同步的变动", 5000);
      }
      if (errors.length > 0) ctx.log(`本次同步错误明细：\n${errors.join("\n")}`);
      ctx.log(`同步结束：${result.uploaded} 上传 / ${result.downloaded} 下载 / ${result.conflicts} 冲突，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
    } catch (error) {
      failed = true;
      const message = errorMessage(error);
      const needsAuth = Boolean((error as { needsAuth?: boolean })?.needsAuth);
      ctx.setStatus(needsAuth ? "needs-auth" : "error");
      ctx.log(`同步失败：${message}`);
      ctx.notice(`GDrive 同步失败：${message}`, 8000);
    } finally {
      this.syncInProgress = false;
      if (!this.disposed) ctx.progress("");
      if (!this.disposed) {
        if (!failed) ctx.setStatus(this.paused ? "paused" : "idle");
        if (this.pendingRun && !this.paused) {
          this.pendingRun = false;
          this.scheduleSync("排队任务", 200);
        }
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const ref of this.eventRefs) this.context.app.vault.offref(ref);
    this.eventRefs.length = 0;
    this.stopPolling();
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /** 动作的简短中文标签（用于进度显示） */
  private actionLabel(action: SyncAction): string {
    switch (action.kind) {
      case "upload":
        return `上传 ${action.relativePath}`;
      case "download":
        return `下载 ${action.relativePath}`;
      case "deleteLocal":
        return `删除本地 ${action.relativePath}`;
      case "deleteCloud":
        return `删除云端 ${action.relativePath}`;
      case "conflict":
        return `处理冲突 ${action.relativePath}`;
      default:
        return action.relativePath;
    }
  }

  // ---------- 私有执行逻辑 ----------

  private async executeAction(index: SyncIndex, action: SyncAction, folderIds: Map<string, string>, result: SyncResult): Promise<void> {
    switch (action.kind) {
      case "upload": {
        const entry = index.entries[action.relativePath];
        if (!action.variant && entry && entry.localHash) {
          // 防抖校验：mtime 变了但内容没变（如 touch），仅更新索引，节省上传流量
          const currentHash = await this.indexManager.hashFile(action.relativePath);
          if (currentHash && currentHash === entry.localHash) {
            entry.localMtime = action.local?.mtime ?? entry.localMtime;
            entry.localSize = action.local?.size ?? entry.localSize;
            result.skipped++;
            return;
          }
        }
        await this.handleUpload(index, action, folderIds, action.variant === "recoverUpload");
        if (action.variant === "recoverUpload") {
          result.conflicts++;
          this.context.notice(`检测到删除冲突：「${action.relativePath}」。云端已删除但本地已修改，已重新上传本地版本`, 8000);
        } else {
          result.uploaded++;
        }
        return;
      }
      case "download": {
        const entry = index.entries[action.relativePath];
        if (!action.variant && entry && entry.cloudMd5 && action.cloud?.md5Checksum && entry.cloudMd5 === action.cloud.md5Checksum) {
          // 云端时间戳变了但内容没变，仅更新索引，节省下载流量
          entry.cloudModifiedTime = action.cloud.modifiedTimeMs;
          result.skipped++;
          return;
        }
        await this.handleDownload(index, action);
        if (action.variant === "recoverDownload") {
          result.conflicts++;
          this.context.notice(`检测到删除冲突：「${action.relativePath}」。本地已删除但云端已修改，已恢复下载云端版本`, 8000);
        } else {
          result.downloaded++;
        }
        return;
      }
      case "deleteLocal":
        await this.handleDeleteLocal(index, action);
        result.deletedLocal++;
        return;
      case "deleteCloud":
        await this.handleDeleteCloud(index, action);
        result.deletedCloud++;
        return;
      case "conflict":
        await this.handleConflict(index, action, folderIds);
        result.conflicts++;
        return;
    }
  }

  private async handleUpload(index: SyncIndex, action: SyncAction, folderIds: Map<string, string>, recreate = false): Promise<void> {
    const relPath = action.relativePath;
    const local = action.local;
    if (!local) throw new Error("缺少本地文件信息，无法上传");
    const entry = index.entries[relPath];
    const parentId = await this.ensureCloudFolder(dirname(relPath), folderIds);
    const data = await this.context.app.vault.adapter.readBinary(relPath);
    const localHash = await this.indexManager.hashBuffer(data);
    const uploaded = await this.client.uploadFile({
      parentId,
      name: basename(relPath),
      mimeType: mimeForName(relPath),
      data,
      // recreate（删除冲突恢复）时云端文件已不存在，必须以新建方式上传
      fileId: recreate ? undefined : entry?.fileId,
    });
    index.entries[relPath] = this.buildIndexEntry(relPath, local.mtime, local.size, localHash, uploaded);
    this.context.log(`已上传：${relPath} → ${uploaded.id}`);
  }

  private async handleDownload(index: SyncIndex, action: SyncAction): Promise<void> {
    const relPath = action.relativePath;
    const cloud = action.cloud;
    if (!cloud) throw new Error("缺少云端文件信息，无法下载");
    const adapter = this.context.app.vault.adapter;
    const data = await this.client.downloadFile(cloud.id);
    const dir = dirname(relPath);
    if (dir) {
      try {
        await adapter.mkdir(dir);
      } catch {
        // 目录已存在，忽略
      }
    }
    await adapter.writeBinary(relPath, data);
    const stat = await adapter.stat(relPath);
    const localHash = await this.indexManager.hashBuffer(data);
    index.entries[relPath] = this.buildIndexEntry(relPath, stat?.mtime ?? Date.now(), stat?.size ?? data.byteLength, localHash, {
      id: cloud.id,
      name: cloud.name,
      modifiedTimeMs: cloud.modifiedTimeMs,
      md5Checksum: cloud.md5Checksum,
      size: cloud.size,
    });
    this.context.log(`已下载：${cloud.id} → ${relPath}`);
  }

  private async handleDeleteLocal(index: SyncIndex, action: SyncAction): Promise<void> {
    const relPath = action.relativePath;
    const adapter = this.context.app.vault.adapter;
    const abstractFile = this.context.app.vault.getAbstractFileByPath(relPath);
    let removed = false;
    if (abstractFile instanceof TFile) {
      const vault = this.context.app.vault as App["vault"] & { trash?: (file: TFile, system?: boolean) => Promise<void> };
      if (typeof vault.trash === "function") {
        try {
          await vault.trash(abstractFile, true);
          removed = true;
        } catch {
          removed = false;
        }
      }
    }
    if (!removed && (await adapter.exists(relPath))) {
      await adapter.remove(relPath);
    }
    delete index.entries[relPath];
    this.context.log(`本地删除（云端已删除）：${relPath}`);
  }

  private async handleDeleteCloud(index: SyncIndex, action: SyncAction): Promise<void> {
    const fileId = action.fileId ?? action.cloud?.id;
    if (!fileId) throw new Error("缺少云端文件 ID，无法删除");
    if (this.context.settings.useTrashForDeletes) {
      await this.client.trashFile(fileId);
    } else {
      await this.client.deleteFile(fileId);
    }
    delete index.entries[action.relativePath];
    this.context.log(`云端删除（本地已删除）：${action.relativePath}`);
  }

  /**
   * 双向同时修改（或双新增且内容不同）的冲突处理（Syncthing 风格）：
   * 1. 保留本地文件原名与内容；
   * 2. 下载云端版本，保存为 "原名.sync-conflict-YYYYMMDD-HHMMSS-xxxx.md"；
   * 3. 把冲突副本上传到云端（两端都能看到）；
   * 4. 以本地版本覆盖云端原文件，双方收敛为同一版本；
   * 5. 更新索引，保证下次同步不再重复触发冲突。
   */
  private async handleConflict(index: SyncIndex, action: SyncAction, folderIds: Map<string, string>): Promise<void> {
    const relPath = action.relativePath;
    const entry = index.entries[relPath];
    const cloud = action.cloud;
    const local = action.local;
    if (!cloud) throw new Error("缺少云端文件信息，无法处理冲突");
    if (!local) throw new Error("缺少本地文件信息，无法处理冲突");
    const adapter = this.context.app.vault.adapter;
    const ctx = this.context;

    // 双新增且内容一致：无需冲突副本，仅建立索引
    if (!entry) {
      const cloudData = await this.client.downloadFile(cloud.id);
      const localHash = await this.indexManager.hashFile(relPath);
      const cloudHash = await this.indexManager.hashBuffer(cloudData);
      if (localHash && cloudHash && localHash === cloudHash) {
        index.entries[relPath] = this.buildIndexEntry(relPath, local.mtime, local.size, localHash, {
          id: cloud.id,
          name: cloud.name,
          modifiedTimeMs: cloud.modifiedTimeMs,
          md5Checksum: cloud.md5Checksum,
          size: cloud.size,
        });
        ctx.log(`文件「${relPath}」本地与云端内容一致，仅建立索引`);
        return;
      }
    }

    // 1) 下载云端版本 → 写入本地冲突副本
    const cloudData = await this.client.downloadFile(cloud.id);
    const conflictPath = await this.conflictResolver.createConflictFile(relPath, cloudData);
    // 2) 冲突副本上传到云端（与云端原文件同目录，保证两端可见）
    const conflictParentId = await this.ensureCloudFolder(dirname(conflictPath), folderIds);
    const uploadedConflict = await this.client.uploadFile({
      parentId: conflictParentId,
      name: basename(conflictPath),
      mimeType: mimeForName(conflictPath),
      data: cloudData,
    });
    // 3) 以本地版本为准：覆盖云端原文件（云端版本已由冲突副本完整保留）
    const localData = await adapter.readBinary(relPath);
    const localHash = await this.indexManager.hashBuffer(localData);
    const uploaded = await this.client.uploadFile({
      parentId: cloud.parents[0] ?? ctx.settings.syncRootFolderId,
      name: cloud.name,
      mimeType: cloud.mimeType || mimeForName(relPath),
      data: localData,
      fileId: cloud.id,
    });
    // 4) 更新索引：原文件 + 冲突副本
    const conflictStat = await adapter.stat(conflictPath);
    index.entries[conflictPath] = this.buildIndexEntry(
      conflictPath,
      conflictStat?.mtime ?? Date.now(),
      conflictStat?.size ?? cloudData.byteLength,
      await this.indexManager.hashBuffer(cloudData),
      uploadedConflict,
    );
    index.entries[relPath] = this.buildIndexEntry(relPath, local.mtime, local.size, localHash, uploaded);
    ctx.notice(`检测到文件冲突：「${relPath}」。已保留本地版本，云端版本保存为「${conflictPath}」`, 8000);
  }

  /** 确保云端目录链存在并返回目录 ID（缺失时逐级创建） */
  private async ensureCloudFolder(relDir: string, folderIds: Map<string, string>): Promise<string> {
    if (!relDir) return this.context.settings.syncRootFolderId;
    const cached = folderIds.get(relDir);
    if (cached) return cached;
    const segments = relDir.split("/");
    let parentId = this.context.settings.syncRootFolderId;
    let prefix = "";
    for (const segment of segments) {
      if (!segment) continue;
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const existing = folderIds.get(prefix);
      if (existing) {
        parentId = existing;
      } else {
        parentId = await this.client.createFolder(segment, parentId);
        folderIds.set(prefix, parentId);
        this.context.log(`已创建云端目录：${prefix}`);
      }
    }
    return parentId;
  }

  private buildIndexEntry(
    relativePath: string,
    localMtime: number,
    localSize: number,
    localHash: string | null,
    uploaded: UploadedFileInfo,
  ): IndexEntry {
    return {
      relativePath,
      localMtime,
      localSize,
      localHash,
      fileId: uploaded.id,
      cloudModifiedTime: uploaded.modifiedTimeMs,
      cloudMd5: uploaded.md5Checksum,
      cloudSize: uploaded.size,
    };
  }
}