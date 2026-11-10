const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { readFile } = require("fs/promises");
const { RewriteContent } = require("./Inject.js");

// Hop-by-hop / encoding headers that must not be forwarded as-is
const STRIP_REQUEST_HEADERS = [`host`, `connection`, `accept-encoding`];
const STRIP_RESPONSE_HEADERS = [
    `content-encoding`,
    `content-length`,
    `transfer-encoding`,
    `connection`,
];

async function DispatchProxyCall(Request, Response)
{
    const Cookies = (Request.headers.cookie || ``).split(`;`);
    const HashCookies = new Map();

    for (let Cookie of Cookies)
    {
        const Separator = Cookie.indexOf(`=`);
        if (Separator === -1) continue;
        HashCookies.set(
            Cookie.slice(0, Separator).trim(),
            Cookie.slice(Separator + 1).trim()
        );
    }

    console.log(
        `INFO | Client authentication token is ${HashCookies.get(`AuthToken`)}`
    );
    const TokenMatches = HashCookies.get(`AuthToken`) === process.env.AUTH_TOKEN;

    if (!TokenMatches)
    {
        Response.writeHead(401);
        Response.end();

        console.log(`INFO | User unauthorized, served none`);
        return;
    }

    // Only the path and query are used, so the base host is irrelevant (a malformed Host header must not be able to throw here)
    const RequestUrl = new URL(Request.url, `https://localhost`);

    let TargetUrl;
    try
    {
        TargetUrl = new URL(RequestUrl.searchParams.get(`content_url`));
    }
    catch
    {
        console.log(
            `WARN | Rejected request with invalid content_url: ${RequestUrl.searchParams.get(`content_url`)}`
        );
        Response.writeHead(400);
        Response.end();
        return;
    }
    Request.targetUrl = TargetUrl.href; // for error logging in the request handler

    let ForwardHeaders = { ...Request.headers };
    for (let Header of STRIP_REQUEST_HEADERS)
    {
        delete ForwardHeaders[Header];
    }

    let FetchRequestParams = {
        method: Request.method,
        headers: ForwardHeaders,
    };

    if (Request.method === "GET" || Request.method === "HEAD");
    else
    {
        FetchRequestParams.body = Request;
        FetchRequestParams.duplex = "half";
    }

    // searchParams.get() already decodes the value, so it must not be decoded again
    let TargetFetchResponse = await fetch(TargetUrl.href, FetchRequestParams);

    let ResponseHeaders = Object.fromEntries(TargetFetchResponse.headers);
    for (let Header of STRIP_RESPONSE_HEADERS)
    {
        delete ResponseHeaders[Header];
    }
    // Object.fromEntries keeps only the last Set-Cookie header; forward all of them
    const SetCookies = TargetFetchResponse.headers.getSetCookie
        ? TargetFetchResponse.headers.getSetCookie()
        : [];
    if (SetCookies.length > 0) ResponseHeaders[`set-cookie`] = SetCookies;

    // After redirects the final URL differs from the requested one; relative URLs must resolve against the final one
    const FinalUrl = TargetFetchResponse.url || TargetUrl.href;

    // Only text content is rewritten; images, fonts and other binaries pass through untouched
    const ContentType = TargetFetchResponse.headers.get(`content-type`) || ``;
    const IsRewritable =
        ContentType === `` || /html|css|javascript|ecmascript/i.test(ContentType);

    if (!IsRewritable)
    {
        const BinaryContent = Buffer.from(await TargetFetchResponse.arrayBuffer());
        Response.writeHead(TargetFetchResponse.status, ResponseHeaders);
        Response.end(BinaryContent);
        return;
    }

    const BodyContent = await TargetFetchResponse.text();
    let RewrittenBodyContent = "";

    if (BodyContent === "" || BodyContent === null);
    else
    {
        console.log(`INFO | Rewriting content from ${FinalUrl}`);
        RewrittenBodyContent = RewriteContent(BodyContent, FinalUrl, ContentType);
    }

    Response.writeHead(TargetFetchResponse.status, ResponseHeaders);
    Response.end(RewrittenBodyContent);
}

function DispatchAuthCall(Request, Response)
{
    const Cookies = (Request.headers.cookie || ``).split(`;`);
    const HashCookies = new Map();

    for (let Cookie of Cookies)
    {
        const Separator = Cookie.indexOf(`=`);
        if (Separator === -1) continue;
        HashCookies.set(
            Cookie.slice(0, Separator).trim(),
            Cookie.slice(Separator + 1).trim()
        );
    }

    console.log(
        `INFO | Client authentication token is ${HashCookies.get(`AuthToken`)}`
    );
    const TokenMatches = HashCookies.get(`AuthToken`) === process.env.AUTH_TOKEN;

    if (TokenMatches)
    {
        Response.writeHead(200, { "Content-Type": "application/json" });
        Response.end(JSON.stringify({ "auth-success": true }));
        console.log(`INFO | Auth approved`);
    }
    else
    {
        Response.writeHead(200, { "Content-Type": "application/json" });
        Response.end(JSON.stringify({ "auth-success": false }));
        console.log(`INFO | Auth denied`);
    }
}

async function DispatchAuthInitCall(Request, Response)
{
    if (Request.method === `POST`)
    {
        const Chunks = [];

        for await (const Chunk of Request)
        {
            Chunks.push(Chunk);
        }

        let AuthInitCall = Buffer.concat(Chunks).toString("utf8");
        let AuthInitCallJson = JSON.parse(AuthInitCall);
        console.log(
            `INFO | Received auth init request: ${AuthInitCall} | Token received is ${AuthInitCallJson[`auth-token`]}`
        );
        const TokenMatches =
            AuthInitCallJson[`auth-token`] == process.env.AUTH_TOKEN;

        if (TokenMatches)
        {
            console.log(`INFO | Token matches - Setting auth cookie`);
            Response.writeHead(200, {
                "Content-Type": "application/json",
                "Set-Cookie": `AuthToken=${process.env.AUTH_TOKEN}; Max-Age=3600; SameSite=Lax; Path=/`,
            });
            Response.end(JSON.stringify({ "auth-success": true }));
        }
        else
        {
            console.log(`INFO | Taken does not match!`);
            Response.writeHead(200, { "Content-Type": "application/json" });
            Response.end(JSON.stringify({ "auth-success": false }));
        }
    }
    else
    {
        Response.writeHead(400);
        Response.end();
    }
}

async function DispatchPageCall(Request, Response)
{
    const Cookies = (Request.headers.cookie || ``).split(`;`);
    const HashCookies = new Map();

    for (let Cookie of Cookies)
    {
        const Separator = Cookie.indexOf(`=`);
        if (Separator === -1) continue;
        HashCookies.set(
            Cookie.slice(0, Separator).trim(),
            Cookie.slice(Separator + 1).trim()
        );
    }

    console.log(
        `INFO | Client authentication token is ${HashCookies.get(`AuthToken`)}`
    );
    const TokenMatches = HashCookies.get(`AuthToken`) === process.env.AUTH_TOKEN;

    if (!TokenMatches)
    {
        Response.writeHead(401);
        Response.end();

        console.log(`INFO | User unauthorized, served none`);
        return;
    }

    Response.writeHead(200, {
        "Content-Type": "text/html",
    });
    Response.end((await readFile("./Public/Index.html", "utf8")).toString());

    console.log(`INFO | User authorized, served Main`);
    return;
}

const SslOptions = {
  "key": fs.readFileSync(path.join("./Certs/", 'key.pem')),
  "cert": fs.readFileSync(path.join("./Certs/", 'cert.pem'))
};

const server = https.createServer(SslOptions, (Request, Response) =>
{
    let RequestUrl;
    try
    {
        RequestUrl = new URL(Request.url, `https://localhost`);
    }
    catch
    {
        Response.writeHead(400);
        Response.end();
        return;
    }
    console.log(`INFO | New request: ${RequestUrl.href}`);

    Response.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND);
    Response.setHeader("Access-Control-Allow-Methods", "*");
    Response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Host, Accept, Cookie, Set-Cookie, hx-boosted, hx-current-url, hx-history-restore-request, hx-prompt, hx-request, hx-target, hx-trigger, hx-trigger-name, hx-location, hx-push-url, hx-redirect, hx-refresh, hx-replace-url, hx-reswap, hx-retarget, hx-reselect, hx-trigger-after-settle, hx-trigger-after-swap"
    );
    Response.setHeader(
      "Access-Control-Expose-Headers", "HX-Trigger, HX-Location, HX-Refresh, HX-Redirect, HX-Push-Url, HX-Replace-Url, HX-Retarget, HX-Reswap, HX-Reselect, HX-Trigger-After-Swap, HX-Trigger-After-Settle, HX-Push"
    );
    Response.setHeader("Access-Control-Allow-Credentials", true);

    if (Request.method === `OPTIONS`)
    {
        console.log(`INFO | Handling CORS preflight`);
        Response.writeHead(204);
        Response.end();
    }
    else if (RequestUrl.pathname.startsWith(`/api/proxy`))
    {
        DispatchProxyCall(Request, Response).catch((Err) =>
        {
            console.log(
                `ERROR | Proxy call failed for ${Request.targetUrl || Request.url}: ${(Err && Err.stack) || Err}`
            );
            if (Err && Err.cause) console.log(`ERROR | Cause: ${Err.cause}`);
            if (!Response.headersSent) Response.writeHead(502);
            Response.end();
        });
    }
    else if (RequestUrl.pathname.startsWith(`/api/auth`))
    {
        DispatchAuthCall(Request, Response);
    }
    else if (RequestUrl.pathname.startsWith(`/api/initauth`))
    {
        console.log(`INFO | Received init auth request, proceeding with dispatch`);
        DispatchAuthInitCall(Request, Response);
    }
    else if (RequestUrl.pathname.startsWith(`/Main`))
    {
        console.log(`INFO | Serving main proxy page`);
        DispatchPageCall(Request, Response);
    }
    else if (RequestUrl.pathname.startsWith(`/health`)) {
        console.log(`INFO | Received health check`);
        Response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8"
        });
        Response.end(`ok`);
    }
    else
    {
        Response.writeHead(404);
        Response.end();
    }
});

const PORT = process.env.PORT;
// server.listen(PORT, `0.0.0.0`, () =>
// {
//     console.log(
//         `INFO | Server started at port ${PORT} | Auth token is ${process.env.AUTH_TOKEN}`
//     );
// });

const LegacyServer = http.createServer((Request, Response) => {
    let RequestUrl;
    try
    {
        RequestUrl = new URL(Request.url, `http://localhost`);
    }
    catch
    {
        Response.writeHead(400);
        Response.end();
        return;
    }
    console.log(`|LEGACY| INFO | New request: ${RequestUrl.href}`);

    if (RequestUrl.pathname.startsWith(`/health`)) {
        console.log(`INFO | Received health check`);
        Response.writeHead(200, {
            "Content-Type": "text/plain; charset=utf-8"
        });
        Response.end(`ok`);
    }
    else if(RequestUrl.pathname.startsWith(`.well-known/acme-challenge/uzXEmBYaNvkWdMxZdzXF_soRe36YxHJUaeAY6Avrc-A`)) {
        Response.writeHead(200);
        Response.end(`uzXEmBYaNvkWdMxZdzXF_soRe36YxHJUaeAY6Avrc-A.OLL3X3EDq7nmnSVCcscSKwYlXTOT6GSTXcTuIgnXY60`);
    }
    else {
        Response.writeHead(200);
        Response.end();
    }
});

LegacyServer.listen(80, `0.0.0.0`, () => {
    console.log(`|LEGACY| INFO | Started legacy http support server`);
})