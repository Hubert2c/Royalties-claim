// =============================================================================
// lib/errors.js — one family of error classes for the whole API
// -----------------------------------------------------------------------------
// Every expected problem (bad input, missing record, wrong role...) is thrown as
// a subclass of AppError. Each subclass knows its own HTTP status code, so the
// single error handler in server.js can answer every one of them the same way:
//
//     throw new ValidationError('Shares must total exactly 100%.');
//     -> HTTP 400  { "message": "Shares must total exactly 100%." }
//
// This is inheritance + polymorphism: the handler only asks "is this an
// AppError, and what is its status?" and never needs a long if/else chain.
// =============================================================================

class AppError extends Error {
  /**
   * @param {string} message - a message that is safe to show to the user
   * @param {number} status  - the HTTP status code for this kind of problem
   */
  constructor(message, status = 500) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }

  /** What the API sends back to the browser. */
  toResponse() {
    return { message: this.message };
  }
}

/** The request is missing something or contains a wrong value (HTTP 400). */
class ValidationError extends AppError {
  constructor(message) { super(message, 400); }
}

/** Not logged in, or the login/API key is invalid (HTTP 401). */
class AuthenticationError extends AppError {
  constructor(message = 'Please log in first.') { super(message, 401); }
}

/** Logged in, but this role may not do this (HTTP 403). */
class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do this.') { super(message, 403); }
}

/** The record does not exist (HTTP 404). */
class NotFoundError extends AppError {
  constructor(what = 'Record') { super(`${what} not found.`, 404); }
}

/** The action clashes with the current state, e.g. paying a run twice (HTTP 409). */
class ConflictError extends AppError {
  constructor(message) { super(message, 409); }
}

/** A feature needs settings that are not configured yet, e.g. live payments (HTTP 503). */
class NotConfiguredError extends AppError {
  constructor(message) { super(message, 503); }
}

/**
 * Express error-handling middleware. Known errors (AppError) are answered with
 * their own status; anything else is logged and hidden behind a generic 500.
 */
function errorHandler(error, req, res, next) {
  if (error instanceof AppError) return res.status(error.status).json(error.toResponse());
  if (error && error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The file is too large.' });
  if (error && error.message === 'CORS policy blocked this origin.') return res.status(403).json({ message: error.message });
  if (error && error.type === 'entity.parse.failed') return res.status(400).json({ message: 'The request body is not valid JSON.' });
  console.error(error);
  return res.status(500).json({ message: 'Something went wrong on the server.' });
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  NotConfiguredError,
  errorHandler
};
