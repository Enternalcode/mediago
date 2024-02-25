import EventEmitter from "events";
import { inject, injectable } from "inversify";
import {
  DownloadParams,
  DownloadProgress,
  DownloadStatus,
  Task,
} from "../interfaces";
import { TYPES } from "../types";
import ElectronLogger from "../vendor/ElectronLogger";
import ElectronStore from "../vendor/ElectronStore";
import VideoRepository from "../repository/VideoRepository";
import { biliDownloaderBin, m3u8DownloaderBin, stripColors } from "../helper";
import * as pty from "node-pty";
import stripAnsi from "strip-ansi";

export interface DownloadOptions {
  abortSignal: AbortController;
  encoding?: string;
  onMessage?: (message: string) => void;
}

@injectable()
export default class DownloadService extends EventEmitter {
  private queue: Task[] = [];

  private active: Task[] = [];

  private limit: number;

  private signal: Record<number, AbortController> = {};

  constructor(
    @inject(TYPES.ElectronLogger)
    private readonly logger: ElectronLogger,
    @inject(TYPES.VideoRepository)
    private readonly videoRepository: VideoRepository,
    @inject(TYPES.ElectronStore)
    private readonly storeService: ElectronStore,
  ) {
    super();

    const maxRunner = this.storeService.get("maxRunner");
    this.limit = maxRunner;

    this.storeService.onDidChange("maxRunner", (maxRunner) => {
      maxRunner && (this.limit = maxRunner);
    });
  }

  async addTask(task: Task) {
    this.queue.push(task);
    this.runTask();
  }

  async stopTask(id: number) {
    if (this.signal[id]) {
      this.logger.info(`taskId: ${id} stop`);
      this.signal[id].abort();
    }
  }

  async execute(task: Task) {
    try {
      await this.videoRepository.changeVideoStatus(
        task.id,
        DownloadStatus.Downloading,
      );
      this.emit("download-start", task.id);

      this.logger.info(`taskId: ${task.id} start`);
      const controller = new AbortController();
      this.signal[task.id] = controller;

      const callback = (progress: DownloadProgress) => {
        if (progress.type === "progress") {
          this.emit("download-progress", progress);
        } else if (progress.type === "ready") {
          this.emit("download-ready-start", progress);
          if (progress.isLive) {
            this.removeTask(progress.id);
          }
        }
      };

      const params: DownloadParams = {
        ...task.params,
        id: task.id,
        abortSignal: controller,
        callback,
      };

      const { proxy, useProxy } = this.storeService.store;
      if (useProxy) {
        params.proxy = proxy;
      }

      await this.process(params);
      delete this.signal[task.id];
      this.logger.info(`taskId: ${task.id} success`);

      await this.videoRepository.changeVideoStatus(
        task.id,
        DownloadStatus.Success,
      );
      this.emit("download-success", task.id);
    } catch (err: any) {
      this.logger.info(`taskId: ${task.id} failed`);
      if (err.message === "AbortError") {
        // 下载暂停
        await this.videoRepository.changeVideoStatus(
          task.id,
          DownloadStatus.Stopped,
        );
        this.emit("download-stop", task.id);
      } else {
        // 下载失败
        await this.videoRepository.changeVideoStatus(
          task.id,
          DownloadStatus.Failed,
        );
        this.emit("download-failed", task.id, err);
      }
    } finally {
      this.removeTask(task.id);

      // 传输完成
      if (this.queue.length === 0 && this.active.length === 0) {
        // this.emit("download-finish");
      }
    }
  }

  removeTask(id: number) {
    // 处理当前正在活动的任务
    const doneId = this.active.findIndex((i) => i.id === id);
    this.active.splice(doneId, 1);
    // 处理完成的任务
    if (this.active.length < this.limit) {
      this.runTask();
    }
  }

  runTask() {
    while (this.active.length < this.limit && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        this.active.push(task);
        this.execute(task);
      }
    }
  }

  private _execa(
    binPath: string,
    args: string[],
    params: DownloadOptions,
  ): Promise<void> {
    const { abortSignal, onMessage } = params;

    return new Promise((resolve, reject) => {
      const ptyProcess = pty.spawn(binPath, args, {
        name: "xterm-color",
        cols: 500,
        rows: 500,
      });

      if (onMessage) {
        ptyProcess.onData((data) => {
          try {
            this.emit("download-message", data);
            const message = stripAnsi(data);
            this.logger.debug("download message: ", message);
            onMessage(message);
          } catch (err) {
            reject(err);
          }
        });
      }

      abortSignal.signal.addEventListener("abort", () => {
        ptyProcess.kill();
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        if (exitCode === 0 && (signal === 0 || signal == null)) {
          resolve();
        } else if (exitCode === 0 && signal === 1) {
          reject(new Error("AbortError"));
        } else {
          reject(new Error("未知错误"));
        }
      });
    });
  }

  async biliDownloader(params: DownloadParams): Promise<void> {
    const { id, abortSignal, url, local, callback } = params;
    // const progressReg = /([\d.]+)% .*? ([\d.\w]+?) /g;
    const progressReg = /([\d.]+)%/g;
    const errorReg = /ERROR/g;
    const startDownloadReg = /保存文件名:/g;
    const isLiveReg = /检测到直播流/g;

    const spawnParams = [url, "--work-dir", local];

    await this._execa(biliDownloaderBin, spawnParams, {
      abortSignal,
      onMessage: (message) => {
        if (isLiveReg.test(message) || startDownloadReg.test(message)) {
          callback({
            id,
            type: "ready",
            isLive: false,
            cur: "",
            total: "",
            speed: "",
          });
        }

        const log = stripColors(message);
        if (errorReg.test(log)) {
          throw new Error(log);
        }

        const result = progressReg.exec(log);
        if (!result) {
          return;
        }

        const [, percentage, speed] = result;
        const cur = String(Number(percentage) * 10);
        if (cur === "0") {
          return;
        }

        const total = "1000";
        // FIXME: 无法获取是否为直播流
        const progress: DownloadProgress = {
          id,
          type: "progress",
          cur,
          total,
          speed,
          isLive: false,
        };
        callback(progress);
      },
    });
  }

  async m3u8Downloader(params: DownloadParams): Promise<void> {
    const {
      id,
      abortSignal,
      url,
      local,
      name,
      deleteSegments,
      headers,
      callback,
      proxy,
    } = params;
    // const progressReg = /([\d.]+)% .*? ([\d.\w]+?) /g;
    const progressReg = /([\d.]+)%/g;
    const errorReg = /ERROR/g;
    const startDownloadReg = /保存文件名:/g;
    const isLiveReg = /检测到直播流/g;

    const spawnParams = [
      url,
      "--tmp-dir",
      local,
      "--save-dir",
      local,
      "--save-name",
      name,
      "--auto-select",
    ];

    if (headers) {
      // const h: Record<string, unknown> = JSON.parse(headers);
      // Object.entries(h).forEach(([k, v]) => {
      //   spawnParams.push("--header", `${k}: ${v}`);
      // });
    }

    if (deleteSegments) {
      spawnParams.push("--del-after-done");
    }

    if (proxy) {
      spawnParams.push("--custom-proxy", proxy);
    }

    let isLive = false;
    await this._execa(m3u8DownloaderBin, spawnParams, {
      abortSignal,
      onMessage: (message) => {
        if (isLiveReg.test(message) || startDownloadReg.test(message)) {
          callback({
            id,
            type: "ready",
            isLive,
            cur: "",
            total: "",
            speed: "",
          });
          isLive = true;
        }

        const log = stripColors(message);

        if (errorReg.test(log)) {
          throw new Error(log);
        }

        const result = progressReg.exec(log);
        if (!result) {
          return;
        }

        const [, precentage, speed] = result;
        const cur = String(Number(precentage) * 10);
        if (cur === "0") {
          return;
        }

        const total = "1000";
        // FIXME: 无法获取是否为直播流
        const progress: DownloadProgress = {
          id,
          type: "progress",
          cur,
          total,
          speed,
          isLive,
        };
        callback(progress);
      },
    });
  }

  process(params: DownloadParams): Promise<void> {
    if (params.type === "bilibili") {
      return this.biliDownloader(params);
    }

    if (params.type === "m3u8") {
      return this.m3u8Downloader(params);
    }

    return Promise.reject();
  }
}
