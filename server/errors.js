export class AppError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const notFound = (what = 'Registro') => new AppError(`${what} não encontrado.`, 404, 'not_found');
