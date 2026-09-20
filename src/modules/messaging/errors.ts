export type MessagingErrorCode =
  | 'channel_not_configured'
  | 'template_not_found'
  | 'template_variable_missing'
  | 'template_invalid'
  | 'unsubscribe_text_required'
  | 'credentials_rejected'
  | 'unknown_provider';

/** One error type the API layer maps straight to a status and a code. */
export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    readonly status: 400 | 404 | 409 | 422,
    message?: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}
