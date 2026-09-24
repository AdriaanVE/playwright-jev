// Small shop used by the demo. `release: "v2"` ships three problems a real release could introduce:
// a renamed checkout button, a cart total that drops the last line item, and a slow first search
// while the search cache is cold.
import http from "node:http"

const products = {
  apple: { name: "Apple", price: 2.5 },
  pear: { name: "Pear", price: 2 },
  banana: { name: "Banana", price: 1.5 },
}

const euro = (value) => `€${value.toFixed(2)}`

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title} · Fresh Market</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; color: #1d2433; font-size: 20px; }
  header, footer { display: flex; gap: 16px; padding: 8px 16px; background: #1f7a4d; }
  header a, footer a { color: #fff; }
  main { padding: 8px 16px; }
  h1 { margin: 4px 0 8px; font-size: 28px; }
  ul { margin: 4px 0; }
  button { font-size: 20px; padding: 6px 14px; border-radius: 6px; border: 0; background: #1f7a4d; color: #fff; }
  input { font-size: 18px; padding: 4px 8px; }
  [role=status] { font-weight: 700; }
</style></head>
<body>
  <header>
    <nav aria-label="Main"><a href="/">Home</a> <a href="/search">Search</a> <a href="/cart">Cart (<span id="badge">0</span>)</a></nav>
  </header>
  <main>${body}</main>
  <footer><a href="/contact">Contact us</a></footer>
</body>
</html>`
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

export function startShop({ port, release }) {
  let searches = 0
  const broken = release === "v2"

  const routes = {
    "/": () =>
      layout(
        "Home",
        `<h1>Fresh Market</h1><h2>Featured</h2><ul aria-label="Featured products">${Object.entries(products)
          .map(([id, p]) => `<li><a href="/product/${id}">${p.name}</a></li>`)
          .join("")}</ul>`,
      ),
    "/cart": (url) => {
      const lines = parseCart(url.searchParams.get("items"))
      // v2 bug: the total skips the last line item.
      const counted = broken ? lines.slice(0, -1) : lines
      const total = counted.reduce((sum, line) => sum + line.product.price * line.count, 0)
      const checkout = broken ? "Go to checkout" : "Checkout"
      return layout(
        "Cart",
        `<h1>Your cart</h1>
<ul aria-label="Line items">${lines
          .map((line) => `<li>${line.product.name} × ${line.count}: ${euro(line.product.price * line.count)}</li>`)
          .join("")}</ul>
<p role="status" aria-label="Order total">Total: ${euro(total)}</p>
<form onsubmit="event.preventDefault(); document.getElementById('coupon-result').textContent = 'Coupon applied'">
  <label>Coupon code <input name="coupon"></label> <button>Apply</button>
</form>
<p id="coupon-result" role="alert"></p>
<button onclick="location.href='/checkout'">${checkout}</button>`,
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
    const url = new URL(request.url ?? "/", `http://localhost:${port}`)
    if (url.pathname === "/api/search") {
      // v2: the first search after the release waits on a cold cache.
      if (broken && searches++ === 0) await new Promise((resolve) => setTimeout(resolve, 8_000))
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
<button onclick="const b = document.getElementById('badge'); b.textContent = Number(b.textContent) + 1">Add to cart</button>`,
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
