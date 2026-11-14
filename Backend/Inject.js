const {XXHash64} = require("xxhash-addon");

/*
 * Content rewriter for the proxy.
 *
 *  - HTML: hashes id/class (and attributes that reference ids), proxies src/href/etc.,
 *          processes inline <style>, <script>, style="" and on*="" attributes, drops <base>,
 *          and injects a runtime shim that routes fetch()/XHR through the proxy and hashes
 *          every id/class a script looks up, assigns or inserts as markup.
 *  - CSS:  hashes class/id selectors (only inside selector preludes, never in declaration values),
 *          proxies url() and @import.
 *  - JS:   proxies relative/absolute ES module imports. DOM lookups are NOT rewritten here: a regex
 *          can only see string literals, so `getElementById("row-" + i)` would be corrupted. The
 *          runtime shim hashes those calls in the browser instead, whatever the argument is.
 *
 * Every hash goes through HashName(), so HTML, CSS and JS always agree with each other.
 * HashName() is idempotent (a hashed name is returned unchanged), because scripts read hashed ids/classes
 * back from the DOM and feed them to the DOM again, and because the shim re-checks markup the server
 * already rewrote.
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

// What a hashed name looks like: "h" + 16 hex digits. The prefix is there because CSS identifiers
// cannot start with a digit, and a raw hash might.
const HASHED_NAME = /^h[0-9a-f]{16}$/;

function IsHashed(Name) {
  return HASHED_NAME.test(Name);
}

function HashName(Name) {
  if(HASHED_NAME.test(Name)) return Name; // already hashed
  let Hashed = HashCache.get(Name);
  if(Hashed === undefined) {
    Hashed = "h" + XXHash64.hash(Buffer.from(Name, "utf8")).toString("hex");
    if(HashCache.size > 100000) HashCache.clear();
    HashCache.set(Name, Hashed);
  }
  return Hashed;
}

// Hash every token of a class list (HTML splits on ASCII whitespace only, \S would also split on NBSP etc.),
// keeping the original whitespace intact.
function HashTokens(Value) {
  return Value.replace(/[^ \t\n\f\r]+/g, (Token) => HashName(Token));
}

// CSS escapes (".sm\:flex" -> "sm:flex") so the CSS side hashes the same string the HTML side does.
function UnescapeCss(Ident) {
  return Ident.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (Match, Hex, Char) => {
    if(Hex === undefined) return Char;
    const CodePoint = parseInt(Hex, 16);
    return (CodePoint === 0 || CodePoint > 0x10FFFF) ? "�" : String.fromCodePoint(CodePoint);
  });
}

// The same XXH64 (seed 0, lowercase hex, canonical byte order) as xxhash-addon, in plain JS so the browser
// can hash names that only exist at runtime. Shipped to the browser via toString(), so it must stay
// self-contained. Parity with the addon is covered by Tests/Inject.test.js.
function Xxh64Hex(Str) {
  const Data = new TextEncoder().encode(Str);
  const M = 0xFFFFFFFFFFFFFFFFn;
  const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n;
  const P4 = 9650029242287828579n, P5 = 2870177450012600261n;
  const Rotl = (X, R) => ((X << BigInt(R)) | (X >> BigInt(64 - R))) & M;
  const Round = (Acc, Input) => (Rotl((Acc + Input * P2) & M, 31) * P1) & M;
  const MergeRound = (Acc, Val) => ((Acc ^ Round(0n, Val)) * P1 + P4) & M;

  const View = new DataView(Data.buffer, Data.byteOffset, Data.byteLength);
  const Len = Data.length;
  let I = 0;
  let H;

  if(Len >= 32) {
    let V1 = (P1 + P2) & M, V2 = P2, V3 = 0n, V4 = (M + 1n - P1) & M;
    for(; I <= Len - 32; I += 32) {
      V1 = Round(V1, View.getBigUint64(I, true));
      V2 = Round(V2, View.getBigUint64(I + 8, true));
      V3 = Round(V3, View.getBigUint64(I + 16, true));
      V4 = Round(V4, View.getBigUint64(I + 24, true));
    }
    H = (Rotl(V1, 1) + Rotl(V2, 7) + Rotl(V3, 12) + Rotl(V4, 18)) & M;
    H = MergeRound(H, V1);
    H = MergeRound(H, V2);
    H = MergeRound(H, V3);
    H = MergeRound(H, V4);
  } else {
    H = P5;
  }
  H = (H + BigInt(Len)) & M;

  for(; I + 8 <= Len; I += 8) {
    H = (Rotl(H ^ Round(0n, View.getBigUint64(I, true)), 27) * P1 + P4) & M;
  }
  if(I + 4 <= Len) {
    H = (Rotl(H ^ ((BigInt(View.getUint32(I, true)) * P1) & M), 23) * P2 + P3) & M;
    I += 4;
  }
  for(; I < Len; I++) {
    H = (Rotl(H ^ ((BigInt(Data[I]) * P5) & M), 11) * P1) & M;
  }

  H ^= H >> 33n;
  H = (H * P2) & M;
  H ^= H >> 29n;
  H = (H * P3) & M;
  H ^= H >> 32n;
  return H.toString(16).padStart(16, "0");
}

// Browser counterpart of HashName() (the shim defines its own `HashCache` and `Xxh64Hex`).
function BrowserHashName(Name) {
  if(HASHED_NAME.test(Name)) return Name;
  let Hashed = HashCache.get(Name);
  if(Hashed === undefined) {
    Hashed = "h" + Xxh64Hex(Name);
    if(HashCache.size > 100000) HashCache.clear();
    HashCache.set(Name, Hashed);
  }
  return Hashed;
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

// Hashes a URL fragment ("#section") the way the element it points at was hashed.
// Left alone: "#", router-style fragments ("#/route", "#!/route"), key=value fragments ("#a=1&b=2"),
// and "#top" (which scrolls to the top of the page when nothing has that id, something a hash would break).
// Fragments arrive percent-encoded ("#%C3%A9"), ids are raw, so the fragment is decoded first.
function HashFragment(Fragment) {
  const Match = /^#(?![\/!])([^\s#?&=]+)$/.exec(Fragment);
  if(!Match) return Fragment;
  let Id = Match[1];
  try {
    Id = decodeURIComponent(Id);
  } catch {}
  if(Id.toLowerCase() === "top") return Fragment;
  return "#" + HashName(Id);
}

// url(#id) references in SVG presentation attributes (fill, filter, clip-path, ...)
function HashUrlRefs(Value) {
  return Value.replace(/url\(\s*(["']?)(#[^)"'\s]+)\1\s*\)/gi, (Match, Quote, Fragment) => {
    const Hashed = HashFragment(Fragment);
    return Hashed === Fragment ? Match : `url(${Quote}${Hashed}${Quote})`;
  });
}

// Returns Raw unchanged whenever the value should not be proxied.
// IsPage = true for webpage (navigation) URLs: <a>/<area> links, form actions, window.open.
//   Those become  [frontend]/Main.html?resource_uri=<original page url>   (FRONTEND env var)
// IsPage = false for resources (img, script, css, fetch, ...): those stay  [backend]/api/proxy?content_url=...
function ProxyUrl(Raw, BaseUrl, IsPage = false) {
  if(typeof Raw !== "string") return Raw;
  const Trimmed = Raw.trim();
  if(Trimmed === "") return Raw;

  // In-page anchors point at (hashed) ids.
  if(Trimmed.startsWith("#")) {
    const Hashed = HashFragment(Trimmed);
    return Hashed === Trimmed ? Raw : Hashed;
  }
  if(/^(data:|javascript:|mailto:|tel:|blob:|about:)/i.test(Trimmed)) return Raw;

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
  const NewFragment = HashFragment(Fragment);

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
  String.raw`|([.#])(-?(?:[_a-zA-Z -￿]|\\[\s\S])(?:[\w -￿-]|\\[\s\S])*)`,
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
// JS (module imports only; id/class lookups are hashed at runtime by the shim, see ShimMain)
// ---------------------------------------------------------------------------

const JS_STATIC_IMPORT = /\b((?:import|export)\b[^"'`;()=]*?\bfrom\s*|import\s*)(["'])([^"'\n]+)\2/g;
const JS_DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
const MODULE_SPECIFIER = /^(\.{0,2}\/|https?:\/\/)/; // bare specifiers need an import map, so leave them

function RewriteJs(Js, BaseUrl) {
  let Out = Js;

  Out = Out.replace(JS_STATIC_IMPORT, (Match, Head, Quote, Spec) =>
    MODULE_SPECIFIER.test(Spec) ? Head + Quote + ProxyUrl(Spec, BaseUrl) + Quote : Match);

  Out = Out.replace(JS_DYNAMIC_IMPORT, (Match, Quote, Spec) =>
    MODULE_SPECIFIER.test(Spec) ? `import(${Quote}${ProxyUrl(Spec, BaseUrl)}${Quote})` : Match);

  return Out;
}

// ---------------------------------------------------------------------------
// Runtime shim
// ---------------------------------------------------------------------------

// Attributes whose value is one or more ids
const ID_REF_ATTRS = new Set([
  "for", "form", "list", "headers", "popovertarget", "commandfor", "anchor", "itemref", "interestfor",
  "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns",
  "aria-activedescendant", "aria-details", "aria-errormessage", "aria-flowto"
]);
// SVG presentation attributes that can hold url(#id)
const SVG_URL_REF_ATTRS = new Set([
  "fill", "stroke", "filter", "clip-path", "mask", "marker-start", "marker-mid", "marker-end"
]);

// Runtime shim. URLs and ids that scripts build at runtime can't be rewritten statically, so this code runs in
// the browser (before any page script) and patches the APIs that create, change or look them up:
//  - fetch / XMLHttpRequest / window.open
//  - href/src/action property setters and setAttribute() on <a>, <img>, <script>, <link>, <iframe>, ...
//  - ids and classes, both directions:
//      lookups   getElementById, getElementsByClassName, querySelector(All), matches, closest
//      writes    el.id, el.className, el.classList, setAttribute("id" | "class" | "for" | "aria-*" ...), label.htmlFor
//      markup    innerHTML, outerHTML, insertAdjacentHTML, createContextualFragment, DOMParser, setHTMLUnsafe
//                (the inserted nodes are hashed synchronously, so a lookup right after the insert finds them)
//      styles    CSSStyleSheet.insertRule / replace / replaceSync, <style> elements created by scripts
//  - a MutationObserver as a safety net for anything inserted by another route (document.write, ...)
// Every hash is idempotent (see HashName), so a value that was already hashed, by the server or by an earlier
// patch, passes through unchanged.
// It is shipped to the browser via ShimMain.toString(), so it must be fully self-contained: the shared helpers
// it calls (HashName, HashTokens, RewriteSelectorText, ...) are defined by GetBrowserHelpers().
function ShimMain(C) {
  // The same document can run the shim twice (for example when scripts are re-inserted); patch only once.
  var Once = Symbol.for("pear.shim");
  if (window[Once]) return;
  try { Object.defineProperty(window, Once, {value: true}); } catch (E) {}

  var SKIP = /^(data:|javascript:|mailto:|tel:|blob:|about:)/i;

  // Page = true for webpage (navigation) URLs -> [frontend]/Main.html?resource_uri=<original url>
  // Page = false for resources -> [backend]/api/proxy?content_url=<url>
  function P(U, Page) {
    try {
      var S = String(U);
      var T = S.trim();
      if (T === "") return U;
      if (T.charAt(0) === "#") return HashFragment(T); // in-page anchor: points at a (hashed) id
      if (SKIP.test(T)) return U;
      var A = new URL(T, C.Base);
      if (A.protocol !== "http:" && A.protocol !== "https:") return U;
      if (Page && A.origin + A.pathname === C.Main) return U; // already wrapped
      var Already = A.href.indexOf(C.Proxy) === 0;
      if (Already && !Page) return U; // already proxied
      var H = HashFragment(A.hash);
      A.hash = "";
      if (Page) {
        var Target = A.href;
        if (Already) {
          Target = A.searchParams.get("content_url");
          if (!Target) return U;
        }
        return C.Main + "?resource_uri=" + encodeURIComponent(Target) + H;
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

  // Natives taken before anything is patched, so the shim's own bookkeeping never hashes or proxies twice
  var EP = Element.prototype;
  var SA = EP.setAttribute;
  var QSA_EL = EP.querySelectorAll;
  var QSA_DOC = Document.prototype.querySelectorAll;
  var QSA_FRAG = DocumentFragment.prototype.querySelectorAll;
  var Slice = Array.prototype.slice;

  function WrapMethod(Proto, Name, Make) {
    try {
      if (!Proto || typeof Proto[Name] !== "function") return;
      Object.defineProperty(Proto, Name, {value: Make(Proto[Name]), writable: true, configurable: true, enumerable: false});
    } catch (E) {}
  }

  // Replaces the setter and keeps the getter. Fn(value, this) returns the value to store.
  function WrapSetter(Proto, Name, Fn) {
    try {
      var D = Object.getOwnPropertyDescriptor(Proto, Name);
      if (!D || !D.set) return;
      Object.defineProperty(Proto, Name, {
        configurable: true,
        enumerable: D.enumerable,
        get: D.get,
        set: function (V) { D.set.call(this, Fn(V, this)); }
      });
    } catch (E) {}
  }

  // Runs After(this) once the original setter has finished
  function WrapSetterAfter(Proto, Name, After) {
    try {
      var D = Object.getOwnPropertyDescriptor(Proto, Name);
      if (!D || !D.set) return;
      Object.defineProperty(Proto, Name, {
        configurable: true,
        enumerable: D.enumerable,
        get: D.get,
        set: function (V) {
          D.set.call(this, V);
          try { After(this); } catch (E) {}
        }
      });
    } catch (E) {}
  }

  // Calls the original with its first argument converted by Fn (string in, string out)
  function MapFirst(Fn) {
    return function (Orig) {
      return function () {
        if (arguments.length === 0) return Orig.apply(this, arguments);
        var A = Slice.call(arguments);
        A[0] = Fn(String(A[0]));
        return Orig.apply(this, A);
      };
    };
  }

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
      var A = Slice.call(arguments);
      A[1] = P(U);
      return X.apply(this, A);
    };
  }

  // window.open
  var WO = window.open;
  if (WO) {
    window.open = function (U) {
      var A = Slice.call(arguments);
      if (A[0]) A[0] = P(A[0], true);
      return WO.apply(this, A);
    };
  }

  // el.href = ..., img.src = ..., form.action = ...
  [["HTMLAnchorElement", "href", true], ["HTMLAreaElement", "href", true], ["HTMLLinkElement", "href"],
   ["HTMLImageElement", "src"], ["HTMLScriptElement", "src"], ["HTMLIFrameElement", "src"],
   ["HTMLSourceElement", "src"], ["HTMLMediaElement", "src"], ["HTMLEmbedElement", "src"],
   ["HTMLTrackElement", "src"], ["HTMLFormElement", "action", true]].forEach(function (Pair) {
    var Ctor = window[Pair[0]];
    if (Ctor) WrapSetter(Ctor.prototype, Pair[1], function (V) { return P(V, !!Pair[2]); });
  });

  // -------------------------------------------------------------------------
  // ids and classes
  // -------------------------------------------------------------------------

  function HashId(V) { return V === "" ? V : HashName(V); }
  function HashTokenArg(V) {
    var S = String(V);
    // Empty / containing whitespace: let the browser throw its usual error
    return S === "" || /[ \t\n\f\r]/.test(S) ? V : HashName(S);
  }

  var SelCache = new Map();
  function Sel(S) {
    var R = SelCache.get(S);
    if (R === undefined) {
      R = RewriteSelectorText(S);
      if (SelCache.size > 2000) SelCache.clear();
      SelCache.set(S, R);
    }
    return R;
  }

  // Attribute name (lowercase) -> function that hashes its value
  var AttrFn = Object.create(null);
  AttrFn["id"] = HashId;
  AttrFn["class"] = HashTokens;
  (C.IdRefs || []).forEach(function (N) { AttrFn[N] = HashTokens; });
  (C.SvgUrlRefs || []).forEach(function (N) { AttrFn[N] = HashUrlRefs; });
  function FnFor(El, Lower) {
    if (Lower === "name") return El.tagName === "A" ? HashId : null; // <a name> is a fragment target like an id
    return AttrFn[Lower] || null;
  }

  // lookups
  WrapMethod(Document.prototype, "getElementById", MapFirst(HashName));
  WrapMethod(DocumentFragment.prototype, "getElementById", MapFirst(HashName));
  WrapMethod(Document.prototype, "getElementsByClassName", MapFirst(HashTokens));
  WrapMethod(EP, "getElementsByClassName", MapFirst(HashTokens));
  [Document.prototype, DocumentFragment.prototype, EP].forEach(function (Proto) {
    WrapMethod(Proto, "querySelector", MapFirst(Sel));
    WrapMethod(Proto, "querySelectorAll", MapFirst(Sel));
  });
  ["closest", "matches", "webkitMatchesSelector"].forEach(function (Name) {
    WrapMethod(EP, Name, MapFirst(Sel));
  });

  // writes
  WrapSetter(EP, "id", function (V) { return HashId(String(V)); });
  WrapSetter(EP, "className", function (V) { return HashTokens(String(V)); });
  if (window.HTMLLabelElement) {
    WrapSetter(HTMLLabelElement.prototype, "htmlFor", function (V) { return HashTokens(String(V)); });
  }

  var ClassLists = new WeakSet(); // the DOMTokenLists that belong to a class attribute (others: rel, sandbox, ...)
  try {
    var CL = Object.getOwnPropertyDescriptor(EP, "classList");
    if (CL && CL.get) {
      Object.defineProperty(EP, "classList", {
        configurable: true,
        enumerable: CL.enumerable,
        get: function () {
          var L = CL.get.call(this);
          ClassLists.add(L);
          return L;
        },
        set: CL.set && function (V) { CL.set.call(this, HashTokens(String(V))); }
      });
    }
  } catch (E) {}
  if (window.DOMTokenList) {
    [["add", Infinity], ["remove", Infinity], ["contains", 1], ["toggle", 1], ["replace", 2]].forEach(function (Pair) {
      WrapMethod(DOMTokenList.prototype, Pair[0], function (Orig) {
        return function () {
          if (!ClassLists.has(this)) return Orig.apply(this, arguments);
          var A = Slice.call(arguments);
          for (var I = 0; I < A.length && I < Pair[1]; I++) A[I] = HashTokenArg(A[I]);
          return Orig.apply(this, A);
        };
      });
    });
    var DV = Object.getOwnPropertyDescriptor(DOMTokenList.prototype, "value");
    if (DV && DV.set) {
      Object.defineProperty(DOMTokenList.prototype, "value", {
        configurable: true,
        enumerable: DV.enumerable,
        get: DV.get,
        set: function (V) { DV.set.call(this, ClassLists.has(this) ? HashTokens(String(V)) : V); }
      });
    }
  }

  // el.setAttribute("href" | "id" | "class" | "for" | ...)
  EP.setAttribute = function (N, V) {
    try {
      if (typeof N === "string") {
        var Lower = N.toLowerCase();
        if (ATTR[this.tagName] === Lower) V = P(V, !!PAGE[this.tagName]);
        else {
          var Fn = FnFor(this, Lower);
          if (Fn) V = Fn(String(V));
        }
      }
    } catch (E) {}
    return SA.call(this, N, V);
  };

  // -------------------------------------------------------------------------
  // Markup and styles that scripts create
  // -------------------------------------------------------------------------

  // Hash/proxy what one element carries. Idempotent, so running it on already-rewritten markup is harmless.
  function FixElement(El) {
    var Attrs = El.attributes;
    for (var I = 0; I < Attrs.length; I++) {
      var At = Attrs[I];
      var Fn = FnFor(El, At.name.toLowerCase());
      if (!Fn) continue;
      var V = At.value;
      var N = Fn(V);
      if (N !== V) SA.call(El, At.name, N);
    }
    var Name = ATTR[El.tagName];
    if (Name) {
      var U = El.getAttribute(Name);
      if (U !== null) {
        var NU = P(U, !!PAGE[El.tagName]);
        if (NU !== U) SA.call(El, Name, NU);
      }
    }
    if (El.tagName === "TEMPLATE" && El.content) FixTree(El.content);
    else if (El.tagName === "STYLE") FixStyle(El);
  }

  var ALL_SELECTOR = ["[id]", "[class]", "a[name]", "template", "style"]
    .concat((C.IdRefs || []).map(function (N) { return "[" + N + "]"; }))
    .concat((C.SvgUrlRefs || []).map(function (N) { return "[" + N + "]"; }))
    .concat(Object.keys(ATTR).map(function (T) { return T.toLowerCase() + "[" + ATTR[T] + "]"; }))
    .join(",");

  function FixTree(Root) {
    if (!Root) return;
    try {
      if (Root.nodeType === 1) FixElement(Root);
      var Q = Root.nodeType === 1 ? QSA_EL : Root.nodeType === 9 ? QSA_DOC : Root.nodeType === 11 ? QSA_FRAG : null;
      if (!Q) return;
      var Found = Q.call(Root, ALL_SELECTOR);
      for (var I = 0; I < Found.length; I++) FixElement(Found[I]);
    } catch (E) {}
  }

  // Fix the nodes that now sit between Prev and Next below Par
  function FixBetween(Par, Prev, Next) {
    if (!Par) return;
    for (var N = Prev ? Prev.nextSibling : Par.firstChild; N && N !== Next; N = N.nextSibling) FixTree(N);
  }

  function FixStyle(El) {
    try {
      var T = El.textContent;
      var N = RewriteCssSelectors(T);
      if (N !== T) El.textContent = N;
    } catch (E) {}
  }

  WrapSetterAfter(EP, "innerHTML", function (El) { FixTree(El.tagName === "TEMPLATE" ? El.content : El); });
  if (window.ShadowRoot) WrapSetterAfter(ShadowRoot.prototype, "innerHTML", FixTree);

  try {
    var OH = Object.getOwnPropertyDescriptor(EP, "outerHTML");
    if (OH && OH.set) {
      Object.defineProperty(EP, "outerHTML", {
        configurable: true,
        enumerable: OH.enumerable,
        get: OH.get,
        set: function (V) {
          var Par = this.parentNode, Prev = this.previousSibling, Next = this.nextSibling;
          OH.set.call(this, V);
          try { FixBetween(Par, Prev, Next); } catch (E) {}
        }
      });
    }
  } catch (E) {}

  WrapMethod(EP, "insertAdjacentHTML", function (Orig) {
    return function (Pos) {
      var Par = null, Prev = null, Next = null;
      try {
        var Where = String(Pos).toLowerCase();
        if (Where === "beforebegin") { Par = this.parentNode; Prev = this.previousSibling; Next = this; }
        else if (Where === "afterbegin") { Par = this; Next = this.firstChild; }
        else if (Where === "beforeend") { Par = this; Prev = this.lastChild; }
        else if (Where === "afterend") { Par = this.parentNode; Prev = this; Next = this.nextSibling; }
      } catch (E) {}
      var R = Orig.apply(this, arguments);
      try { FixBetween(Par, Prev, Next); } catch (E) {}
      return R;
    };
  });

  function ReturnFixed(Orig) {
    return function () {
      var R = Orig.apply(this, arguments);
      FixTree(R);
      return R;
    };
  }
  if (window.Range) WrapMethod(Range.prototype, "createContextualFragment", ReturnFixed);
  if (window.Document) WrapMethod(Document, "parseHTMLUnsafe", ReturnFixed);
  if (window.DOMParser) {
    WrapMethod(DOMParser.prototype, "parseFromString", function (Orig) {
      return function (Str, Type) {
        var Doc = Orig.apply(this, arguments);
        if (/html/i.test(String(Type))) FixTree(Doc);
        return Doc;
      };
    });
  }
  [EP, window.ShadowRoot && ShadowRoot.prototype].forEach(function (Proto) {
    ["setHTMLUnsafe", "setHTML"].forEach(function (Name) {
      WrapMethod(Proto, Name, function (Orig) {
        return function () {
          var R = Orig.apply(this, arguments);
          FixTree(this.tagName === "TEMPLATE" ? this.content : this);
          return R;
        };
      });
    });
  });

  // Rules that scripts add to a stylesheet (CSS-in-JS libraries do this)
  if (window.CSSStyleSheet) {
    WrapMethod(CSSStyleSheet.prototype, "insertRule", MapFirst(RewriteCssSelectors));
    WrapMethod(CSSStyleSheet.prototype, "replace", MapFirst(RewriteCssSelectors));
    WrapMethod(CSSStyleSheet.prototype, "replaceSync", MapFirst(RewriteCssSelectors));
    WrapMethod(CSSStyleSheet.prototype, "addRule", MapFirst(Sel));
  }
  if (window.CSSGroupingRule) WrapMethod(CSSGroupingRule.prototype, "insertRule", MapFirst(RewriteCssSelectors));
  if (window.CSSStyleRule) WrapSetter(CSSStyleRule.prototype, "selectorText", function (V) { return Sel(String(V)); });

  // Safety net for markup that arrived by a route that is not patched above (document.write, ...),
  // and for <style> elements whose text changes after they were inserted.
  new MutationObserver(function (Records) {
    for (var I = 0; I < Records.length; I++) {
      var R = Records[I];
      if (R.type === "characterData") {
        var Par = R.target.parentNode;
        if (Par && Par.tagName === "STYLE") FixStyle(Par);
        continue;
      }
      if (R.target.tagName === "STYLE") FixStyle(R.target);
      var Added = R.addedNodes;
      for (var J = 0; J < Added.length; J++) {
        if (Added[J].nodeType === 1) FixTree(Added[J]);
      }
    }
  }).observe(document, {childList: true, subtree: true, characterData: true});
}

// The helpers ShimMain calls, as browser source: the same functions the server uses (so the two can never
// disagree) plus the browser's own HashName.
let BrowserHelpers = null;
function GetBrowserHelpers() {
  if(BrowserHelpers === null) {
    BrowserHelpers = [
      `var HASHED_NAME = ${HASHED_NAME.toString()};`,
      `var SELECTOR_TOKEN = ${SELECTOR_TOKEN.toString()};`,
      `var HashCache = new Map();`,
      `var Xxh64Hex = ${Xxh64Hex.toString()};`,
      `var HashName = ${BrowserHashName.toString()};`,
      ...[IsHashed, HashTokens, UnescapeCss, SkipCssString, RewriteSelectorText, RewriteCssSelectors,
          HashFragment, HashUrlRefs].map((Fn) => Fn.toString())
    ].join("\n");
  }
  return BrowserHelpers;
}

function BuildShim(BaseUrl) {
  const Main = MainPage();
  const Config = JSON.stringify({
    Base: BaseUrl,
    Proxy: ProxyEndpoint().href,
    Main: Main.origin + Main.pathname, // [frontend]/Main.html, no query
    IdRefs: [...ID_REF_ATTRS],
    SvgUrlRefs: [...SVG_URL_REF_ATTRS]
  }).replace(/</g, "\\u003c");
  return "(function(){" + GetBrowserHelpers() + "\n(" + ShimMain.toString() + ")(" + Config + ");})();";
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

// name [= "value" | 'value' | value]
const ATTR_REGEX = /([^\s"'<>\/=]+)(?:(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

// 1: comment (no groups) | 2-4: <style>/<script> block | 5-6: any other opening tag
const HTML_TOKEN = /<!--[\s\S]*?-->|<(style|script)(?=[\s\/>])((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/\1\s*>|<([a-zA-Z][^\s>\/]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;

const NAMED_ENTITIES = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "};

// Attribute values are entity-encoded in the markup but ids/classes are compared decoded, so decode
// before hashing ("a&amp;b" is the id "a&b", which is what getElementById("a&b") and CSS #a\&b mean).
function DecodeEntities(Value) {
  return Value.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (Match, Dec, Hex, Name) => {
    if(Name !== undefined) return Object.hasOwn(NAMED_ENTITIES, Name) ? NAMED_ENTITIES[Name] : Match;
    const CodePoint = parseInt(Dec ?? Hex, Dec !== undefined ? 10 : 16);
    return (CodePoint === 0 || CodePoint > 0x10FFFF || (CodePoint >= 0xD800 && CodePoint <= 0xDFFF))
      ? "�" : String.fromCodePoint(CodePoint);
  });
}

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
  const IsAnchor = (TagName || "").toLowerCase() === "a";

  return AttrText.replace(ATTR_REGEX, (Match, Name, Eq, Dq, Sq, Unq) => {
    if(Eq === undefined) return Match; // boolean attribute

    const Lower = Name.toLowerCase();
    const Value = Dq ?? Sq ?? Unq;
    const Quote = Sq !== undefined ? "'" : '"';
    let Rewritten = Value;

    if(Lower === "integrity") return ""; // the content changes, so SRI would always fail
    else if(Lower === "class") Rewritten = HashTokens(DecodeEntities(Value));
    else if(Lower === "id" || (Lower === "name" && IsAnchor)) {
      // <a name="x"> is a fragment target exactly like id="x", so it is hashed the same way
      const Id = DecodeEntities(Value);
      Rewritten = Id === "" ? Value : HashName(Id);
    }
    else if(ID_REF_ATTRS.has(Lower)) Rewritten = HashTokens(DecodeEntities(Value));
    else if(SVG_URL_REF_ATTRS.has(Lower)) Rewritten = HashUrlRefs(Value);
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

module.exports = {RewriteContent, HashName, GetFrontend, Xxh64Hex, BuildShim};
