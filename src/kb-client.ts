// client for IT-Solution's «База знаний и тестирование» REST API
// docs: https://it-solution.kdb24.ru/public/kdb24/d162293/

const MIN_REQUEST_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class KbClient {
  private baseUrl = "https://articles.it-solution.ru/extapi";
  private token: string;
  private queue: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;

  constructor(token: string) {
    this.token = token;
  }

  async call<T = unknown>(method: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue = this.queue
        .then(async () => {
          const elapsed = Date.now() - this.lastRequestTime;
          if (elapsed < MIN_REQUEST_INTERVAL_MS) {
            await sleep(MIN_REQUEST_INTERVAL_MS - elapsed);
          }
          this.lastRequestTime = Date.now();

          const qs = new URLSearchParams({ token: this.token });
          for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
          const url = `${this.baseUrl}/${method}/?${qs.toString()}`;

          const response = await fetch(url);
          const text = await response.text();
          if (!response.ok) throw new Error(`IT-Solution KB API ${response.status}: ${text.substring(0, 300)}`);

          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error(`IT-Solution KB API non-JSON response: ${text.substring(0, 300)}`);
          }
          if (data && typeof data === "object" && "error" in data) {
            throw new Error(`IT-Solution KB API error: ${(data as { error: string }).error}`);
          }
          resolve(data as T);
        })
        .catch(reject);
    });
  }
}
