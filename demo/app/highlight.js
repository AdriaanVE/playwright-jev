// Injected into every demo page. Draws a labelled ring around an element so viewers can see what a
// decision engine picked, or which value was wrong. The screencast carries it into the dashboard.
window.__demoMark = (element, label, color) => {
  const box = element.getBoundingClientRect()
  const ring = document.createElement("div")
  const pad = 6
  Object.assign(ring.style, {
    position: "fixed",
    left: `${box.left - pad}px`,
    top: `${box.top - pad}px`,
    width: `${box.width + pad * 2}px`,
    height: `${box.height + pad * 2}px`,
    border: `4px solid ${color}`,
    borderRadius: "10px",
    boxShadow: `0 0 0 6px ${color}33`,
    zIndex: 99999,
    pointerEvents: "none",
  })
  const tag = document.createElement("div")
  tag.textContent = label
  // Prefer the right-hand side so the label never covers nearby content; fall back to above or below.
  const right = box.right + pad + 12 + 240 < window.innerWidth
  const above = box.top > 40
  Object.assign(tag.style, {
    position: "fixed",
    left: right ? `${box.right + pad + 10}px` : `${Math.max(4, box.left - pad)}px`,
    top: right ? `${box.top + box.height / 2 - 14}px` : above ? `${box.top - pad - 30}px` : `${box.bottom + pad + 4}px`,
    padding: "3px 10px",
    background: color,
    color: "#fff",
    font: "700 15px system-ui, sans-serif",
    borderRadius: "6px",
    zIndex: 99999,
    pointerEvents: "none",
    whiteSpace: "nowrap",
  })
  document.body.append(ring, tag)
}
