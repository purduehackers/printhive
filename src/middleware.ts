import { defineMiddleware } from 'astro:middleware';
import { checkOrigin, errorResponse } from './lib/server/http';
import { logError } from './lib/server/log';
import { startPushDispatcher } from './lib/server/push';

export const onRequest = defineMiddleware(async (context, next) => {
  try {
    startPushDispatcher();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.request.method)) checkOrigin(context.request);
    const response = await next();
    if (response.status >= 500) logError('http.server_error_response', new Error('Route returned a server error; see preceding logs for the underlying failure.'), {
      method: context.request.method, path: context.url.pathname, status: response.status,
    });
    response.headers.set('Cache-Control', 'no-store');
    // Hide confirmation paths/tokens while retaining Origin on browser form POSTs.
    response.headers.set('Referrer-Policy', 'strict-origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return response;
  } catch (error) { return errorResponse(error, context.request); }
});
