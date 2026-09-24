/** One error type the API layer maps straight to a status and a code. */
export class CampaignError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 404 | 409 | 422,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}
