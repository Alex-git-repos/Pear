const net = require('net');
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { readFile } = require("fs/promises");
const { RewriteContent, GetFrontend } = require("./Inject.js");

// Hop-by-hop / encoding headers that must not be forwarded as-is
const STRIP_REQUEST_HEADERS = [`host`, `connection`, `accept-encoding`];
const STRIP_RESPONSE_HEADERS = [
    `content-encoding`,
    `content-length`,
    `transfer-encoding`,
    `connection`,
];

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

// The passkey users type in at the login page. Fail closed: with no passkey configured,
// `undefined === undefined` would otherwise let every request through.
const AUTH_TOKEN = process.env.AUTH_TOKEN || ``;
if (AUTH_TOKEN === ``)
{
    console.error(`FATAL | AUTH_TOKEN environment variable is not set, refusing to start`);
    process.exit(1);
}
if (AUTH_TOKEN.length < 16)
{
    console.warn(`WARN | AUTH_TOKEN is shorter than 16 characters; use a long random value`);
}

// CORS needs a bare origin ("https://host"), never a URL with a path, trailing slash or quotes.
let FrontendOrigin;
try
{
    FrontendOrigin = new URL(GetFrontend()).origin;
}
catch (Err)
{
    console.error(`FATAL | ${Err.message}`);
    process.exit(1);
}

const SESSION_COOKIE = `AuthToken`;
const SESSION_TTL_SECONDS = 3600;
const MAX_AUTH_BODY_BYTES = 4096;

// Constant-time string comparison (hashing first makes both buffers the same length).
function SafeEqual(A, B)
{
    const HashA = crypto.createHash(`sha256`).update(String(A)).digest();
    const HashB = crypto.createHash(`sha256`).update(String(B)).digest();
    return crypto.timingSafeEqual(HashA, HashB);
}

// The session cookie is "<expiry-unix-seconds>.<HMAC>", signed with the passkey. The passkey itself
// never leaves the server, a stolen cookie stops working after SESSION_TTL_SECONDS, and sessions
// survive restarts (no server-side state).
function SignSession(Expires)
{
    return crypto
        .createHmac(`sha256`, AUTH_TOKEN)
        .update(`pear-session:${Expires}`)
        .digest(`base64url`);
}

function CreateSessionToken()
{
    const Expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    return `${Expires}.${SignSession(Expires)}`;
}

function IsValidSessionToken(Token)
{
    if (typeof Token !== `string`) return false;
    const Dot = Token.indexOf(`.`);
    if (Dot === -1) return false;

    const Expires = Token.slice(0, Dot);
    if (!/^\d{1,12}$/.test(Expires)) return false;
    if (Number(Expires) <= Math.floor(Date.now() / 1000)) return false;

    return SafeEqual(Token.slice(Dot + 1), SignSession(Expires));
}

function ParseCookies(Request)
{
    const HashCookies = new Map();

    for (let Cookie of (Request.headers.cookie || ``).split(`;`))
    {
        const Separator = Cookie.indexOf(`=`);
        if (Separator === -1) continue;
        HashCookies.set(
            Cookie.slice(0, Separator).trim(),
            Cookie.slice(Separator + 1).trim()
        );
    }
    return HashCookies;
}

function IsAuthenticated(Request)
{
    return IsValidSessionToken(ParseCookies(Request).get(SESSION_COOKIE));
}

// The frontend (S3) and backend are different sites, so the cookie is a cross-site cookie:
// browsers only store and send it with SameSite=None, which in turn requires Secure.
function SessionCookieHeader(Token)
{
    return `${SESSION_COOKIE}=${Token}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=None`;
}

// Our session cookie must never be sent to, or overwritten by, the sites being proxied.
function RemoveCookie(CookieHeader, Name)
{
    return CookieHeader
        .split(`;`)
        .filter((Pair) => Pair.split(`=`)[0].trim() !== Name)
        .join(`;`)
        .trim();
}

async function ReadJsonBody(Request, Limit)
{
    const Chunks = [];
    let Size = 0;

    for await (const Chunk of Request)
    {
        Size += Chunk.length;
        if (Size > Limit) throw new Error(`Body too large`);
        Chunks.push(Chunk);
    }
    return JSON.parse(Buffer.concat(Chunks).toString(`utf8`));
}

async function DispatchProxyCall(Request, Response)
{
    if (!IsAuthenticated(Request))
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
    // Do not leak our session cookie to the target site
    if (ForwardHeaders.cookie)
    {
        const RemainingCookies = RemoveCookie(ForwardHeaders.cookie, SESSION_COOKIE);
        if (RemainingCookies) ForwardHeaders.cookie = RemainingCookies;
        else delete ForwardHeaders.cookie;
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
    // Object.fromEntries keeps only the last Set-Cookie header; forward all of them,
    // except any attempt by the target site to overwrite our session cookie
    const RawSetCookies = TargetFetchResponse.headers.getSetCookie
        ? TargetFetchResponse.headers.getSetCookie()
        : (ResponseHeaders[`set-cookie`] ? [ResponseHeaders[`set-cookie`]] : []);
    delete ResponseHeaders[`set-cookie`];
    const SetCookies = RawSetCookies.filter(
        (Cookie) => !Cookie.trim().startsWith(`${SESSION_COOKIE}=`)
    );
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
    const Authenticated = IsAuthenticated(Request);

    Response.writeHead(200, { "Content-Type": "application/json" });
    Response.end(JSON.stringify({ "auth-success": Authenticated }));
    console.log(Authenticated ? `INFO | Auth approved` : `INFO | Auth denied`);
}

async function DispatchAuthInitCall(Request, Response)
{
    if (Request.method !== `POST`)
    {
        Response.writeHead(400);
        Response.end();
        return;
    }

    let AuthInitCallJson;
    try
    {
        AuthInitCallJson = await ReadJsonBody(Request, MAX_AUTH_BODY_BYTES);
    }
    catch
    {
        console.log(`WARN | Rejected malformed or oversized auth init request`);
        Response.writeHead(400);
        Response.end();
        return;
    }

    // Only a non-empty string can match; {} / null / numbers must never be accepted
    const Candidate = AuthInitCallJson && AuthInitCallJson[`auth-token`];
    const TokenMatches =
        typeof Candidate === `string` && Candidate !== `` && SafeEqual(Candidate, AUTH_TOKEN);

    if (TokenMatches)
    {
        console.log(`INFO | Token matches - Setting auth cookie`);
        Response.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": SessionCookieHeader(CreateSessionToken()),
        });
        Response.end(JSON.stringify({ "auth-success": true }));
    }
    else
    {
        console.log(`INFO | Token does not match!`);
        Response.writeHead(200, { "Content-Type": "application/json" });
        Response.end(JSON.stringify({ "auth-success": false }));
    }
}

async function DispatchPageCall(Request, Response)
{
    if (!IsAuthenticated(Request))
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
  "key": fs.readFileSync(path.join("./Certs/", 'privkey.pem')),
  "cert": fs.readFileSync(path.join("./Certs/", 'fullchain.pem'))
};

// Shared by the HTTPS and the plain-HTTP listener. On Render, TLS is terminated at the edge and the
// request reaches this process as plain HTTP, so BOTH listeners must run the real handler (CORS, auth, proxy).
function HandleRequest(Request, Response)
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

    Response.setHeader("Access-Control-Allow-Origin", FrontendOrigin);
    Response.setHeader("Vary", "Origin");
    // "*" is not honoured for credentialed requests, so the methods are listed explicitly
    Response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
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
        DispatchAuthInitCall(Request, Response).catch((Err) =>
        {
            console.log(`ERROR | Auth init failed: ${(Err && Err.stack) || Err}`);
            if (!Response.headersSent) Response.writeHead(500);
            Response.end();
        });
    }
    else if (RequestUrl.pathname.startsWith(`/Main`))
    {
        console.log(`INFO | Serving main proxy page`);
        DispatchPageCall(Request, Response).catch((Err) =>
        {
            console.log(`ERROR | Page call failed: ${(Err && Err.stack) || Err}`);
            if (!Response.headersSent) Response.writeHead(500);
            Response.end();
        });
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
}

const Server = https.createServer(SslOptions, HandleRequest);

// Plain HTTP (what Render's proxy sends). Previously this answered an empty 200 to everything except
// /health, so browser requests got no CORS headers and never reached the auth/proxy handlers.
const LegacyServer = http.createServer(HandleRequest);

const PORT = process.env.PORT;
const MasterServer = net.createServer((socket) => {
    socket.once('data', (buffer) => {
    // Put the data back into the socket stream so the HTTP/HTTPS parsers can read it
    socket.unshift(buffer);

    // Byte 22 (0x16) indicates a TLS Handshake
    if (buffer[0] === 22) {
      Server.emit('connection', socket);
    } else {
      LegacyServer.emit('connection', socket);
    }
  });

  socket.on('error', (err) => {
    // Handle socket errors gracefully to avoid server crashes
    console.error('ERR | Socket error:', err);
  });
});

MasterServer.listen(PORT, () => {
    console.log(
        `INFO | Server started at port ${PORT} | Allowing frontend origin ${FrontendOrigin}`
    );
})