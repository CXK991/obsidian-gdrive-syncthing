/**
 * Syncthing 风格冲突处理：
 * 生成 "Filename.sync-conflict-YYYYMMDD-HHMMSS-xxxx.md" 冲突副本。
 */

import { App } from "obsidian";
import { dirname, formatConflictTimestamp } from "../utils";

export class ConflictResolver {
  constructor(private readonly app: App) {}

  /** 生成冲突副本路径（含随机后缀避免重名） */
  buildConflictPath(originalPath: string): string {
    const dir = dirname(originalPath);
    const baseName = originalPath.slice(dir ? dir.length + 1 : 0);
    const dot = baseName.lastIndexOf(".");
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot) : "";
    const timestamp = formatConflictTimestamp(new Date());
    const random = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    return `${dir ? dir + "/" : ""}${stem}.sync-conflict-${timestamp}-${random}${ext}`;
  }

  /** 冲突副本已存在时追加 -1、-2… 序号，保证路径唯一 */
  async ensureUniquePath(path: string): Promise<string> {
    const adapter = this.app.vault.adapter;
    let candidate = path;
    let suffix = 1;
    while (await adapter.exists(candidate)) {
      const dot = path.lastIndexOf(".");
      const stem = dot > 0 ? path.slice(0, dot) : path;
      const ext = dot > 0 ? path.slice(dot) : "";
      candidate = `${stem}-${suffix}${ext}`;
      suffix++;
    }
    return candidate;
  }

  /** 将云端内容写入本地冲突副本，返回副本路径 */
  async createConflictFile(originalPath: string, cloudData: ArrayBuffer): Promise<string> {
    const conflictPath = await this.ensureUniquePath(this.buildConflictPath(originalPath));
    const adapter = this.app.vault.adapter;
    const dir = dirname(conflictPath);
    if (dir) {
      try {
        await adapter.mkdir(dir);
      } catch {
        // 目录已存在，忽略
      }
    }
    await adapter.writeBinary(conflictPath, cloudData);
    return conflictPath;
  }
}