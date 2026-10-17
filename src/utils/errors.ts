export class EtsyApiError extends Error {
  constructor(
    public status: number,
    public errorBody: unknown,
    message?: string
  ) {
    super(message ?? `Etsy API error (${status})`);
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
