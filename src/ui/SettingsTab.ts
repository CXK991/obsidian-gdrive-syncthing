/**
 * 设置面板：OAuth 配置、同步参数、状态展示与危险操作。
 */

import { App, ButtonComponent, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianGDriveSyncPlugin from "../main";
import { errorMessage } from "../utils";

export class GDriveSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ObsidianGDriveSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderTutorialSection(containerEl);
    this.renderOAuthSection(containerEl);
    this.renderSyncSection(containerEl);
    this.renderStatusSection(containerEl);
    this.renderDangerSection(containerEl);
  }

  // ---------- 获取凭据教程 ----------

  private renderTutorialSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "① 获取 Google Drive API 凭据（5 分钟教程）" });
    containerEl.createEl("p", {
      text: "本插件使用 OAuth 2.0 而非 API Key（API Key 无法安全地代表你的账号读写文件）。按以下步骤在 Google Cloud 创建凭据：",
      cls: "setting-item-description",
    });

    const list = containerEl.createEl("ol", { cls: "gdrive-sync-tutorial" });
    const addStep = (text: string, links?: Array<{ label: string; url: string }>): void => {
      const item = list.createEl("li", { text });
      for (const link of links ?? []) {
        item.createEl("a", { text: link.label, href: link.url, attr: { target: "_blank", rel: "noopener" } });
      }
    };

    addStep("创建或选择一个 Google Cloud 项目：", [
      { label: "新建项目", url: "https://console.cloud.google.com/projectcreate" },
    ]);
    addStep("启用 Google Drive API：", [
      { label: "启用 Drive API", url: "https://console.cloud.google.com/apis/library/drive.googleapis.com" },
    ]);
    addStep("配置 OAuth 同意屏幕（选择 External，并把你的 Google 账号添加为测试用户）：", [
      { label: "打开同意屏幕", url: "https://console.cloud.google.com/apis/credentials/consent" },
    ]);
    addStep("创建 OAuth 客户端 ID，应用类型选「Web 应用」，重定向 URI 填 http://localhost:8080/ ：", [
      { label: "创建凭据", url: "https://console.cloud.google.com/apis/credentials" },
    ]);
    addStep("把 Client ID / Client Secret 填到下方输入框，点「生成授权链接」→ 浏览器授权 → 「用授权码换取令牌」。");
    addStep("（备选）不想走浏览器授权码时，可用 OAuth Playground 直接获取 Refresh Token：点齿轮设置填入你的 Client ID/Secret，勾选 Drive API v3 的 https://www.googleapis.com/auth/drive.file，再依次点 Authorize 与 Exchange authorization code：", [
      { label: "打开 OAuth Playground", url: "https://developers.google.com/oauthplayground/" },
    ]);

    const docLine = containerEl.createEl("p", { text: "官方文档：", cls: "setting-item-description" });
    docLine.createEl("a", {
      text: "Google Drive API 文档",
      href: "https://developers.google.com/drive/api/guides/about-sdk",
      attr: { target: "_blank", rel: "noopener" },
    });
  }
  // ---------- OAuth ----------

  private renderOAuthSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "Google Drive OAuth 认证" });
    containerEl.createEl("p", {
      text: "在 Google Cloud Console 创建 OAuth 客户端（Web 应用类型）、启用 Google Drive API，并配置与下方 Redirect URI 一致的回调地址。详细步骤见上方教程。",
      cls: "setting-item-description",
    });

    new Setting(containerEl).setName("Client ID").setDesc("OAuth 客户端 ID。").addText((text) => {
      text
        .setPlaceholder("xxxx.apps.googleusercontent.com")
        .setValue(this.plugin.settings.clientId)
        .onChange(async (value) => {
          this.plugin.settings.clientId = value.trim();
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("Client Secret").setDesc("OAuth 客户端密钥。").addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("GOCSPX-…")
        .setValue(this.plugin.settings.clientSecret)
        .onChange(async (value) => {
          this.plugin.settings.clientSecret = value.trim();
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("Refresh Token").setDesc("长期有效的刷新令牌。可用下方授权流程自动获取，也可手动粘贴。").addText((text) => {
      text.inputEl.type = "password";
      text
        .setPlaceholder("1//0xxxx…")
        .setValue(this.plugin.settings.refreshToken)
        .onChange(async (value) => {
          this.plugin.settings.refreshToken = value.trim();
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("Redirect URI").setDesc("OAuth 回调地址，必须与 Google Cloud Console 中配置的一致。").addText((text) => {
      text
        .setPlaceholder("http://localhost:8080/")
        .setValue(this.plugin.settings.redirectUri)
        .onChange(async (value) => {
          this.plugin.settings.redirectUri = value.trim();
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl)
      .setName("授权流程")
      .setDesc("1. 生成授权链接并在浏览器中完成授权；2. 将跳转地址中 code= 后的参数粘贴进来换取令牌（首次授权会返回 Refresh Token）。")
      .addButton((button) => button.setButtonText("1️⃣ 生成授权链接").onClick(() => this.openAuthUrl()))
      .addButton((button) => button.setButtonText("2️⃣ 用授权码换取令牌").onClick(() => this.exchangeCodeFlow()));

    new Setting(containerEl).setName("测试连接").setDesc("使用当前凭据访问 Google Drive，验证配置是否正确。").addButton((button) =>
      button.setButtonText("测试连接").setCta().onClick(() => void this.testConnection(button)),
    );

    new Setting(containerEl).setName("清除令牌").setDesc("清除本地保存的 Access Token / Refresh Token（不影响云端数据）。").addButton((button) =>
      button.setButtonText("清除令牌").setWarning().onClick(() => this.clearTokens()),
    );
  }

  private openAuthUrl(): void {
    const settings = this.plugin.settings;
    if (!settings.clientId) {
      new Notice("请先填写 Client ID");
      return;
    }
    const url = this.plugin.getGDriveClient().createAuthUrl(`obsidian-${Date.now().toString(36)}`);
    window.open(url, "_blank", "noopener");
    new Notice("已打开 Google 授权页面。授权完成后浏览器会跳转到 Redirect URI，请复制地址中的 code 参数。");
  }

  private exchangeCodeFlow(): void {
    const settings = this.plugin.settings;
    if (!settings.clientId || !settings.clientSecret) {
      new Notice("请先填写 Client ID 与 Client Secret");
      return;
    }
    const modal = new AuthCodeModal(this.app, settings.redirectUri, async (code, redirectUri) => {
      try {
        const tokens = await this.plugin.getGDriveClient().exchangeCode(code, redirectUri);
        settings.accessToken = tokens.accessToken;
        settings.tokenExpiresAt = tokens.expiresAt;
        if (tokens.refreshToken) settings.refreshToken = tokens.refreshToken;
        await this.plugin.saveSettings();
        new Notice(
          tokens.refreshToken
            ? "✅ 授权成功：已保存 Access Token 与 Refresh Token"
            : "✅ 授权成功：已保存 Access Token（未返回 Refresh Token，请确认授权时勾选离线访问）",
          8000,
        );
      } catch (error) {
        new Notice(`❌ 换取令牌失败：${errorMessage(error)}`, 8000);
      }
    });
    modal.open();
  }

  private async testConnection(button: ButtonComponent): Promise<void> {
    button.setDisabled(true).setButtonText("连接中…");
    try {
      const info = await this.plugin.getGDriveClient().getUserInfo();
      new Notice(`✅ Google Drive 连接成功：${info.displayName}（${info.email}）`, 6000);
    } catch (error) {
      new Notice(`❌ 连接失败：${errorMessage(error)}`, 8000);
    } finally {
      button.setDisabled(false).setButtonText("测试连接");
    }
  }

  private clearTokens(): void {
    const settings = this.plugin.settings;
    settings.accessToken = "";
    settings.tokenExpiresAt = 0;
    settings.refreshToken = "";
    void this.plugin.saveSettings();
    new Notice("已清除本地令牌");
  }

  // ---------- 同步参数 ----------

  private renderSyncSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "同步设置" });

    new Setting(containerEl).setName("同步根目录名称").setDesc("Google Drive 中存放同步文件的专用文件夹；不存在时自动创建。").addText((text) => {
      text
        .setValue(this.plugin.settings.syncRootName)
        .onChange(async (value) => {
          this.plugin.settings.syncRootName = value.trim() || "Sync_Obsidian";
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("轮询间隔（秒）").setDesc("每隔多少秒自动检查一次云端变动（AI 端修改会在此间隔内被拉取）；0 表示禁用轮询。").addText((text) => {
      text
        .setPlaceholder("60")
        .setValue(String(this.plugin.settings.pollIntervalSec))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.pollIntervalSec = Number.isNaN(parsed) || parsed < 0 ? 60 : parsed;
          await this.plugin.saveSettings();
          this.plugin.getSyncEngine().startPolling();
        });
    });

    new Setting(containerEl).setName("启动时自动同步").setDesc("Obsidian 启动后自动执行一次同步。").addToggle((toggle) => {
      toggle
        .setValue(this.plugin.settings.syncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("本地监听防抖（毫秒）").setDesc("本地文件变动后延迟多久再触发同步，用于合并连续编辑、减少 API 请求。").addText((text) => {
      text
        .setPlaceholder("1000")
        .setValue(String(this.plugin.settings.debounceMs))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.debounceMs = Number.isNaN(parsed) || parsed < 100 ? 1000 : parsed;
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("排除路径").setDesc("不同步的文件夹或文件，每行一个（相对仓库根目录）。").addTextArea((text) => {
      text
        .setValue(this.plugin.settings.excludedPaths.join("\n"))
        .onChange(async (value) => {
          this.plugin.settings.excludedPaths = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          await this.plugin.saveSettings();
        });
    });

    new Setting(containerEl).setName("云端删除进回收站").setDesc("云端文件被删除时移入 Google Drive 回收站（可恢复），而非永久删除。").addToggle((toggle) => {
      toggle
        .setValue(this.plugin.settings.useTrashForDeletes)
        .onChange(async (value) => {
          this.plugin.settings.useTrashForDeletes = value;
          await this.plugin.saveSettings();
        });
    });
  }

  // ---------- 状态 ----------

  private renderStatusSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "同步状态" });
    const settings = this.plugin.settings;
    const lastTime = settings.lastSyncAt > 0 ? new Date(settings.lastSyncAt).toLocaleString() : "从未同步";
    new Setting(containerEl)
      .setName("上次同步")
      .setDesc(`时间：${lastTime}；结果：${settings.lastSyncStatus || "—"}`)
      .addButton((button) =>
        button.setButtonText("立即同步").setCta().onClick(() => {
          this.plugin.getSyncEngine().scheduleSync("设置面板手动触发", 0);
        }),
      );
  }

  // ---------- 危险操作 ----------

  private renderDangerSection(containerEl: HTMLElement): void {
    containerEl.createEl("h2", { text: "高级" });
    new Setting(containerEl)
      .setName("重置同步索引")
      .setDesc("删除本地索引文件，下次同步将重新全量比对（不会删除任何本地或云端文件）。")
      .addButton((button) =>
        button.setButtonText("重置索引").setWarning().onClick(() => {
          const modal = new ConfirmModal(this.app, "重置同步索引", "确定要删除本地同步索引吗？下次同步将进行全量比对。", () => {
            void this.plugin.getSyncEngine().resetIndex();
          });
          modal.open();
        }),
      );
  }
}

/** 输入授权码的模态框 */
class AuthCodeModal extends Modal {
  constructor(
    app: App,
    private readonly defaultRedirectUri: string,
    private readonly onSubmit: (code: string, redirectUri: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("输入 Google 授权码");
    const container = this.contentEl;
    container.createEl("p", {
      text: "粘贴授权跳转 URL 中 code 参数的值（URL 形如 http://localhost:8080/?code=…&scope=…）。",
    });
    const codeEl = container.createEl("textarea", { attr: { rows: "4", placeholder: "授权码…" } }) as HTMLTextAreaElement;
    const redirectEl = container.createEl("input", { attr: { type: "text", placeholder: "Redirect URI" } }) as HTMLInputElement;
    redirectEl.value = this.defaultRedirectUri;
    new ButtonComponent(container)
      .setButtonText("换取令牌")
      .setCta()
      .onClick(() => {
        const code = codeEl.value.trim();
        if (!code) {
          new Notice("请先粘贴授权码");
          return;
        }
        this.onSubmit(code, redirectEl.value.trim());
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 通用确认模态框 */
class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.contentEl.createEl("p", { text: this.message });
    new ButtonComponent(this.contentEl)
      .setButtonText("确认")
      .setWarning()
      .onClick(() => {
        this.onConfirm();
        this.close();
      });
    new ButtonComponent(this.contentEl).setButtonText("取消").onClick(() => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}