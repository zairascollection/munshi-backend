// Turns an order's product summary back into line items with photos.
//
// Orders do not store item ids. Both the POS and the WooCommerce sync
// write a single summary string — "Lawn Suit x2, Dupatta x1" — and that
// is all a bill from six months ago has. The returns code already parses
// it to put stock back, so the same parse is reused here to find each
// item's picture.
//
// Doing it this way (rather than storing ids on new orders only) means
// every order that already exists gets its photos too, which is exactly
// what was asked for. If an item was renamed or deleted since the sale,
// the line simply has no photo — the bill still reads correctly.

// "Lawn Suit x2" -> { name: "Lawn Suit", qty: 2 }
function parseSegment(segment, fallbackQty) {
  const text = String(segment || "").trim();
  if (!text) return null;
  const m = text.match(/^(.*)\s+x(\d+(?:\.\d+)?)$/i);
  const name = (m ? m[1] : text).trim();
  if (!name) return null;
  return { name, qty: m ? Number(m[2]) : Number(fallbackQty) || 1 };
}

function parseProductSummary(product, fallbackQty) {
  return String(product || "")
    .split(",")
    .map((seg) => parseSegment(seg, fallbackQty))
    .filter(Boolean);
}

// Builds a lowercase name -> { id, imageUrl, price } lookup from inventory
// rows. Built once per request, not once per order.
function buildLookup(inventoryRows) {
  const byName = new Map();
  for (const row of inventoryRows || []) {
    const key = String(row.name || "").trim().toLowerCase();
    if (!key || byName.has(key)) continue;
    const stamp = row.updated_at ? new Date(row.updated_at).getTime() : 0;
    byName.set(key, {
      id: row.id,
      price: row.price,
      imageUrl: row.has_image ? `/inventory/${row.id}/image?v=${stamp}` : null,
    });
  }
  return byName;
}

// Attaches `items` to each order. Every item carries whatever could be
// matched; nothing is invented.
function attachItems(orders, inventoryRows) {
  const lookup = buildLookup(inventoryRows);
  return (orders || []).map((order) => {
    const items = parseProductSummary(order.product, order.qty).map((line) => {
      const match = lookup.get(line.name.toLowerCase());
      return {
        name: line.name,
        qty: line.qty,
        inventoryId: match ? match.id : null,
        imageUrl: match ? match.imageUrl : null,
      };
    });
    return { ...order, items };
  });
}

module.exports = { parseProductSummary, buildLookup, attachItems };
