// Works out which products a bill was actually made of.
//
// Two eras of data:
//
//   New bills store the inventory ids outright (orders.items), so there is
//   nothing to guess.
//
//   Older bills — and every WooCommerce order — have only a summary
//   string: "3PC x1, 2pc x1". That is matched back to stock by name, and
//   THAT is where care is needed: this shop reuses names heavily, with
//   many different products all called "3PC" or "2pc". Matching on name
//   alone put the first "3PC"'s photo on every bill that mentioned a
//   "3PC", which is worse than showing no photo at all — the owner reads
//   the picture as fact.
//
// So when a name matches more than one product, the price and cost on the
// order are used to narrow it down, and if that still leaves a choice the
// line gets NO photo and is marked ambiguous. A blank is honest; a
// confident wrong picture is not.

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

const imageUrlFor = (row) =>
  row && row.has_image
    ? `/inventory/${row.id}/image?v=${row.updated_at ? new Date(row.updated_at).getTime() : 0}`
    : null;

// name -> every product with that name. Plural on purpose: the duplicates
// are the whole problem.
function groupByName(inventoryRows) {
  const byName = new Map();
  for (const row of inventoryRows || []) {
    const key = String(row.name || "").trim().toLowerCase();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  }
  return byName;
}

const byId = (inventoryRows) => new Map((inventoryRows || []).map((r) => [String(r.id), r]));

const near = (a, b) => {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.5;          // money, rounded to the rupee
};

// Several products share this name. Try to tell them apart by what the
// order says it charged and what it cost. Only a single survivor counts.
function narrowByMoney(candidates, order, line) {
  const lines = parseProductSummary(order.product, order.qty).length;
  // On a multi-item bill the totals cover every line, so they say nothing
  // about any one of them.
  if (lines !== 1) return null;

  const qty = Number(line.qty) || 1;
  const unitSell = Number(order.sell) / qty;
  const unitCost = Number(order.cost) / qty;

  for (const field of ["cost", "price"]) {
    const target = field === "cost" ? unitCost : unitSell;
    if (!Number.isFinite(target) || target <= 0) continue;
    const hits = candidates.filter((c) => near(c[field], target));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

// Attaches `items` to each order: what was sold, and its photo when — and
// only when — the product can be identified beyond doubt.
function attachItems(orders, inventoryRows) {
  const byName = groupByName(inventoryRows);
  const ids = byId(inventoryRows);

  return (orders || []).map((order) => {
    // Recorded at the till: exact, no matching needed.
    const stored = Array.isArray(order.items) ? order.items : null;
    if (stored && stored.length > 0) {
      const items = stored.map((it) => {
        const row = ids.get(String(it.id));
        return {
          name: it.name,
          qty: Number(it.qty) || 1,
          price: it.price === undefined ? null : it.price,
          inventoryId: row ? row.id : null,
          imageUrl: imageUrlFor(row),
          ambiguous: false,
          exact: true,
        };
      });
      return { ...order, items };
    }

    const items = parseProductSummary(order.product, order.qty).map((line) => {
      const candidates = byName.get(line.name.toLowerCase()) || [];
      let match = null;
      let ambiguous = false;

      if (candidates.length === 1) {
        match = candidates[0];
      } else if (candidates.length > 1) {
        match = narrowByMoney(candidates, order, line);
        // Still more than one possibility: say so and show no picture.
        ambiguous = !match;
      }

      return {
        name: line.name,
        qty: line.qty,
        price: null,
        inventoryId: match ? match.id : null,
        imageUrl: imageUrlFor(match),
        ambiguous,
        exact: false,
      };
    });
    return { ...order, items };
  });
}

module.exports = { parseProductSummary, groupByName, attachItems };
