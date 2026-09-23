import type {
  ISshConfigsResponse,
  IApplicationsResponse,
  IUnresolvedParametersResponse,
  IEnumValuesResponse,
  IPostEnumValuesBody,
  ICompatibleAddonsResponse,
  IStacktypesResponse,
  IStacksResponse,
  IPostVeConfigurationBody,
  IPostVeConfigurationResponse,
  IVeExecuteMessagesResponse,
} from "@shared/types.mjs";
import type { ValidationResult } from "@shared/parameter-validator.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ConnectionError,
  AuthenticationError,
  NotFoundError,
  ApiError,
} from "./cli-types.mjs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * POST a form-urlencoded body using Node's low-level http(s).request API,
 * which (unlike global fetch / undici) preserves a user-supplied `Host`
 * header. Used by the OIDC token endpoint when the runner reaches Zitadel
 * via an external NAT but Zitadel's instance-domain lookup expects a
 * different Host (see OidcCredentials.hostOverride for the rationale).
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` (set by the CLI's --insecure flag)
 * already disables TLS verification globally for https.request too.
 */
async function httpPostForm(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; text: string }> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const options = {
    method: "POST",
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
  };
  return await new Promise((resolve, reject) => {
    const req = reqFn(options, (resp) => {
      const chunks: Buffer[] = [];
      resp.on("data", (c: Buffer) => chunks.push(c));
      resp.on("end", () => {
        resolve({
          status: resp.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("OIDC token request timed out after 30s")));
    req.write(body);
    req.end();
  });
}

export interface OidcCredentials {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional override for the HTTP Host header sent to the OIDC token
   * endpoint. Needed when the runner reaches Zitadel via an external NAT
   * (e.g. `http://ubuntupve:1808`) but Zitadel was configured with an
   * internal `ExternalDomain` (e.g. `zitadel-default:8080`) and rejects
   * requests whose Host header doesn't match a registered instance
   * domain. With the override, bytes route by URL while Zitadel's
   * domain-lookup sees the value it expects. Production deployments
   * where the public URL matches Zitadel's configured ExternalDomain
   * leave this unset. */
  hostOverride?: string;
  /** Zitadel project ID. When set, the token request scope includes
   * `urn:zitadel:iam:org:project:id:<projectId>:aud` so the JWT carries
   * a project audience AND role claims (`accessTokenRoleAssertion`).
   * Without this the JWT has no roles, and the proxvex Hub's
   * webapp-auth-middleware rejects with HTTP 403 "Required role:
   * 'admin'". Matches the scope production/_lib.sh uses for the same
   * machine-user client_credentials grant. */
  projectId?: string;
}

/**
 * Format a structured backend error body (see webapp-error-utils.serializeError)
 * into a human-readable multi-line string. Falls back to the top-level `error`
 * field or a JSON dump if the shape is unknown.
 */
function formatErrorDetail(errBody: unknown): string {
  if (!errBody || typeof errBody !== "object") {
    return String(errBody ?? "");
  }
  const body = errBody as {
    error?: string;
    serializedError?: {
      name?: string;
      message?: string;
      filename?: string;
      line?: number;
      details?: Array<{ message?: string; line?: number; filename?: string; details?: unknown[] }>;
    };
  };
  const top = body.error ?? "";
  const se = body.serializedError;
  if (!se) {
    return top || JSON.stringify(errBody);
  }

  const lines: string[] = [];
  if (top) lines.push(top);
  if (se.filename) lines.push(`  file: ${se.filename}${se.line ? `:${se.line}` : ""}`);
  if (se.message && se.message !== top) lines.push(`  message: ${se.message}`);

  const flattenDetails = (
    details: Array<{ message?: string; line?: number; filename?: string; details?: unknown[] }> | undefined,
    indent: string,
  ): void => {
    if (!details || details.length === 0) return;
    for (const d of details) {
      const loc = d.filename ? ` [${d.filename}${d.line ? `:${d.line}` : ""}]` : "";
      lines.push(`${indent}- ${d.message ?? "(no message)"}${loc}`);
      if (Array.isArray(d.details) && d.details.length > 0) {
        flattenDetails(d.details as any, indent + "  ");
      }
    }
  };
  flattenDetails(se.details, "  ");

  return lines.join("\n");
}

export class CliApiClient {
  private baseUrl: string;
  private token?: string;
  private oidcCredentials?: OidcCredentials;
  private fixtureDir?: string;
  private fixtureIndex = 0;

  constructor(baseUrl: string, token?: string, insecure?: boolean, fixturePath?: string, oidcCredentials?: OidcCredentials) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (token) this.token = token;
    if (oidcCredentials) this.oidcCredentials = oidcCredentials;
    if (insecure) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    if (fixturePath) {
      this.fixtureDir = fixturePath;
      mkdirSync(fixturePath, { recursive: true });
    }
  }

  /** Returns the current base URL (for poll-loop fallback detection). */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Hot-swap the base URL while a polling loop is mid-run.
   *
   * Used by CliProgress to fail over from the pre-self-upgrade endpoint
   * (e.g. http://ubuntupve:1280) to the post-replace endpoint
   * (https://ubuntupve:1643) when the original Hub-LXC dies during a
   * self-reconfigure-enable-https-oidc scenario. The new URL comes from
   * the `endpoint_url` output emitted by template
   * 351-post-emit-endpoint-config, which runs in post_start (BEFORE the
   * replace_ct phase) so the CLI receives it through the still-alive
   * Hub before the polling URL itself goes dark. */
  setBaseUrl(newUrl: string): void {
    this.baseUrl = newUrl.replace(/\/+$/, "");
  }

  /** Clear the cached bearer so the next request re-mints via
   *  authenticateOidc(). Use when an endpoint shift moves us from
   *  unauthenticated HTTP to OIDC-required HTTPS — the existing token
   *  may have been minted lazily-or-not-at-all under the old endpoint. */
  resetToken(): void {
    this.token = undefined;
  }

  /**
   * Fetch a JWT via OIDC Client Credentials Grant.
   * Called once before the first API request if oidcCredentials are set.
   */
  async authenticateOidc(): Promise<void> {
    if (!this.oidcCredentials) return;
    if (this.token) return; // Already have a token

    const tokenUrl = `${this.oidcCredentials.issuerUrl}/oauth/v2/token`;
    // Zitadel-specific scopes: project audience + roles. Without the
    // `urn:zitadel:iam:org:project:id:<projectId>:aud` scope the JWT
    // is not bound to the proxvex project and carries no role claims,
    // so the Hub's webapp-auth-middleware rejects every /api call with
    // HTTP 403 "Required role: 'admin'". Production's _lib.sh:106
    // uses the same scope set for the same grant.
    let scope = "openid";
    if (this.oidcCredentials.projectId) {
      scope += ` urn:zitadel:iam:org:project:id:${this.oidcCredentials.projectId}:aud urn:zitadel:iam:org:projects:roles`;
    }
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      scope,
    });

    const credentials = Buffer.from(
      `${this.oidcCredentials.clientId}:${this.oidcCredentials.clientSecret}`,
    ).toString("base64");

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Authorization": `Basic ${credentials}`,
    };
    if (this.oidcCredentials.hostOverride) {
      headers["Host"] = this.oidcCredentials.hostOverride;
    }
    // Use http(s).request — fetch (undici) silently overrides any
    // user-supplied Host header with the URL's authority, which defeats
    // the whole point of `hostOverride`. The lower-level API keeps it.
    const { status, text } = await httpPostForm(tokenUrl, headers, params.toString());
    if (status < 200 || status >= 300) {
      throw new AuthenticationError(
        `OIDC token request failed (${status}): ${text}`,
      );
    }
    const data = JSON.parse(text) as { access_token: string };
    this.token = data.access_token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    // Follow 30x redirects manually so the Authorization header is preserved
    // across scheme upgrades. The default `fetch` redirect handler strips
    // Authorization on cross-origin redirects, and HTTP→HTTPS is treated as
    // cross-origin — that's what bit the OIDC self-tests: the Hub on plain
    // HTTP issues a 301 to its own HTTPS once `addon-ssl` is active, and
    // every authenticated /api/* request then arrived at HTTPS without the
    // Bearer, returning 401. We only follow same-origin (host) redirects
    // here; that's the only shape proxvex Hubs ever emit (its own HTTP→
    // HTTPS pinning) and prevents accidentally leaking the token to an
    // unrelated host.
    const fetchOptions: RequestInit = { method, headers, redirect: "manual" };
    if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }
    if (timeoutMs !== undefined) {
      fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    }

    let response: Response;
    let currentUrl = url;
    const maxRedirects = 3;
    try {
      for (let i = 0; i <= maxRedirects; i++) {
        response = await fetch(currentUrl, fetchOptions);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location) break;
          const next = new URL(location, currentUrl).toString();
          const sameHost = new URL(next).hostname === new URL(currentUrl).hostname;
          if (!sameHost) break;
          currentUrl = next;
          continue;
        }
        break;
      }
      response = response!;
    } catch (err: any) {
      throw new ConnectionError(
        `Cannot connect to ${this.baseUrl}: ${err?.message || err}`,
      );
    }

    if (response.status === 401) {
      throw new AuthenticationError("Authentication required. Use --token.");
    }
    if (response.status === 403) {
      throw new AuthenticationError("Invalid token.");
    }
    if (response.status === 404) {
      throw new NotFoundError(`Not found: ${method} ${path}`);
    }
    if (!response.ok) {
      // Read the body exactly once. fetch() lets you consume the body via
      // .json() OR .text() but not both — calling .text() after a failed
      // .json() throws "Body is unusable", which masks the real error.
      const raw = await response.text();
      let detail = raw;
      try {
        detail = formatErrorDetail(JSON.parse(raw));
      } catch {
        // raw is already the textual fallback
      }
      throw new ApiError(
        `API error ${response.status} on ${method} ${path}: ${detail}`,
      );
    }

    const data = (await response.json()) as T;

    if (this.fixtureDir) {
      this.saveFixture(method, path, body, data);
    }

    return data;
  }

  private pollingFixtureFile?: string;

  private saveFixture(method: string, path: string, requestBody: unknown, responseBody: unknown): void {
    // Polling endpoint: only save first and overwrite with latest (keeps first + last)
    if (path.endsWith("/ve/execute")) {
      if (!this.pollingFixtureFile) {
        // First poll — save as "first"
        const idx = String(++this.fixtureIndex).padStart(3, "0");
        const slug = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
        this.pollingFixtureFile = `${idx}-${method}-${slug}`;
        writeFileSync(join(this.fixtureDir!, `${this.pollingFixtureFile}-first.json`), JSON.stringify({
          method, path, request: null, response: responseBody,
        }, null, 2) + "\n");
      }
      // Always overwrite "last" — final file will be the last poll
      writeFileSync(join(this.fixtureDir!, `${this.pollingFixtureFile}-last.json`), JSON.stringify({
        method, path, request: null, response: responseBody,
      }, null, 2) + "\n");
      return;
    }

    const idx = String(++this.fixtureIndex).padStart(3, "0");
    const slug = path.replace(/^\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+$/, "");
    const filename = `${idx}-${method}-${slug}.json`;
    writeFileSync(join(this.fixtureDir!, filename), JSON.stringify({
      method, path, request: requestBody ?? null, response: responseBody,
    }, null, 2) + "\n");
  }

  async getSshConfigs(): Promise<ISshConfigsResponse> {
    return this.request("GET", "/api/sshconfigs");
  }

  async getSshConfigKey(host: string): Promise<{ key: string }> {
    return this.request("GET", `/api/ssh/config/${encodeURIComponent(host)}`);
  }

  async getApplications(): Promise<IApplicationsResponse> {
    return this.request("GET", "/api/applications");
  }

  async getUnresolvedParameters(
    veCtx: string,
    app: string,
    task: string,
  ): Promise<IUnresolvedParametersResponse> {
    return this.request(
      "GET",
      `/api/${veCtx}/unresolved-parameters/${encodeURIComponent(app)}?task=${encodeURIComponent(task)}`,
    );
  }

  async postEnumValues(
    veCtx: string,
    app: string,
    task: string,
  ): Promise<IEnumValuesResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/enum-values/${encodeURIComponent(app)}`,
      { task } as IPostEnumValuesBody,
    );
  }

  async getCompatibleAddons(app: string): Promise<ICompatibleAddonsResponse> {
    return this.request(
      "GET",
      `/api/addons/compatible/${encodeURIComponent(app)}`,
    );
  }

  async getStacktypes(): Promise<IStacktypesResponse> {
    return this.request("GET", "/api/stacktypes");
  }

  async getStacks(stacktype?: string): Promise<IStacksResponse> {
    const query = stacktype
      ? `?stacktype=${encodeURIComponent(stacktype)}`
      : "";
    return this.request("GET", `/api/stacks${query}`);
  }

  async postValidateParameters(
    veCtx: string,
    app: string,
    task: string,
    body: {
      params: { name: string; value: any }[];
      selectedAddons?: string[];
      disabledAddons?: string[];
      stackId?: string;
    },
  ): Promise<ValidationResult> {
    return this.request(
      "POST",
      `/api/${veCtx}/validate-parameters/${encodeURIComponent(app)}`,
      { task, ...body },
    );
  }

  async postVeConfiguration(
    veCtx: string,
    app: string,
    task: string,
    body: Omit<IPostVeConfigurationBody, "task">,
  ): Promise<IPostVeConfigurationResponse> {
    return this.request(
      "POST",
      `/api/${veCtx}/ve-configuration/${encodeURIComponent(app)}`,
      { task, ...body } as IPostVeConfigurationBody,
    );
  }

  async postCreateStack(body: {
    name: string;
    stacktype: string;
    entries?: { name: string; value: string | number | boolean }[];
  }): Promise<{ success: boolean; key: string }> {
    return this.request("POST", "/api/stacks", {
      ...body,
      entries: body.entries ?? [],
    });
  }

  async getContainerConfig(
    veCtx: string,
    vmId: number,
  ): Promise<Record<string, any>> {
    return this.request("GET", `/api/${veCtx}/container-config/${vmId}`);
  }

  async getExecuteMessages(
    veCtx: string,
    since?: number,
    restartKey?: string,
  ): Promise<IVeExecuteMessagesResponse> {
    const parts: string[] = [];
    if (since !== undefined) parts.push(`since=${since}`);
    if (restartKey) parts.push(`restartKey=${encodeURIComponent(restartKey)}`);
    const query = parts.length > 0 ? `?${parts.join("&")}` : "";
    // 30s cap: this endpoint is polled in a loop, and a Hub whose event loop
    // stalls (seen with a swap-thrashing deployer CT) otherwise hangs a
    // single poll for minutes — silently eating the CLI's whole execution
    // budget without producing a heartbeat or a retry. A timeout turns the
    // stall into a normal retry the poll loop already knows how to handle.
    return this.request("GET", `/api/${veCtx}/ve/execute${query}`, undefined, 30_000);
  }

  async getValidation(): Promise<{ valid: boolean; [key: string]: any }> {
    return this.request("GET", "/api/validate");
  }
}
