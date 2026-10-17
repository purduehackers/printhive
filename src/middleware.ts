import { defineMiddleware } from 'astro:middleware';
import { checkOrigin, errorResponse } from './lib/server/http';

export const onRequest = defineMiddleware(async (context, next) => {
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)) checkOrigin(context.request);
    const response = await next();
    response.headers.set('Cache-Control', 'no-store');
    // Hide confirmation paths/tokens while retaining Origin on browser form POSTs.
    response.headers.set('Referrer-Policy', 'strict-origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return response;
  } catch (error) { return errorResponse(error); }
});
