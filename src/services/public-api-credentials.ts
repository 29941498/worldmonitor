export interface PublicApiCredentialContext {
  gatewayAuth: boolean;
  appOrigin?: string;
}

/**
 * Public/CDN reads normally omit credentials so their cache key is caller
 * invariant. A self-hosted build behind the login gateway has no anonymous
 * origin: same-origin API reads must carry the gateway cookie or Nginx will
 * challenge them before the application can serve the public response.
 */
export function resolvePublicApiCredentials(
  input: RequestInfo | URL,
  context: PublicApiCredentialContext,
): RequestCredentials {
  if (!context.gatewayAuth || !context.appOrigin) return 'omit';

  try {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const appOrigin = new URL(context.appOrigin).origin;
    const requestUrl = new URL(rawUrl, appOrigin);
    return requestUrl.origin === appOrigin && requestUrl.pathname.startsWith('/api/')
      ? 'include'
      : 'omit';
  } catch {
    return 'omit';
  }
}

export function publicApiCredentials(input: RequestInfo | URL): RequestCredentials {
  const viteEnv = typeof import.meta.env === 'undefined' ? undefined : import.meta.env;
  return resolvePublicApiCredentials(input, {
    gatewayAuth: viteEnv?.VITE_SELF_HOSTED_LOGIN_GATEWAY === 'true',
    appOrigin: typeof window === 'undefined' ? undefined : window.location.origin,
  });
}
