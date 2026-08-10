/**
 * 插件主入口：生命周期、菜单/命令/状态栏与各模块装配。
 */

import { Notice, Plugin } from "obsidian";
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
        } else {
          this.updateStatusBar(this.settings.accessToken ? "idle" : "needs-auth");
        }
      },
    };
    this.syncEngine = new SyncEngine(context, this.client, this.indexManager, this.conflictResolver);

    this.addSettingTab(new GDriveSyncSettingTab(this.app, this));
    this.addRibbonIcon("refresh-cw", "GDrive 同步：立即同步", () => {
      this.syncEngine.scheduleSync("点击功能区按钮", 0);
    });
    this.addCommand({
      id: "gdrive-sync-now",
      name: "立即同步到 Google Drive",
      callback: () => this.syncEngine.scheduleSync("执行命令", 0),
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
}