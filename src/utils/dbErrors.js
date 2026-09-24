// Turns Postgres error codes into something a shopkeeper can act on.
//
// Without this, adding an item with a SKU that already exists returned
// "Internal server error". The row stayed on screen, looked saved, and
// vanished on the next refresh — with nothing anywhere explaining why.

const FIELD_NAMES = {
  sku: "SKU",
  email: "Email",
  order_no: "Order number",
  po_no: "PO number",
  phone: "Phone number",
  name: "Naam",
  quantity: "Quantity",
  price: "Price",
  cost: "Cost",
  amount: "Amount",
  title: "Title",
  channel: "Channel",
  salary: "Salary",
  customer: "Customer",
};

const label = (col) => FIELD_NAMES[col] || col;

// Pulls the offending column out of a constraint name like
// "inventory_sku_key" or out of the detail line Postgres provides.
function columnFrom(err) {
  if (err.column) return err.column;
  const fromDetail = /Key \(([^)]+)\)/.exec(err.detail || "");
  if (fromDetail) return fromDetail[1].split(",")[0].trim();
  const fromConstraint = /^[a-z_]+?_(.+)_(key|fkey|check)$/.exec(err.constraint || "");
  if (fromConstraint) return fromConstraint[1];
  return null;
}

// Returns { status, error } for a known database problem, or null when the
// error is something unexpected that should surface as a 500.
function explain(err) {
  if (!err || !err.code) return null;
  const col = columnFrom(err);

  switch (err.code) {
    case "23505": // unique_violation
      return {
        status: 409,
        error: col
          ? `Ye ${label(col)} pehle se maujood hai — koi aur rakhein.`
          : "Ye record pehle se maujood hai.",
      };
    case "23502": // not_null_violation
      return { status: 400, error: `${label(col || "")} khali nahi chhod sakte.`.trim() };
    case "23503": // foreign_key_violation
      return { status: 400, error: "Jis record se ye juda hai woh maujood nahi." };
    case "23514": // check_violation
      return { status: 400, error: col ? `${label(col)} ki value qabool nahi.` : "Value qabool nahi." };
    case "22P02": // invalid_text_representation
      return { status: 400, error: "Kisi khaane mein ghalat qism ki value hai (number ki jagah text?)." };
    case "22001": // string_data_right_truncation
      return { status: 400, error: "Koi value itni lambi hai ke save nahi ho sakti." };
    default:
      return null;
  }
}

// Wraps a route handler so database errors come back as a clear message
// instead of a generic 500 the user cannot act on.
function handleDbError(err, res, fallback = "Save nahi hua") {
  const known = explain(err);
  if (known) {
    res.status(known.status).json({ error: known.error });
    return true;
  }
  console.error(`${fallback}:`, err);
  res.status(500).json({ error: `${fallback} — server error`, detail: err.message });
  return true;
}

module.exports = { explain, handleDbError };
