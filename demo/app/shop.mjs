// Small shop used by the demo. Release v2 ships the changes listed in scenario.json: four renamed or
// restructured controls and a cart total that drops the last line item.
// Pages are laid out for a 560 by 300 viewport, so every control is visible in the dashboard tiles.
import { readFileSync } from "node:fs"
import http from "node:http"
import path from "node:path"

export const scenario = JSON.parse(readFileSync(path.join(import.meta.dirname, "scenario.json"), "utf8"))

const products = {
  apple: { name: "Apple", price: 2.5 },
  pear: { name: "Pear", price: 2 },
  banana: { name: "Banana", price: 1.5 },
}

const euro = (value) => `€${value.toFixed(2)}`

export function startShop({ port, release }) {
  const changes = scenario.releases[release]?.changes ?? []
  const has = (kind) => changes.some((change) => change.kind === kind)
  // UI copy for this release: renamed controls use their new text.
  const copy = (before) =>
    changes.find((change) => change.kind === "renamed" && change.before === before)?.after ?? before

  const contact =
    copy("Contact us") === "Contact us"
      ? `<a href="/contact">Contact us</a>`
      : `<button type="button" class="linkish" onclick="location.href='/contact'">${copy("Contact us")}</button>`

  const layout = (title, body) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · Fresh Market</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; margin: 0; color: #1d2433; font-size: 18px; height: 100vh; display: grid; grid-template-rows: auto 1fr auto; }
  header, footer { display: flex; gap: 16px; align-items: center; padding: 6px 14px; background: #1f7a4d; }
  header a, footer a, .linkish { color: #fff; font-size: 16px; }
  .linkish { background: #0f5132; border: 0; border-radius: 4px; padding: 3px 10px; font: inherit; color: #fff; }
  main { padding: 6px 14px; }
  h1 { margin: 2px 0 6px; font-size: 24px; }
  ul { margin: 2px 0 6px; padding-left: 22px; }
  button { font: inherit; padding: 5px 12px; border-radius: 6px; border: 0; background: #1f7a4d; color: #fff; }
  input { font: inherit; padding: 3px 8px; width: 150px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  [role=status] { font-weight: 700; margin: 4px 0; }
  .inline li { display: inline; margin-right: 14px; }
</style></head>
<body>
  <header><a href="/">Home</a> <a href="/search">Search</a> <a href="/cart">Cart (<span id="badge">0</span>)</a></header>
  <main>${body}</main>
  <footer>${contact}</footer>
</body>
</html>`

  const routes = {
    "/": () =>
      layout(
        "Home",
        `<h1>Fresh Market</h1><p>Featured today</p><ul aria-label="Featured products" class="inline">${Object.entries(
          products,
        )
          .map(([id, p]) => `<li><a href="/product/${id}">${p.name}</a></li>`)
          .join("")}</ul>`,
      ),
    "/cart": (url) => {
      const lines = parseCart(url.searchParams.get("items"))
      const counted = has("bug") ? lines.slice(0, -1) : lines
      const total = counted.reduce((sum, line) => sum + line.product.price * line.count, 0)
      return layout(
        "Cart",
        `<div class="cols">
<div>
  <h1>Your cart</h1>
  <ul aria-label="Line items">${lines
    .map((line) => `<li>${line.product.name} × ${line.count}: ${euro(line.product.price * line.count)}</li>`)
    .join("")}</ul>
  <p role="status" aria-label="Order total">Total: ${euro(total)}</p>
</div>
<div>
  <form onsubmit="event.preventDefault(); document.getElementById('coupon-result').textContent = 'Coupon applied'">
    <p><label>${copy("Coupon code")} <input name="coupon"></label></p>
    <p><button>Apply</button></p>
  </form>
  <p id="coupon-result" role="alert"></p>
  <p><button onclick="location.href='/checkout'">${copy("Checkout")}</button></p>
</div>
</div>`,
      )
    },
    "/checkout": () =>
      layout("Checkout", `<h1>Payment</h1><label>Card number <input name="card" autocomplete="off"></label>`),
    "/search": () =>
      layout(
        "Search",
        `<h1>Search</h1>
<form id="search"><input type="search" aria-label="Search products" name="q"> <button>Search</button></form>
<p role="status" id="state"></p>
<ul aria-label="Results" id="results"></ul>
<script>
  document.getElementById("search").addEventListener("submit", async (event) => {
    event.preventDefault()
    const q = new FormData(event.target).get("q")
    document.getElementById("state").textContent = "Searching…"
    const found = await (await fetch("/api/search?q=" + encodeURIComponent(q))).json()
    document.getElementById("state").textContent = found.length + " result(s)"
    document.getElementById("results").innerHTML = found.map((name) => "<li>" + name + "</li>").join("")
  })
</script>`,
      ),
    "/contact": () => layout("Contact", `<h1>Contact us</h1><p>support@fresh-market.example</p>`),
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase()
      const found = Object.values(products)
        .map((p) => p.name)
        .filter((name) => name.toLowerCase().includes(q))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(found))
      return
    }
    const product = /^\/product\/(\w+)$/.exec(url.pathname)?.[1]
    let html
    if (product && products[product]) {
      const p = products[product]
      html = layout(
        p.name,
        `<h1>${p.name}</h1><p>Price: ${euro(p.price)}</p>
<button onclick="const b = document.getElementById('badge'); b.textContent = Number(b.textContent) + 1">${copy("Add to cart")}</button>`,
      )
    } else {
      html = routes[url.pathname]?.(url)
    }
    response.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" })
    response.end(html ?? layout("Not found", "<h1>Not found</h1>"))
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

function parseCart(query) {
  return (query ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [id = "", count = "1"] = entry.split(":")
      return { product: products[id], count: Number(count) }
    })
    .filter((line) => line.product)
}
