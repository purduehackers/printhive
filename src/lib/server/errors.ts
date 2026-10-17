export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function invariant(value: unknown, status: number, message: string): asserts value {
  if (!value) throw new HttpError(status, message);
}
