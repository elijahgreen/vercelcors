import { VercelRequest, VercelResponse } from "@vercel/node";
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
    const contentType: string = response.headers["content-type"];
    if (
      contentType &&
      !contentTypeAllowlist.some((c) => contentType.includes(c))
    ) {
      res.statusCode = 403;
      res.send(`Forbidden Content Type: ${contentType}`);
      return;
    }
  }

  response.data.pipe(res);
};

const handleError = (error: any, res: VercelResponse) => {
  res.statusCode = error.response.status;
  res.send(error);
};

const isEndpointAllowed = (endpoints: string[], url: URL): boolean => {
  return endpoints.includes(url.host);
}

const isPathAllowed = (paths: string[], path: string): boolean => {
  return paths.some((p) => new RegExp(p).test(path));
}

const handler = (req: VercelRequest, res: VercelResponse) => {
  let { url } = req.query;
  if (Array.isArray(url)) {
    url = url[0];
  }
  let endpointAllowlist: string[] = [];
  let pathAllowlist: string[] = [];

  const endpointUrl = new URL(url);
  const path = endpointUrl.pathname;
  if (process.env.ENDPOINT_ALLOWLIST) {
    endpointAllowlist= JSON.parse(process.env.ENDPOINT_ALLOWLIST);
  }
  if (process.env.PATH_ALLOWLIST) {
    pathAllowlist = JSON.parse(process.env.PATH_ALLOWLIST);
  }

  if (endpointAllowlist.length) {
    if (!isEndpointAllowed(endpointAllowlist, endpointUrl) &&
      !isPathAllowed(pathAllowlist, path)
    ) {
      res.statusCode = 403;
      res.send(`Forbidden endpoint: ${endpointUrl.host}`);
      return;
    }
  } else if (pathAllowlist.length && !isPathAllowed(pathAllowlist, path)) {
    res.statusCode = 403;
    res.send(`Forbidden path: ${path}`);
    return;
  }

  axios
    .request({ url: url, method: req.method, responseType: "stream" })
    .then((response) => handleRequest(response, res))
    .catch((e) => handleError(e, res));
};

module.exports = allowCors(handler);
