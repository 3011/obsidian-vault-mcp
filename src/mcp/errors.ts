export type ToolErrorCode =
  | "INVALID_ARGUMENT"
  | "PATH_NOT_FOUND"
  | "PARENT_NOT_FOUND"
  | "ALREADY_EXISTS"
  | "CONTENT_CONFLICT"
  | "DESTINATION_CONFLICT"
  | "DIRECTORY_NOT_EMPTY"
  | "INTERNAL_ERROR";

export type ToolErrorPayload = {
  code: ToolErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
};

export type NormalizedToolFailure = {
  error: ToolErrorPayload;
  result?: Record<string, unknown>;
};

export class ToolDomainError extends Error {
  readonly code: ToolErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly result: Record<string, unknown> | undefined;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      result?: Record<string, unknown>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ToolDomainError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
    this.result = options.result;
  }
}

export function normalizeToolError(error: unknown): NormalizedToolFailure {
  if (error instanceof ToolDomainError) {
    const payload: ToolErrorPayload = {
      code: error.code,
      message: error.message,
      retryable: error.retryable
    };
    if (error.details !== undefined) payload.details = error.details;
    const failure: NormalizedToolFailure = { error: payload };
    if (error.result !== undefined) failure.result = error.result;
    return failure;
  }

  const message = error instanceof Error ? error.message : String(error);
  const nodeCode = getNodeErrorCode(error);

  if (/parent directory not found/i.test(message)) {
    return { error: { code: "PARENT_NOT_FOUND", message, retryable: false } };
  }
  if (nodeCode === "ENOENT" || /(?:file|directory|path|note) not found|no such file/i.test(message)) {
    return { error: { code: "PATH_NOT_FOUND", message, retryable: false } };
  }
  if (nodeCode === "ENOTEMPTY" || /directory not empty|not empty/i.test(message)) {
    return { error: { code: "DIRECTORY_NOT_EMPTY", message, retryable: false } };
  }
  if (/destination .*exists|destination conflict/i.test(message)) {
    return { error: { code: "DESTINATION_CONFLICT", message, retryable: false } };
  }
  if (nodeCode === "EEXIST" || /already exists/i.test(message)) {
    return { error: { code: "ALREADY_EXISTS", message, retryable: false } };
  }
  if (/traversal|absolute path|not allowed|must be .*path|cannot change a file between|must be a single/i.test(message)) {
    return { error: { code: "INVALID_ARGUMENT", message, retryable: false } };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message,
      retryable: false
    }
  };
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
