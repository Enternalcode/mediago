import EventEmitter from "events";

export async function sleep(second = 1): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, second * 1000));
}

export function formatHeaders(headers: Record<string, string>): string {
  if (!headers) return "";
  const formatted = Object.entries(headers)
    .map(([key, value]) => `${key}:${value}`)
    .join("\n");
  return formatted;
}

export const event = new EventEmitter();

export interface IpcResponse {
  code: number;
  message: string;
  data: Record<string, any> | null;
}

export function success(data: Record<string, any>): IpcResponse {
  return {
    code: 0,
    message: "success",
    data,
  };
}

export function error(message = "fail"): IpcResponse {
  return {
    code: -1,
    message,
    data: null,
  };
}

// 判断是否为 deeplink 的函数
export function isDeeplink(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:";
  } catch (error) {
    console.error(`无效的 URL: ${url}`);
    return false;
  }
}
