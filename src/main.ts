/**
 * 插件主入口：生命周期、命令/状态栏与各模块装配。
 *
 * 手机端没有底部状态栏，改用常驻弹窗（Notice）实时显示同步进度；
 * 桌面端保持底部状态栏进度，同步完成时弹窗汇总。
 */

import { Notice, Platform, Plugin } from "obsidian";
import { GDriveClient } from "./gdrive/GDriveClient";
import { ConflictResolver } from "./sync/ConflictResolver";
import { IndexManager } from "./sync/IndexManager";
import { SyncContext, SyncEngine } from "./sync/SyncEngine";
import { DEFAULT_SETTINGS, GDriveSyncSettings, SyncStatus } from "./types";
import { GDriveSyncSettingTab } from "./ui/SettingsTab";

export default class ObsidianGDriveSyncPlugin extends Plugin {
  settings!: GDriveSyncSettings;
  private client!: GDriveClient;
  private indexManager!: IndexManager;
  private conflictResolver!: ConflictResolver;
  private syncEngine!: SyncEngine;
  private statusBarEl!: HTMLElement;
  /** 手机端进度弹窗（常驻，同步期间持续更新文本） */
  private progressNotice: Notice | null = null;
  private lastProgressNoticeAt = 0;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusBarEl = this.addStatusBarItem();

    this.client = new GDriveClient(this.settings, () => this.saveSettings(), (message) => this.log(message));
    this.indexManager = new IndexManager(this.app, () => this.settings);
    this.conflictResolver = new ConflictResolver(this.app);

    const context: SyncContext = {
      app: this.app,
      settings: this.settings,
      saveSettings: () => this.saveSettings(),
      log: (message) => this.log(message),
      notice: (message, timeout) => new Notice(message, timeout),
      setStatus: (status) => this.updateStatusBar(status),
      progress: (text) => {
        if (text) {
          this.statusBarEl.setText(`GDrive：${text}`);
          this.showProgressNotice(text);
        } else {
          this.hideProgressNotice();
          this.updateStatusBar(this.settings.accessToken ? "idle" : "needs-auth");
        }
      },
    };
    this.syncEngine = new SyncEngine(context, this.client, this.indexManager, this.conflictResolver);

    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "GDrive 同步：立即同步", () => {
      this.showStartNotice();
      this.syncEngine.scheduleSync("点击功能区按钮", 0);
    });
    this.addCommand({
      id: "gdrive-sync-now",
      name: "立即同步到 Google Drive",
      callback: () => {
        this.showStartNotice();
        this.syncEngine.scheduleSync("执行命令", 0);
      },
    });
    this.addCommand({
      id: "gdrive-sync-toggle-pause",
      name: "暂停 / 恢复 GDrive 同步",
      callback: () => {
        this.syncEngine.togglePause();
      },
    });

    this.syncEngine.registerVaultEvents();
    this.syncEngine.startPolling();
    this.updateStatusBar(this.settings.accessToken ? "idle" : "needs-auth");

    if (this.settings.syncOnStartup) {
      this.syncEngine.scheduleSync("应用启动", 3000);
    }
  }

  onunload(): void {
    this.hideProgressNotice();
    this.syncEngine?.dispose();
  }

  getGDriveClient(): GDriveClient {
    return this.client;
  }

  getSyncEngine(): SyncEngine {
    return this.syncEngine;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  log(message: string): void {
    console.log(`[gdrive-syncthing] ${message}`);
  }

  private updateStatusBar(status: SyncStatus): void {
    const labels: Record<SyncStatus, string> = {
      idle: "空闲",
      syncing: "同步中…",
      paused: "已暂停",
      error: "出错",
      "needs-auth": "未授权",
    };
    const last = this.settings.lastSyncAt > 0 ? new Date(this.settings.lastSyncAt).toLocaleTimeString() : "从未";
    this.statusBarEl.setText(`GDrive：${labels[status]}｜上次 ${last}`);
  }

  /** 手机端没有状态栏：用常驻弹窗显示进度（800ms 节流，避免弹窗刷屏） */
  private showProgressNotice(text: string): void {
    if (!Platform.isMobile) return;
    const now = Date.now();
    if (now - this.lastProgressNoticeAt < 800) return;
    this.lastProgressNoticeAt = now;
    this.hideProgressNotice();
    this.progressNotice = new Notice(`GDrive 同步中：${text}`, 0);
  }

  private hideProgressNotice(): void {
    if (this.progressNotice) {
      try {
        this.progressNotice.hide();
      } catch {
        // 弹窗可能已被手动关闭，忽略即可
      }
      this.progressNotice = null;
    }
  }

  private showStartNotice(): void {
    new Notice(Platform.isMobile ? "已开始 GDrive 同步，进度将在弹窗中实时显示" : "已开始 GDrive 同步，请在底部状态栏查看进度");
  }
}