import {
  BrowserView,
  HeadersReceivedResponse,
  OnHeadersReceivedListenerDetails,
  session,
} from "electron";
import {
  BrowserWindowService,
  LoggerService,
  MainWindowService,
  WebviewService,
} from "../interfaces";
import { inject, injectable } from "inversify";
import { TYPES } from "../types";
import isDev from "electron-is-dev";
import { PERSIST_WEBVIEW } from "helper/variables";
import { LinkMessage } from "main";

@injectable()
export default class WebviewServiceImpl implements WebviewService {
  private readonly filter = { urls: ["*://*/*"] };
  private readonly view: BrowserView;
  webContents: Electron.WebContents;

  constructor(
    @inject(TYPES.MainWindowService)
    private readonly mainWindow: MainWindowService,
    @inject(TYPES.LoggerService)
    private readonly logger: LoggerService,
    @inject(TYPES.BrowserWindowService)
    private readonly browserWindow: BrowserWindowService
  ) {
    const view = new BrowserView({
      webPreferences: {
        partition: PERSIST_WEBVIEW,
      },
    });
    this.view = view;
    this.webContents = this.view.webContents;
    this.webContents.setAudioMuted(true);

    this.onHeadersReceived = this.onHeadersReceived.bind(this);
  }

  async onHeadersReceived(
    details: OnHeadersReceivedListenerDetails,
    callback: (headersReceivedResponse: HeadersReceivedResponse) => void
  ): Promise<void> {
    const { url } = details;

    const sourceReg = /\.m3u8$/;
    const detailsUrl = new URL(url);

    if (sourceReg.test(detailsUrl.pathname)) {
      this.logger.info("在窗口中捕获 m3u8 链接: ", detailsUrl.toString());
      const webContents = details.webContents;
      const linkMessage: LinkMessage = {
        url: detailsUrl.toString(),
        title: webContents?.getTitle() || "没有获取到名称",
      };
      this.curWindow.webContents.send("webview-link-message", linkMessage);
    }
    callback({});
  }

  async init(): Promise<void> {
    isDev && this.view.webContents.openDevTools();

    this.view.webContents.on("dom-ready", () => {
      const title = this.view.webContents.getTitle();
      const url = this.view.webContents.getURL();

      this.curWindow.webContents.send("webview-dom-ready", { title, url });

      this.view.webContents.setWindowOpenHandler((details) => {
        void this.view.webContents.loadURL(details.url);
        return { action: "deny" };
      });
    });

    session
      .fromPartition(PERSIST_WEBVIEW)
      .webRequest.onHeadersReceived(this.filter, this.onHeadersReceived);
  }

  getBounds(): Electron.Rectangle {
    return this.view.getBounds();
  }

  setAutoResize(options: Electron.AutoResizeOptions): void {
    this.view.setAutoResize(options);
  }

  setBackgroundColor(color: string): void {
    this.view.setBackgroundColor(color);
  }

  show() {
    this.curWindow.setBrowserView(this.view);
  }

  hide() {
    this.curWindow.setBrowserView(null);
  }

  setBounds(bounds: Electron.Rectangle): void {
    if (process.platform === "darwin") {
      bounds.y = bounds.y + 30;
    }
    this.view.setBounds(bounds);
  }

  async loadURL(url?: string) {
    const canGoBack = this.webContents.canGoBack();
    await this.webContents.loadURL(url || "");
    if (!canGoBack) {
      this.webContents.clearHistory();
    }
  }

  async goBack() {
    if (this.webContents.canGoBack()) {
      this.webContents.goBack();
      return true;
    } else {
      return false;
    }
  }

  async reload() {
    this.webContents.reload();
  }

  async goHome() {
    this.webContents.clearHistory();
  }

  get curWindow() {
    if (this.browserWindow.isVisible()) {
      return this.browserWindow;
    }
    return this.mainWindow;
  }
}