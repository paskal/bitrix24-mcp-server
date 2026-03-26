const MIN_REQUEST_INTERVAL_MS = 500; // 2 req/sec for webhooks

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// bitrix24 wraps list responses with total/next at the top level alongside result
interface BitrixRawResponse {
  result: unknown;
  total?: number;
  next?: number;
  time?: Record<string, unknown>;
  error?: string;
  error_description?: string;
}

export class BitrixClient {
  private webhookUrl: string;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;

  constructor(webhookUrl: string) {
    this.webhookUrl = webhookUrl.endsWith("/") ? webhookUrl : webhookUrl + "/";
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<{ result: T } & BitrixRawResponse> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const elapsed = Date.now() - this.lastRequestTime;
          if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
          }
          this.lastRequestTime = Date.now();

          const url = `${this.webhookUrl}${method}`;
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params ?? {}),
          });

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Bitrix24 API ${response.status}: ${text}`);
          }

          const data = (await response.json()) as BitrixRawResponse;

          if (data.error) {
            throw new Error(`Bitrix24: ${data.error} — ${data.error_description ?? ""}`);
          }

          resolve(data as { result: T } & BitrixRawResponse);
        })
        .catch(reject);
    });
  }

  async callList<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    maxPages = 20,
    extractItems?: (result: unknown) => T[],
  ): Promise<{ items: T[]; total: number }> {
    const allItems: T[] = [];
    let start = 0;
    let total = 0;

    const defaultExtract = (result: unknown): T[] => {
      if (Array.isArray(result)) return result as T[];
      if (result && typeof result === "object" && "tasks" in result) {
        return (result as { tasks: T[] }).tasks;
      }
      throw new Error(`Unexpected list response shape: ${JSON.stringify(result).substring(0, 200)}`);
    };

    const extract = extractItems ?? defaultExtract;

    for (let page = 0; page < maxPages; page++) {
      const response = await this.call(method, { ...params, start });

      allItems.push(...extract(response.result));
      total = response.total ?? allItems.length;

      if (!response.next) break;
      start = response.next;
    }

    return { items: allItems, total };
  }

  async batch<T = unknown>(commands: Record<string, string>): Promise<Record<string, T>> {
    const response = await this.call<{
      result: Record<string, T>;
      result_error: Record<string, unknown>;
    }>("batch", { cmd: commands });

    const batchResult = response.result;
    const errors = batchResult.result_error;
    if (errors && Object.keys(errors).length > 0) {
      throw new Error(`Batch errors: ${JSON.stringify(errors)}`);
    }

    return batchResult.result;
  }
}
