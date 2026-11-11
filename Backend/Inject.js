const {XXHash64} = require("xxhash-addon");

/*
 * Content rewriter for the proxy.
 *
 *  - HTML: hashes id/class (and attributes that reference ids), proxies src/href/etc.,
 *          processes inline <style>, <script>, style="" and on*="" attributes, drops <base>,
 *          and injects a small runtime shim that routes fetch()/XHR through the proxy.
 *  - CSS:  hashes class/id selectors (only inside selector preludes, never in declaration values),
 *          proxies url() and @import.
 *  - JS:   hashes the common DOM lookups (getElementById, querySelector, classList, className, ...)
 *          and proxies relative/absolute ES module imports.
 *
 * Every hash goes through HashName(), so HTML, CSS and JS always agree with each other.
 * Set PROXY_DEBUG=1 for verbose logging.
 */

const DEBUG = process.env.PROXY_DEBUG === "1";
function Debug(...Args) {
  if(DEBUG) console.log("DEBUG |", ...Args);
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

const HashCache = new Map();

// "h" prefix: CSS identifiers cannot start with a digit, and a raw hash might.
function HashName(Name) {
  let Hashed = HashCache.get(Name);
  if(Hashed === undefined) {
    Hashed = "h" + XXHash64.hash(Buffer.from(Name, "utf8")).toString("hex");
    if(HashCache.size > 100000) HashCache.clear();
    HashCache.set(Name, Hashed);
  }
  return Hashed;
}

// Hash every whitespace-separated token, keeping the original whitespace intact.
function HashTokens(Value) {
  return Value.replace(/\S+/g, (Token) => HashName(Token));
}

// CSS escapes (".sm\:flex" -> "sm:flex") so the CSS side hashes the same string the HTML side does.
function UnescapeCss(Ident) {
  return Ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (Match, Hex, Char) => {
    if(Hex === undefined) return Char;
    const CodePoint = parseInt(Hex, 16);
    return (CodePoint === 0 || CodePoint > 0x10FFFF) ? "\uFFFD" : String.fromCodePoint(CodePoint);
  });
}

// ---------------------------------------------------------------------------
// URL proxying
// ---------------------------------------------------------------------------

function GetBackend() {
  // Windows `set BACKEND="http://..."` keeps the quotes (and any trailing space) in the value
  const Backend = (process.env.BACKEND || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if(!Backend) throw new Error("BACKEND environment variable is not set");
  if(!/^https?:\/\//i.test(Backend)) {
    throw new Error(`BACKEND must be a full URL including http:// or https:// (got "${Backend}")`);
  }
  return Backend.endsWith("/") ? Backend : Backend + "/";
}

function GetFrontend() {
  // Windows `set BACKEND="http://..."` keeps the quotes (and any trailing space) in the value
  const Frontend = (process.env.FRONTEND || "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if(!Frontend) throw new Error("FRONTEND environment variable is not set");
  if(!/^https?:\/\//i.test(Frontend)) {
    throw new Error(`FRONTEND must be a full URL including http:// or https:// (got "${Frontend}")`);
  }
  return Frontend.endsWith("/") ? Frontend : Frontend + "/";
}

function ProxyEndpoint() {
  return new URL("api/proxy", GetBackend());
}

// The frontend page that displays proxied webpages: [frontend]/Main.html
function MainPage() {
  return new URL("Main.html", GetFrontend());
}

function DecodeAmp(Value) {
  return Value.replace(/&amp;/gi, "&");
}

const SIMPLE_FRAGMENT = /^#[\w-]+$/;

// Returns Raw unchanged whenever the value should not be proxied.
// IsPage = true for webpage (navigation) URLs: <a>/<area> links, form actions, window.open.
//   Those become  [frontend]/Main.html?resource_uri=<original page url>   (FRONTEND env var)
// IsPage = false for resources (img, script, css, fetch, ...): those stay  [backend]/api/proxy?content_url=...
function ProxyUrl(Raw, BaseUrl, IsPage = false) {
  if(typeof Raw !== "string") return Raw;
  const Trimmed = Raw.trim();
  if(Trimmed === "") return Raw;

  // In-page anchors point at (hashed) ids.
  if(SIMPLE_FRAGMENT.test(Trimmed)) return "#" + HashName(Trimmed.slice(1));
  if(/^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(Trimmed)) return Raw;

  let Resolved;
  try {
    Resolved = new URL(Trimmed, BaseUrl);
  } catch {
    return Raw;
  }
  if(Resolved.protocol !== "http:" && Resolved.protocol !== "https:") return Raw;

  const Main = MainPage();
  if(IsPage && Resolved.origin === Main.origin && Resolved.pathname === Main.pathname) return Raw; // already wrapped

  const Endpoint = ProxyEndpoint();
  const AlreadyProxied = Resolved.origin === Endpoint.origin && Resolved.pathname === Endpoint.pathname;
  if(AlreadyProxied && !IsPage) return Raw;

  const Fragment = Resolved.hash;
  Resolved.hash = "";
  const NewFragment = SIMPLE_FRAGMENT.test(Fragment) ? "#" + HashName(Fragment.slice(1)) : Fragment;

  if(!IsPage) {
    // searchParams.set() already percent-encodes; do NOT encodeURIComponent first.
    // (The server must therefore not decodeURIComponent the value a second time.)
    Endpoint.searchParams.set("content_url", Resolved.href);
    Endpoint.hash = NewFragment;
    return Endpoint.href;
  }

  // Page: resource_uri carries the ORIGINAL page URL (the frontend is responsible for fetching it through
  // the backend proxy). If the link already points at the backend proxy, unwrap its content_url.
  let Target = Resolved.href;
  if(AlreadyProxied) {
    const Inner = Resolved.searchParams.get("content_url");
    if(!Inner) return Raw;
    Target = Inner;
  }
  // searchParams.set() percent-encodes the target (http%3A%2F%2Fexample.com%2F).
  Main.searchParams.set("resource_uri", Target);
  Main.hash = NewFragment;
  return Main.href;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

// Alternatives, in order:
//  1 comment | 2 string | 3-7 [class/id=...] | (any other [attr]) | 8-9 .class / #id
const SELECTOR_TOKEN = new RegExp(
  String.raw`(\/\*[\s\S]*?\*\/)` +
  String.raw`|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')` +
  String.raw`|\[\s*(class|id)\s*(~?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]"']+))\s*\]` +
  String.raw`|\[[^\]]*\]` +
  String.raw`|([.#])(-?(?:[_a-zA-Z\u00A0-\uFFFF]|\\[\s\S])(?:[\w\u00A0-\uFFFF-]|\\[\s\S])*)`,
  "g"
);

function RewriteSelectorText(Text) {
  return Text.replace(SELECTOR_TOKEN, (Match, Comment, Str, AttrName, Op, Dq, Sq, Unq, Sigil, Ident) => {
    if(Sigil !== undefined) return Sigil + HashName(UnescapeCss(Ident));
    if(AttrName !== undefined) {
      const Value = Dq ?? Sq ?? Unq;
      const Quote = Sq !== undefined ? "'" : '"';
      return `[${AttrName}${Op}${Quote}${HashTokens(Value)}${Quote}]`;
    }
    return Match; // comments, strings, other attribute selectors
  });
}

function SkipCssString(Css, Start) {
  const Quote = Css[Start];
  let I = Start + 1;
  while(I < Css.length) {
    if(Css[I] === "\\") I += 2;
    else if(Css[I] === Quote) return I + 1;
    else if(Css[I] === "\n") return I; // unterminated
    else I++;
  }
  return Css.length;
}

// Only text that is followed by "{" is a selector prelude. Declarations end with ";" or "}",
// so values like "#fff" or "0.5em" are never touched. Works for nested rules too.
function RewriteCssSelectors(Css) {
  let Out = "";
  let Start = 0;
  let ParenDepth = 0;
  let I = 0;

  while(I < Css.length) {
    const C = Css[I];

    if(C === "/" && Css[I + 1] === "*") {
      const End = Css.indexOf("*/", I + 2);
      I = End === -1 ? Css.length : End + 2;
      continue;
    }
    if(C === `"` || C === `'`) { I = SkipCssString(Css, I); continue; }
    if(C === "\\") { I += 2; continue; }

    if(C === "(") ParenDepth++;
    else if(C === ")") ParenDepth = Math.max(0, ParenDepth - 1);
    else if(ParenDepth === 0) {
      if(C === "{") {
        const Prelude = Css.slice(Start, I);
        const IsAtRule = /^\s*@/.test(Prelude);
        Out += (!IsAtRule || /^\s*@scope\b/i.test(Prelude) ? RewriteSelectorText(Prelude) : Prelude) + "{";
        Start = I + 1;
      }
      else if(C === ";" || C === "}") {
        Out += Css.slice(Start, I + 1);
        Start = I + 1;
      }
    }
    I++;
  }
  return Out + Css.slice(Start);
}

function RewriteCssUrls(Css, BaseUrl) {
  return Css
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s][^)]*?))\s*\)/gi, (Match, Dq, Sq, Unq) => {
      const Raw = Dq ?? Sq ?? Unq;
      const Proxied = ProxyUrl(Raw, BaseUrl);
      return Proxied === Raw ? Match : `url(${Proxied})`; // proxied URLs are fully percent-encoded, so no quotes needed
    })
    .replace(/@import\s+(?:"([^"]*)"|'([^']*)')/gi, (Match, Dq, Sq) => {
      const Raw = Dq ?? Sq;
      const Proxied = ProxyUrl(Raw, BaseUrl);
      return Proxied === Raw ? Match : `@import url(${Proxied})`;
    });
}

function RewriteCss(Css, BaseUrl) {
  return RewriteCssUrls(RewriteCssSelectors(Css), BaseUrl);
}

// ---------------------------------------------------------------------------
// JS (heuristic: only string-literal arguments of well-known DOM APIs)
// ---------------------------------------------------------------------------

const JS_SELECTOR_CALL = /(\.\s*)(getElementById|getElementsByClassName|querySelectorAll|querySelector|closest|matches)\s*\(\s*(["'`])((?:\\.|(?!\3)[^\\\n])*)\3/g;
const JS_CLASSLIST_CALL = /(\.\s*classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\()([^()]*)\)/g;
const JS_CLASSNAME = /(\.\s*className\s*\+?=\s*|\bclassName\s*:\s*)(["'])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const JS_SETATTRIBUTE = /(\.\s*setAttribute\s*\(\s*)(["'])(class|id)\2(\s*,\s*)(["'])((?:\\.|(?!\5)[^\\\n])*)\5/g;
const JS_STATIC_IMPORT = /\b((?:import|export)\b[^"'`;()=]*?\bfrom\s*|import\s*)(["'])([^"'\n]+)\2/g;
const JS_DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const MODULE_SPECIFIER = /^(\.{0,2}\/|https?:\/\/)/; // bare specifiers need an import map, so leave them

function RewriteJs(Js, BaseUrl) {
  let Out = Js;

  Out = Out.replace(JS_SELECTOR_CALL, (Match, Dot, Method, Quote, Value) => {
    if(Value.includes("\\") || Value.includes("${")) return Match;
    let Rewritten;
    if(Method === "getElementById") Rewritten = HashName(Value);
    else if(Method === "getElementsByClassName") Rewritten = HashTokens(Value);
    else Rewritten = RewriteSelectorText(Value);
    return `${Dot}${Method}(${Quote}${Rewritten}${Quote}`;
  });

  Out = Out.replace(JS_CLASSLIST_CALL, (Match, Head, Args) =>
    Head + Args.replace(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g, (Str, Quote, Value) =>
      Value.includes("\\") ? Str : Quote + HashTokens(Value) + Quote) + ")");

  Out = Out.replace(JS_CLASSNAME, (Match, Head, Quote, Value) =>
    Value.includes("\\") ? Match : Head + Quote + HashTokens(Value) + Quote);

  Out = Out.replace(JS_SETATTRIBUTE, (Match, Head, Q1, Attr, Comma, Q2, Value) => {
    if(Value.includes("\\")) return Match;
    const Rewritten = Attr === "class" ? HashTokens(Value) : HashName(Value);
    return `${Head}${Q1}${Attr}${Q1}${Comma}${Q2}${Rewritten}${Q2}`;
  });

  Out = Out.replace(JS_STATIC_IMPORT, (Match, Head, Quote, Spec) =>
    MODULE_SPECIFIER.test(Spec) ? Head + Quote + ProxyUrl(Spec, BaseUrl) + Quote : Match);

  Out = Out.replace(JS_DYNAMIC_IMPORT, (Match, Quote, Spec) =>
    MODULE_SPECIFIER.test(Spec) ? `import(${Quote}${ProxyUrl(Spec, BaseUrl)}${Quote})` : Match);

  return Out;
}

// Runtime shim. URLs that scripts build at runtime can't be rewritten statically, so this code runs in the
// browser (before any page script) and patches the APIs that create or change them:
//  - fetch / XMLHttpRequest / window.open
//  - href/src/action property setters and setAttribute() on <a>, <img>, <script>, <link>, <iframe>, ...
//  - a MutationObserver as a safety net for markup inserted as strings (innerHTML, insertAdjacentHTML, ...)
// It is shipped to the browser via ShimMain.toString(), so it must be fully self-contained.
function ShimMain(C) {
  var SKIP = /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i;

  // Page = true for webpage (navigation) URLs -> [frontend]/Main.html?resource_uri=<original url>
  // Page = false for resources -> [backend]/api/proxy?content_url=<url>
  function P(U, Page) {
    try {
      var S = String(U);
      if (S.trim() === "" || SKIP.test(S.trim())) return U;
      var A = new URL(S, C.Base);
      if (A.protocol !== "http:" && A.protocol !== "https:") return U;
      if (Page && A.origin + A.pathname === C.Main) return U; // already wrapped
      var Already = A.href.indexOf(C.Proxy) === 0;
      if (Already && !Page) return U; // already proxied
      var H = A.hash;
      A.hash = "";
      if (Page) {
        var T = A.href;
        if (Already) {
          T = A.searchParams.get("content_url");
          if (!T) return U;
        }
        return C.Main + "?resource_uri=" + encodeURIComponent(T) + H;
      }
      return C.Proxy + "?content_url=" + encodeURIComponent(A.href) + H;
    } catch (E) {
      return U;
    }
  }

  // Which attribute carries the URL for which element
  var ATTR = {A: "href", AREA: "href", LINK: "href", IMG: "src", SCRIPT: "src", IFRAME: "src", SOURCE: "src",
              VIDEO: "src", AUDIO: "src", EMBED: "src", TRACK: "src", FORM: "action"};
  // Elements whose URL attribute is a webpage (navigation), not a resource
  var PAGE = {A: 1, AREA: 1, FORM: 1};

  // fetch
  var F = window.fetch;
  if (F) {
    window.fetch = function (I, O) {
      try {
        if (typeof I === "string" || I instanceof URL) I = P(I);
        else if (I && I.url) I = new Request(P(I.url), I);
      } catch (E) {}
      return F.call(this, I, O);
    };
  }

  // XMLHttpRequest
  var X = window.XMLHttpRequest && XMLHttpRequest.prototype.open;
  if (X) {
    XMLHttpRequest.prototype.open = function (M, U) {
      var A = Array.prototype.slice.call(arguments);
      A[1] = P(U);
      return X.apply(this, A);
    };
  }

  // window.open
  var WO = window.open;
  if (WO) {
    window.open = function (U) {
      var A = Array.prototype.slice.call(arguments);
      if (A[0]) A[0] = P(A[0], true);
      return WO.apply(this, A);
    };
  }

  // el.href = ..., img.src = ..., form.action = ...
  [["HTMLAnchorElement", "href", true], ["HTMLAreaElement", "href", true], ["HTMLLinkElement", "href"],
   ["HTMLImageElement", "src"], ["HTMLScriptElement", "src"], ["HTMLIFrameElement", "src"],
   ["HTMLSourceElement", "src"], ["HTMLMediaElement", "src"], ["HTMLEmbedElement", "src"],
   ["HTMLTrackElement", "src"], ["HTMLFormElement", "action", true]].forEach(function (Pair) {
    try {
      var Ctor = window[Pair[0]];
      if (!Ctor) return;
      var D = Object.getOwnPropertyDescriptor(Ctor.prototype, Pair[1]);
      if (!D || !D.set) return;
      Object.defineProperty(Ctor.prototype, Pair[1], {
        configurable: true,
        enumerable: D.enumerable,
        get: D.get,
        set: function (V) { D.set.call(this, P(V, !!Pair[2])); }
      });
    } catch (E) {}
  });

  // el.setAttribute("href", ...)
  var SA = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (N, V) {
    try {
      if (typeof N === "string" && ATTR[this.tagName] === N.toLowerCase()) V = P(V, !!PAGE[this.tagName]);
    } catch (E) {}
    return SA.call(this, N, V);
  };

  // Markup inserted as a string: fix the attributes after the fact
  function Fix(El) {
    try {
      var Name = ATTR[El.tagName];
      if (!Name) return;
      var V = El.getAttribute(Name);
      if (V === null) return;
      var N = P(V, !!PAGE[El.tagName]);
      if (N !== V) SA.call(El, Name, N);
    } catch (E) {}
  }
  var SELECTOR = "a[href],area[href],link[href],img[src],script[src],iframe[src],source[src],video[src],audio[src],embed[src],track[src],form[action]";
  new MutationObserver(function (Records) {
    for (var I = 0; I < Records.length; I++) {
      var Added = Records[I].addedNodes;
      for (var J = 0; J < Added.length; J++) {
        var Node = Added[J];
        if (Node.nodeType !== 1) continue;
        Fix(Node);
        var Found = Node.querySelectorAll ? Node.querySelectorAll(SELECTOR) : [];
        for (var K = 0; K < Found.length; K++) Fix(Found[K]);
      }
    }
  }).observe(document, {childList: true, subtree: true});
}

function BuildShim(BaseUrl) {
  const Main = MainPage();
  const Config = JSON.stringify({
    Base: BaseUrl,
    Proxy: ProxyEndpoint().href,
    Main: Main.origin + Main.pathname // [frontend]/Main.html, no query
  }).replace(/</g, "\\u003c");
  return "(" + ShimMain.toString() + ")(" + Config + ");";
}

function InjectShim(Html, BaseUrl) {
  const Shim = `<script>${BuildShim(BaseUrl)}</script>`;
  for(const Pattern of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const Match = Pattern.exec(Html);
    if(Match) {
      const At = Match.index + Match[0].length;
      return Html.slice(0, At) + Shim + Html.slice(At);
    }
  }
  return Html; // fragment, not a full document
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "action", "formaction"]);
const ID_REF_ATTRS = new Set([
  "for", "form", "list", "headers", "popovertarget",
  "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns",
  "aria-activedescendant", "aria-details", "aria-errormessage", "aria-flowto"
]);

// name [= "value" | 'value' | value]
const ATTR_REGEX = /([^\s"'<>\/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// 1: comment (no groups) | 2-4: <style>/<script> block | 5-6: any other opening tag
const HTML_TOKEN = /<!--[\s\S]*?-->|<(style|script)(?=[\s\/>])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;

function RewriteSrcset(Value, BaseUrl) {
  // Tokens alternate URL / descriptor; a trailing comma marks the end of a candidate.
  // (URLs containing commas are fine, as long as they are not followed by whitespace.)
  let ExpectUrl = true;
  return Value.replace(/\S+/g, (Token) => {
    if(!ExpectUrl) {
      ExpectUrl = Token.endsWith(",");
      return Token;
    }
    const Comma = Token.endsWith(",") ? "," : "";
    ExpectUrl = Comma !== "";
    return ProxyUrl(Comma ? Token.slice(0, -1) : Token, BaseUrl) + Comma;
  });
}

// Is this attribute a webpage (navigation) URL rather than a resource URL?
function IsPageAttr(TagName, Lower) {
  const Tag = (TagName || "").toLowerCase();
  if(Lower === "formaction") return true;
  if((Tag === "a" || Tag === "area") && (Lower === "href" || Lower === "xlink:href")) return true;
  if(Tag === "form" && Lower === "action") return true;
  return false;
}

function RewriteAttributes(AttrText, BaseUrl, TagName) {
  return AttrText.replace(ATTR_REGEX, (Match, Name, Eq, Dq, Sq, Unq) => {
    if(Eq === undefined) return Match; // boolean attribute

    const Lower = Name.toLowerCase();
    const Value = Dq ?? Sq ?? Unq;
    const Quote = Sq !== undefined ? "'" : '"';
    let Rewritten = Value;

    if(Lower === "integrity") return ""; // the content changes, so SRI would always fail
    else if(Lower === "class") Rewritten = HashTokens(Value);
    else if(Lower === "id") Rewritten = Value === "" ? Value : HashName(Value);
    else if(ID_REF_ATTRS.has(Lower)) Rewritten = HashTokens(Value);
    else if(Lower === "srcset" || Lower === "imagesrcset") Rewritten = RewriteSrcset(Value, BaseUrl);
    else if(URL_ATTRS.has(Lower)) {
      // Note: <form method="get" action> drops the query string on submit, so GET forms won't survive the proxy.
      const Decoded = DecodeAmp(Value);
      const Proxied = ProxyUrl(Decoded, BaseUrl, IsPageAttr(TagName, Lower));
      Rewritten = Proxied === Decoded ? Value : Proxied;
    }
    else if(Lower === "style") Rewritten = RewriteCssUrls(Value, BaseUrl);
    else if(Lower.length > 2 && Lower.startsWith("on")) Rewritten = RewriteJs(Value, BaseUrl);

    return `${Name}${Eq}${Quote}${Rewritten}${Quote}`;
  });
}

function IsJsScript(AttrText) {
  const TypeMatch = AttrText.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if(!TypeMatch) return true;
  const Type = (TypeMatch[1] ?? TypeMatch[2] ?? TypeMatch[3]).trim().toLowerCase();
  return Type === "" || Type === "module" || /(java|ecma)script/.test(Type); // skips json, importmap, templates, ...
}

function RewriteHtml(Html, OriginUrl) {
  // The document base (used to resolve every relative URL)
  let BaseUrl = OriginUrl;
  const BaseMatch = Html.match(/<base\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if(BaseMatch) {
    try {
      BaseUrl = new URL(DecodeAmp(BaseMatch[1] ?? BaseMatch[2] ?? BaseMatch[3]), OriginUrl).href;
    } catch {
      BaseUrl = OriginUrl;
    }
  }
  Debug("Base Url identified as", BaseUrl);

  let Out = Html.replace(HTML_TOKEN, (Match, BlockName, BlockAttrs, BlockBody, TagName, TagAttrs) => {
    if(BlockName !== undefined) {
      let Body = BlockBody;
      if(BlockName.toLowerCase() === "style") Body = RewriteCss(Body, BaseUrl);
      else if(IsJsScript(BlockAttrs)) Body = RewriteJs(Body, BaseUrl);
      return `<${BlockName}${RewriteAttributes(BlockAttrs, BaseUrl, BlockName)}>${Body}</${BlockName}>`;
    }
    if(TagName !== undefined) {
      if(TagName.toLowerCase() === "base") return ""; // everything is absolute now
      return `<${TagName}${RewriteAttributes(TagAttrs, BaseUrl, TagName)}>`;
    }
    return Match; // comment
  });

  return InjectShim(Out, BaseUrl);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function DetectKind(ContentType, UrlString, Body) {
  const Type = (ContentType || "").split(";")[0].trim().toLowerCase();
  if(Type) {
    if(Type.includes("html")) return "html";
    if(Type.includes("css")) return "css";
    if(/(java|ecma)script/.test(Type)) return "js";
    return null; // images, json, fonts, ...
  }

  let Path = "";
  try { Path = new URL(UrlString).pathname.toLowerCase(); } catch {}
  if(/\.(html?|xhtml)$/.test(Path)) return "html";
  if(Path.endsWith(".css")) return "css";
  if(/\.(m?js|cjs)$/.test(Path)) return "js";
  if(/^\s*(<!doctype\s+html|<html|<head|<body)/i.test(Body.slice(0, 512))) return "html";
  return null;
}

/**
 * @param {string} BodyContent     response body as text
 * @param {string} OriginUrlString URL the body was fetched from
 * @param {string} [ContentType]   upstream Content-Type header (strongly recommended)
 */
function RewriteContent(BodyContent, OriginUrlString, ContentType) {
  if(typeof BodyContent !== "string" || BodyContent === "") return BodyContent;

  const Kind = DetectKind(ContentType, OriginUrlString, BodyContent);
  Debug(`Rewriting ${OriginUrlString} as ${Kind ?? "passthrough"}`);

  switch(Kind) {
    case "html": return RewriteHtml(BodyContent, OriginUrlString);
    case "css": return RewriteCss(BodyContent, OriginUrlString);
    case "js": return RewriteJs(BodyContent, OriginUrlString);
    default: return BodyContent;
  }
}

module.exports = {RewriteContent, HashName, GetFrontend};