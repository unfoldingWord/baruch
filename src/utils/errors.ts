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

export class ToolInputError extends AppError {
  constructor(
    public readonly toolName: string,
    public readonly reason: string
  ) {
    super(`${toolName}: ${reason}`, 'TOOL_INPUT_ERROR', 400);
    this.name = 'ToolInputError';
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

export class MCPError extends AppError {
  constructor(
    message: string,
    public readonly serverId: string
  ) {
    super(message, 'MCP_ERROR', 502);
    this.name = 'MCPError';
  }
}

export class MCPResponseTooLargeError extends MCPError {
  constructor(
    public readonly actualSize: number,
    public readonly maxSize: number,
    serverId: string
  ) {
    super(
      `MCP response too large: ${actualSize} bytes exceeds limit of ${maxSize} bytes`,
      serverId
    );
    this.name = 'MCPResponseTooLargeError';
  }
}
