export class HttpError extends Error {
  constructor(public status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpError';
  }
}
export function invariant(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new HttpError(status, message);
}
