// A minimal W3C WebDriver client, enough to drive a tauri desktop app through tauri-driver (desktop e2e;
// playwright can't drive WebKitGTK).

export class WebDriverError extends Error {
  readonly error: string;
  constructor(error: string, message: string) {
    super(`${error}: ${message}`);
    this.error = error;
  }
}

async function request(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${url}: HTTP ${res.status} ${text}`);
  }
  if (json?.value?.error)
    throw new WebDriverError(json.value.error, json.value.message);
  return json.value;
}

export class WebDriverSession {
  readonly server: string;
  readonly id: string;

  private constructor(server: string, id: string) {
    this.server = server;
    this.id = id;
  }

  /** launches `application` (tauri-driver's `tauri:options`) */
  static async create(
    server: string,
    application: string,
    args: string[] = [],
  ) {
    const value = await request("POST", `${server}/session`, {
      capabilities: {
        alwaysMatch: { "tauri:options": { application, args } },
      },
    });
    return new WebDriverSession(server, value.sessionId);
  }

  private cmd(method: string, path: string, body?: unknown) {
    return request(method, `${this.server}/session/${this.id}${path}`, body);
  }

  title(): Promise<string> {
    return this.cmd("GET", "/title");
  }

  url(): Promise<string> {
    return this.cmd("GET", "/url");
  }

  /** runs `script` (a function body, the last argument is the callback) in the page */
  executeAsync<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.cmd("POST", "/execute/async", { script, args });
  }

  execute<T>(script: string, args: unknown[] = []): Promise<T> {
    return this.cmd("POST", "/execute/sync", { script, args });
  }

  /** ends the session, which closes the app */
  async delete() {
    await this.cmd("DELETE", "");
  }
}
