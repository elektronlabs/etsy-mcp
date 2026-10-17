const DETAIL_LIMIT = 300;

/** Etsy's own reason for a failure, for use in error messages. Empty when the body says nothing. */
export function describeErrorBody(errorBody: unknown): string {
  if (errorBody === null || errorBody === undefined) return "";
  if (typeof errorBody === "object" && "error" in errorBody) {
    const reason = (errorBody as { error: unknown }).error;
    return typeof reason === "string" ? reason : JSON.stringify(reason) ?? "";
  }
  return (JSON.stringify(errorBody) ?? "").slice(0, DETAIL_LIMIT);
}

export class EtsyApiError extends Error {
  constructor(
    public status: number,
    public errorBody: unknown,
    message?: string
  ) {
    // The MCP SDK forwards only error.message to Claude, so Etsy's reason has to live in it.
    const detail = describeErrorBody(errorBody);
    super(message ?? `Etsy API error (${status})${detail ? `: ${detail}` : ""}`);
    this.name = "EtsyApiError";
  }
}

/** A login problem Claude can fix by calling the authenticate tool. */
export class EtsyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtsyAuthError";
  }
}

export class TokenRefreshError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`Token refresh failed (${status}): ${body}`);
    this.name = "TokenRefreshError";
  }

  /** Etsy rejected the refresh token itself (expired after 90 days or revoked). */
  get isInvalidGrant(): boolean {
    return this.body.includes("invalid_grant");
  }
}
