/**
 * Custom error classes for baruch
 */

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_ERROR', 401);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 'AUTHORIZATION_ERROR', 403);
    this.name = 'AuthorizationError';
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ValidationError';
  }
}

export class ClaudeAPIError extends AppError {
  constructor(
    message: string,
    public readonly claudeStatusCode?: number
  ) {
    super(message, 'CLAUDE_API_ERROR', 502);
    this.name = 'ClaudeAPIError';
  }
}

export class AdminApiError extends AppError {
  constructor(
    message: string,
    public readonly apiStatusCode?: number
  ) {
    super(message, 'ADMIN_API_ERROR', 502);
    this.name = 'AdminApiError';
  }
}

export class TimeoutError extends AppError {
  constructor(message: string = 'Operation timed out') {
    super(message, 'TIMEOUT_ERROR', 504);
    this.name = 'TimeoutError';
  }
}
