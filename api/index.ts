import type { VercelRequest, VercelResponse } from "@vercel/node";
import axios, { AxiosResponse } from "axios";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      CONTENT_TYPE_ALLOWLIST: string;
      PATH_ALLOWLIST: string;
      ENDPOINT_ALLOWLIST: string;
    }
  }
}

const allowCors =
  (fn: Function) => async (req: VercelRequest, res: VercelResponse) => {
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    // another common pattern
    // res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,POST");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );
    if (req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    return await fn(req, res);
  };

const handleRequest = (response: AxiosResponse, res: VercelResponse) => {
  if (process.env.CONTENT_TYPE_ALLOWLIST) {
    const contentTypeAllowlist: string[] = JSON.parse(
      process.env.CONTENT_TYPE_ALLOWLIST
    );
    const contentType = response.headers["content-type"];
    if (
      contentType &&
      typeof contentType === "string" &&
      !contentTypeAllowlist.some((c) => contentType.includes(c))
    ) {
      res.statusCode = 403;
      res.send(`Forbidden Content Type: ${contentType}`);
      return;
    }
  }

  response.data.pipe(res);
};

/**
 * Never echo the error itself: an AxiosError serializes with its stack, the
 * server's file paths and the outgoing request config. The caller only needs
 * the upstream status, or 502 when there was no upstream response at all.
 */
const handleError = (error: any, res: VercelResponse) => {
  const status = error?.response?.status;
  res.statusCode = typeof status === "number" ? status : 502;
  res.send(
    typeof status === "number"
      ? `Upstream responded with ${status}`
      : "Upstream request failed"
  );
};

const isEndpointAllowed = (endpoints: string[], url: URL): boolean => {
  return endpoints.includes(url.host);
}

const isPathAllowed = (paths: string[], path: string): boolean => {
  return paths.some((p) => new RegExp(p).test(path));
}

/**
 * Returns why `endpointUrl` may not be fetched, or undefined when it may. Used
 * for the requested url and again for every redirect it leads to, since
 * otherwise an allowed host could forward the proxy anywhere.
 */
const getForbiddenReason = (endpointUrl: URL): string | undefined => {
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    return `Forbidden protocol: ${endpointUrl.protocol}`;
  }
  let endpointAllowlist: string[] = [];
  let pathAllowlist: string[] = [];
  if (process.env.ENDPOINT_ALLOWLIST) {
    endpointAllowlist = JSON.parse(process.env.ENDPOINT_ALLOWLIST);
  }
  if (process.env.PATH_ALLOWLIST) {
    pathAllowlist = JSON.parse(process.env.PATH_ALLOWLIST);
  }

  const path = endpointUrl.pathname;
  if (endpointAllowlist.length) {
    if (!isEndpointAllowed(endpointAllowlist, endpointUrl) &&
      !isPathAllowed(pathAllowlist, path)
    ) {
      return `Forbidden endpoint: ${endpointUrl.host}`;
    }
  } else if (pathAllowlist.length && !isPathAllowed(pathAllowlist, path)) {
    return `Forbidden path: ${path}`;
  }
  return undefined;
};

class ForbiddenRedirectError extends Error {}

const handler = (req: VercelRequest, res: VercelResponse) => {
  let { url } = req.query;
  if (Array.isArray(url)) {
    url = url[0];
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(url);
  } catch {
    res.statusCode = 400;
    res.send("Missing or invalid url parameter");
    return;
  }

  const reason = getForbiddenReason(endpointUrl);
  if (reason) {
    res.statusCode = 403;
    res.send(reason);
    return;
  }

  axios
    .request({
      url: url,
      method: req.method,
      responseType: "stream",
      beforeRedirect: (options: Record<string, any>) => {
        const redirectUrl = new URL(
          `${options.protocol}//${options.host}${options.path ?? ""}`
        );
        const redirectReason = getForbiddenReason(redirectUrl);
        if (redirectReason) {
          throw new ForbiddenRedirectError(`Redirect blocked. ${redirectReason}`);
        }
      },
    })
    .then((response) => handleRequest(response, res))
    .catch((e) => {
      // A throw from beforeRedirect arrives wrapped twice: follow-redirects
      // wraps it, then axios wraps that.
      let forbidden = e;
      while (forbidden && !(forbidden instanceof ForbiddenRedirectError)) {
        forbidden = forbidden.cause;
      }
      if (forbidden) {
        res.statusCode = 403;
        res.send(forbidden.message);
        return;
      }
      handleError(e, res);
    });
};

module.exports = allowCors(handler);
module.exports.isEndpointAllowed = isEndpointAllowed;
module.exports.isPathAllowed = isPathAllowed;
module.exports.handleRequest = handleRequest;
module.exports.handleError = handleError;
module.exports.handler = handler;
module.exports.getForbiddenReason = getForbiddenReason;
module.exports.allowCors = allowCors;
