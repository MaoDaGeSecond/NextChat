import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "../config/server";
import { OPENAI_BASE_URL, ServiceProvider } from "../constant";
import { cloudflareAIGatewayUrl } from "../utils/cloudflare";
import { getModelProvider, isModelNotavailableInServer } from "../utils/model";

// 译达通鉴权相关变量
const AuthInfo: any = {},
  // baseURL = "https://edatone.com/api/v1";
  baseURL = "http://test.edatone.com.cn/api/v1";
let blacklist: string[] = [];

const serverConfig = getServerSideConfig();

// 加载黑名单
function loadBlacklist() {
  fetch(`${baseURL}/trans/gptbl`, {
    method: "get",
  })
    .then((res) => {
      res
        .json()
        .then((data) => {
          blacklist = data?.uid || [];
        })
        .catch(() => {});
    })
    .catch(() => {});
}
loadBlacklist();
setInterval(() => {
  loadBlacklist();
}, 600000);

// 权限校验函数
export function checkAuth(req: NextRequest) {
  let ip: any = "";
  if (req.headers.get("x-real-ip")) {
    ip = req.headers.get("x-real-ip");
  } else if (req.headers.get("x-forwarded-for")) {
    ip = req.headers.get("x-forwarded-for");
  } else ip = req.nextUrl.hostname;

  let infoStr = req.headers.get("reqInfo");
  let reqInfo: any = {};
  if (infoStr) reqInfo = JSON.parse(infoStr);
  reqInfo.ip = ip;

  if (!reqInfo.token)
    return {
      code: 599,
      msg: "请到译达通官网：https://edatone.com，更新客户端到1.4.3及以上版本使用",
    };

  let auth = AuthInfo[reqInfo.token];
  if (auth) {
    if (auth.enable) {
      if (blacklist.includes(auth.userId))
        return {
          code: 500,
          msg: "当前用户GPT额度不足，请联系译达通客服~",
        };
      return {
        reqInfo,
        code: 200,
        msg: "验证成功。",
      };
    }
  }

  gptauth(reqInfo);
  return {
    reqInfo,
    code: 200,
    msg: "验证成功。",
  };
}

// 用户验证函数
function gptauth(reqInfo: any) {
  fetch(`${baseURL}/trans/gptauth`, {
    method: "get",
    headers: {
      "x-token": reqInfo.token || "",
    },
  })
    .then((res) => {
      res
        .json()
        .then((data) => {
          data = "object" == typeof data ? data : { msg: data };
          data.code = res.status;
          if (200 == data.code && data.userId) {
            data.reqInfo = reqInfo;
            AuthInfo[reqInfo.token] = {
              enable: true,
              userId: data.userId,
            };
          }
        })
        .catch(() => {});
    })
    .catch(() => {});
}

// 日志记录函数
export function gptlog(reqInfo: any) {
  try {
    if (!reqInfo?.token || !reqInfo?.messages) return;
    let _buffer = new Uint8Array(JSON.parse(reqInfo.messages)).buffer;
    reqInfo.messages = arrayBufferToString(_buffer);
    let token = reqInfo.token;
    delete reqInfo.token;
    fetch(`${baseURL}/trans/gptlogs`, {
      method: "post",
      headers: {
        "x-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqInfo),
    })
      .then(() => {})
      .catch(() => {});
  } catch (error) {}
}

function arrayBufferToString(buffer: ArrayBuffer) {
  try {
    var decoder = new TextDecoder("utf-8");
    return decoder.decode(buffer);
  } catch (e) {
    return "参数处理异常！";
  }
}

export async function requestOpenai(req: NextRequest) {
  const controller = new AbortController();

  // 添加译达通权限校验
  let result: any = {
    code: 500,
    msg: "权限验证失败！",
  };
  try {
    result = checkAuth(req);
  } catch (error) {}

  if (200 != result?.code)
    return NextResponse.json(
      {
        error: true,
        message: result?.msg || `权限验证失败！`,
      },
      {
        status: result?.code || 401,
      },
    );

  req.headers.delete("reqInfo");

  const isAzure = req.nextUrl.pathname.includes("azure/deployments");

  var authValue,
    authHeaderName = "";
  if (isAzure) {
    authValue =
      req.headers
        .get("Authorization")
        ?.trim()
        .replaceAll("Bearer ", "")
        .trim() ?? "";

    authHeaderName = "api-key";
  } else {
    authValue = req.headers.get("Authorization") ?? "";
    authHeaderName = "Authorization";
  }

  let path = `${req.nextUrl.pathname}`.replaceAll("/api/openai/", "");

  let baseUrl =
    (isAzure ? serverConfig.azureUrl : serverConfig.baseUrl) || OPENAI_BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `https://${baseUrl}`;
  }

  if (baseUrl.endsWith("/")) {
    baseUrl = baseUrl.slice(0, -1);
  }

  console.log("[Proxy] ", path);
  console.log("[Base Url]", baseUrl);

  const timeoutId = setTimeout(
    () => {
      controller.abort();
    },
    10 * 60 * 1000,
  );

  if (isAzure) {
    const azureApiVersion =
      req?.nextUrl?.searchParams?.get("api-version") ||
      serverConfig.azureApiVersion;
    baseUrl = baseUrl.split("/deployments").shift() as string;
    path = `${req.nextUrl.pathname.replaceAll(
      "/api/azure/",
      "",
    )}?api-version=${azureApiVersion}`;

    // Forward compatibility:
    // if display_name(deployment_name) not set, and '{deploy-id}' in AZURE_URL
    // then using default '{deploy-id}'
    if (serverConfig.customModels && serverConfig.azureUrl) {
      const modelName = path.split("/")[1];
      let realDeployName = "";
      serverConfig.customModels
        .split(",")
        .filter((v) => !!v && !v.startsWith("-") && v.includes(modelName))
        .forEach((m) => {
          const [fullName, displayName] = m.split("=");
          const [_, providerName] = getModelProvider(fullName);
          if (providerName === "azure" && !displayName) {
            const [_, deployId] = (serverConfig?.azureUrl ?? "").split(
              "deployments/",
            );
            if (deployId) {
              realDeployName = deployId;
            }
          }
        });
      if (realDeployName) {
        console.log("[Replace with DeployId", realDeployName);
        path = path.replaceAll(modelName, realDeployName);
      }
    }
  }

  // 在发送请求前记录日志
  if (result?.reqInfo) {
    gptlog(result.reqInfo);
  }

  const fetchUrl = cloudflareAIGatewayUrl(`${baseUrl}/${path}`);
  console.log("fetchUrl", fetchUrl);
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      [authHeaderName]: authValue,
      ...(serverConfig.openaiOrgId && {
        "OpenAI-Organization": serverConfig.openaiOrgId,
      }),
    },
    method: req.method,
    body: req.body,
    // to fix #2485: https://stackoverflow.com/questions/55920957/cloudflare-worker-typeerror-one-time-use-body
    redirect: "manual",
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // #1815 try to refuse gpt4 request
  if (serverConfig.customModels && req.body) {
    try {
      const clonedBody = await req.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody) as { model?: string };

      // not undefined and is false
      if (
        isModelNotavailableInServer(
          serverConfig.customModels,
          jsonBody?.model as string,
          [
            ServiceProvider.OpenAI,
            ServiceProvider.Azure,
            jsonBody?.model as string, // support provider-unspecified model
          ],
        )
      ) {
        return NextResponse.json(
          {
            error: true,
            message: `you are not allowed to use ${jsonBody?.model} model`,
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter", e);
    }
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);

    // Extract the OpenAI-Organization header from the response
    const openaiOrganizationHeader = res.headers.get("OpenAI-Organization");

    // Check if serverConfig.openaiOrgId is defined and not an empty string
    if (serverConfig.openaiOrgId && serverConfig.openaiOrgId.trim() !== "") {
      // If openaiOrganizationHeader is present, log it; otherwise, log that the header is not present
      console.log("[Org ID]", openaiOrganizationHeader);
    } else {
      console.log("[Org ID] is not set up.");
    }

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");
    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    // Conditionally delete the OpenAI-Organization header from the response if [Org ID] is undefined or empty (not setup in ENV)
    // Also, this is to prevent the header from being sent to the client
    if (!serverConfig.openaiOrgId || serverConfig.openaiOrgId.trim() === "") {
      newHeaders.delete("OpenAI-Organization");
    }

    // The latest version of the OpenAI API forced the content-encoding to be "br" in json response
    // So if the streaming is disabled, we need to remove the content-encoding header
    // Because Vercel uses gzip to compress the response, if we don't remove the content-encoding header
    // The browser will try to decode the response with brotli and fail
    newHeaders.delete("content-encoding");

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
