export class MlcError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'MlcError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function validationError(message, details) {
  return new MlcError('validation_error', message, details);
}
