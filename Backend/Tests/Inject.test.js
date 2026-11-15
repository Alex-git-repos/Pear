// Run with `npm test` (Node's built-in test runner, no extra dependencies).
process.env.BACKEND = "https://backend.example/";
process.env.FRONTEND = "https://front.example/";

const test = require("node:test");
const assert = require("node:assert/strict");
const {XXHash64} = require("xxhash-addon");
const {RewriteContent, HashName, Xxh64Hex, BuildShim} = require("../Inject.js");

const Html = (Body) => RewriteContent(Body, "https://example.com/dir/page.html", "text/html");
const Css = (Body) => RewriteContent(Body, "https://example.com/a.css", "text/css");
const Js = (Body) => RewriteContent(Body, "https://example.com/a.js", "application/javascript");
const H = (Name) => HashName(Name);

test("the browser's XXH64 gives exactly the server's hash", () => {
  const Samples = ["", "a", "main", "row-12", "héllo wörld ✓", "\u{1F600}".repeat(9)];
  for(let Length = 0; Length <= 130; Length++) Samples.push("a".repeat(Length), "é✓".repeat(Length));
  for(const Sample of Samples) {
    assert.equal(Xxh64Hex(Sample), XXHash64.hash(Buffer.from(Sample, "utf8")).toString("hex"), JSON.stringify(Sample));
  }
});

test("HashName is idempotent", () => {
  for(const Name of ["main", "row-1", "café", "a&b"]) {
    assert.equal(HashName(HashName(Name)), HashName(Name));
    assert.match(HashName(Name), /^h[0-9a-f]{16}$/);
  }
});

test("HTML: id, class and every attribute that names an id are hashed", () => {
  const Out = Html(`<head></head><body><div id="main" class="a b"><label for="main">l</label>` +
    `<input list="dl" aria-labelledby="x y"></div></body>`);
  assert.ok(Out.includes(`id="${H("main")}"`));
  assert.ok(Out.includes(`class="${H("a")} ${H("b")}"`));
  assert.ok(Out.includes(`for="${H("main")}"`));
  assert.ok(Out.includes(`list="${H("dl")}"`));
  assert.ok(Out.includes(`aria-labelledby="${H("x")} ${H("y")}"`));
});

test("HTML: entities are decoded before hashing, so ids match what scripts and CSS see", () => {
  const Out = Html(`<head></head><body><div id="a&amp;b" class="x&#38;y z"></div></body>`);
  assert.ok(Out.includes(`id="${H("a&b")}"`));
  assert.ok(Out.includes(`class="${H("x&y")} ${H("z")}"`));
});

test("HTML: a class list splits on ASCII whitespace only (NBSP is part of the class name)", () => {
  const Out = Html(`<head></head><body><div class="a&nbsp;b c"></div></body>`);
  assert.ok(Out.includes(`class="${H("a b")} ${H("c")}"`));
});

test("HTML: <a name> is hashed like an id, other name attributes are not", () => {
  const Out = Html(`<head></head><body><a name="anch">n</a><input name="field"></body>`);
  assert.ok(Out.includes(`name="${H("anch")}"`));
  assert.ok(Out.includes(`name="field"`));
});

test("HTML: in-page links point at the hashed id", () => {
  const Out = Html(`<head></head><body><a href="#main">1</a><a href="#fn:1">2</a><a href="#a.b">3</a>` +
    `<a href="#caf%C3%A9">4</a><a href="#top">5</a><a href="#/route">6</a><a href="#!/r">7</a><a href="#a=1&amp;b=2">8</a></body>`);
  assert.ok(Out.includes(`href="#${H("main")}"`));
  assert.ok(Out.includes(`href="#${H("fn:1")}"`));
  assert.ok(Out.includes(`href="#${H("a.b")}"`));
  assert.ok(Out.includes(`href="#${H("café")}"`));
  assert.ok(Out.includes(`href="#top"`), "#top must keep scrolling to the top of the page");
  assert.ok(Out.includes(`href="#/route"`), "router fragments are not ids");
  assert.ok(Out.includes(`href="#!/r"`));
  assert.ok(Out.includes(`href="#a=1&amp;b=2"`));
});

test("HTML: SVG url(#id) references follow the hashed id", () => {
  const Out = Html(`<head></head><body><svg><linearGradient id="g1"></linearGradient><rect fill="url(#g1)" stroke="none"/></svg></body>`);
  assert.ok(Out.includes(`id="${H("g1")}"`));
  assert.ok(Out.includes(`fill="url(#${H("g1")})"`));
  assert.ok(Out.includes(`stroke="none"`));
});

test("HTML: re-running the rewriter on its own output does not change ids or classes", () => {
  const Once = Html(`<head></head><body><div id="main" class="a b"></div></body>`);
  const Twice = RewriteContent(Once, "https://example.com/dir/page.html", "text/html");
  assert.ok(Twice.includes(`id="${H("main")}"`));
  assert.ok(Twice.includes(`class="${H("a")} ${H("b")}"`));
});

test("CSS: selectors are hashed, declaration values are not, and the result is stable", () => {
  const Once = Css(`#main .a:not(.b)[class~="c"]{color:#fff;margin:0.5em}`);
  assert.ok(Once.includes(`#${H("main")} .${H("a")}:not(.${H("b")})[class~="${H("c")}"]`));
  assert.ok(Once.includes(`color:#fff;margin:0.5em`));
  assert.equal(Css(Once), Once);
});

test("JS: DOM lookups are left alone for the runtime shim (a regex would corrupt concatenated ids)", () => {
  const Source = `var A = document.getElementById("row-" + i); var B = document.getElementById("main"); el.classList.add("on");`;
  assert.equal(Js(Source), Source);
});

test("JS: module imports are still proxied", () => {
  assert.match(Js(`import x from "./dep.js";`), /api\/proxy\?content_url=/);
});

test("shim: injected once into <head>, parses, and cannot terminate its own <script> tag", () => {
  const Out = Html(`<!doctype html><html><head><title>t</title></head><body></body></html>`);
  assert.equal(Out.split("<script>").length - 1, 1);
  assert.ok(Out.indexOf("<script>") < Out.indexOf("<title>"));
  const Shim = BuildShim("https://example.com/");
  assert.ok(!/<\/script/i.test(Shim));
  assert.ok(!Shim.includes("<!--"));
  assert.doesNotThrow(() => new Function(Shim));
});
