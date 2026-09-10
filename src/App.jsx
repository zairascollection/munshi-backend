import { useState, useEffect, useMemo, useCallback } from "react";
import {
  LayoutGrid, Boxes, Truck, Users, Wallet, Share2, Plus, Trash2,
  TrendingUp, TrendingDown, AlertTriangle, Search, X, ChevronRight,
  BarChart3, ImageIcon, ShieldCheck, User, Receipt, Minus, Printer, BookUser,
  Landmark, ScanLine, LogOut, RefreshCw, Pencil,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";
import Login from "./Login";
import { api, getToken, setToken, me, syncWooCommerce, createUser, listUsers, removeUser } from "./api";

const COLORS = {
  bg: "#0F161F",
  surface: "#161F2A",
  surface2: "#1D2A38",
  border: "#26374A",
  borderSoft: "#1E2C3A",
  text: "#E9F0F6",
  textDim: "#8CA0B3",
  textFaint: "#5A7186",
  accent: "#E8A33D",
  accentDim: "#3A2F1C",
  positive: "#3FB68A",
  positiveDim: "#173A30",
  negative: "#E2574C",
  negativeDim: "#3A1E1C",
  info: "#5B9BD5",
  infoDim: "#1B2C3D",
};

const fmt = (n) =>
  "Rs " + Math.round(Number(n) || 0).toLocaleString("en-PK");

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const todayISO = () => new Date().toISOString().slice(0, 10);

const paymentStatusOf = (o) => {
  const paid = Number(o.amountPaid || 0);
  const total = Number(o.sell || 0);
  if (total <= 0) return "Pending";
  if (paid >= total) return "Paid";
  if (paid > 0) return "Partial";
  return "Pending";
};
const amountDueOf = (o) => Math.max(0, Number(o.sell || 0) - Number(o.amountPaid || 0));

const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutGrid, ownerOnly: false },
  { id: "pos", label: "POS / Billing", icon: Receipt, ownerOnly: false },
  { id: "inventory", label: "Inventory", icon: Boxes, ownerOnly: false },
  { id: "orders", label: "Orders & parcels", icon: Truck, ownerOnly: false },
  { id: "employees", label: "Employees", icon: Users, ownerOnly: false },
  { id: "reports", label: "Reports", icon: BarChart3, ownerOnly: false },
  { id: "finance", label: "Finance", icon: Wallet, ownerOnly: true },
  { id: "accounts", label: "Accounts", icon: Landmark, ownerOnly: true },
  { id: "expenses", label: "Expenses", icon: TrendingDown, ownerOnly: true },
  { id: "affiliates", label: "Affiliates", icon: Share2, ownerOnly: true },
  { id: "team", label: "Team", icon: Users, ownerOnly: true },
];

const CHART_COLORS = ["#E8A33D", "#5B9BD5", "#3FB68A", "#E2574C", "#9B7EDE", "#4FC3C7"];

const accountName = (accounts, id) => ((accounts || []).find((a) => a.id === id) || {}).name || "—";

// Resources fetched on login. Owner-only ones are skipped for staff
// (the backend would 403 them anyway — no point making the calls).
const OWNER_ONLY_KEYS = new Set(["accounts", "expenses", "affiliates"]);
const ALL_KEYS = ["inventory", "orders", "employees", "affiliates", "accounts", "expenses"];

export default function App() {
  const [user, setUser] = useState(null); // { id, name, email, role } once logged in
  const [authChecked, setAuthChecked] = useState(false);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [data, setData] = useState({ inventory: [], orders: [], employees: [], affiliates: [], accounts: [], expenses: [] });
  const [toast, setToast] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  };

  // Restore session from a saved token on page load.
  useEffect(() => {
    (async () => {
      const token = getToken();
      if (token) {
        try {
          const { user: u } = await me();
          setUser(u);
        } catch {
          setToken(null); // token expired/invalid
        }
      }
      setAuthChecked(true);
    })();
  }, []);

  const loadAll = useCallback(async (role) => {
    setReady(false);
    const keys = ALL_KEYS.filter((k) => role === "owner" || !OWNER_ONLY_KEYS.has(k));
    const results = await Promise.all(keys.map((k) => api.list(k).catch(() => [])));
    setData((d) => {
      const next = { ...d };
      keys.forEach((k, i) => { next[k] = results[i]; });
      return next;
    });
    setReady(true);
  }, []);

  useEffect(() => {
    if (user) loadAll(user.role);
  }, [user, loadAll]);

  const role = user?.role || "staff";
  const logout = () => { setToken(null); setUser(null); };

  // Diff-based sync: apply the same list-transform functions the UI already
  // uses (add/edit/delete via array ops), then push whatever changed to the
  // API in the background. Keeps every downstream component's code exactly
  // as it was in the window.storage version — only this function changed.
  const update = (key, fn) => {
    setData((d) => {
      const oldList = d[key] || [];
      const newList = fn(oldList);
      reconcile(key, oldList, newList);
      return { ...d, [key]: newList };
    });
  };

  const reconcile = (key, oldList, newList) => {
    const oldIds = new Set(oldList.map((x) => x.id));
    const newIds = new Set(newList.map((x) => x.id));

    oldList.forEach((item) => {
      if (!newIds.has(item.id)) {
        api.remove(key, item.id).catch((err) => notify(`Couldn't delete: ${err.message}`));
      }
    });

    newList.forEach((item) => {
      if (!oldIds.has(item.id)) {
        const tempId = item.id;
        api.create(key, item)
          .then((created) => {
            setData((d) => ({
              ...d,
              [key]: d[key].map((x) => (x.id === tempId ? { ...x, ...created } : x)),
            }));
          })
          .catch((err) => notify(`Couldn't save: ${err.message}`));
      } else {
        const before = oldList.find((x) => x.id === item.id);
        if (before && JSON.stringify(before) !== JSON.stringify(item)) {
          api.update(key, item.id, item).catch((err) => notify(`Couldn't update: ${err.message}`));
        }
      }
    });
  };

  const runSync = async () => {
    setSyncing(true);
    try {
      const res = await syncWooCommerce();
      notify(
        res.affiliates && !res.affiliates.skipped
          ? `Synced ${res.ordersSynced} order(s), ${res.affiliates.synced} affiliate(s)`
          : `Synced ${res.ordersSynced} order(s) from WooCommerce`
      );
      await loadAll(role);
    } catch (err) {
      notify(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    const item = NAV.find((n) => n.id === tab);
    if (item && item.ownerOnly && role !== "owner") setTab("dashboard");
  }, [role, tab]);

  const metrics = useMemo(() => {
    const activeOrders = data.orders.filter((o) => o.status !== "Returned");
    const revenue = activeOrders.reduce((s, o) => s + Number(o.sell || 0), 0);
    const cogs = activeOrders.reduce((s, o) => s + Number(o.cost || 0), 0);
    const grossProfit = revenue - cogs;
    const salaries = data.employees.reduce((s, e) => s + Number(e.salary || 0), 0);
    const commissions = data.affiliates.reduce((s, a) => s + Number(a.commission || 0), 0);
    const totalExpenses = (data.expenses || []).reduce((s, x) => s + Number(x.amount || 0), 0);
    const netProfit = grossProfit - salaries - commissions - totalExpenses;
    const totalBalance = (data.accounts || []).reduce((s, a) => s + Number(a.balance || 0), 0);
    const receivable = data.orders
      .filter((o) => o.status !== "Returned")
      .reduce((s, o) => s + amountDueOf(o), 0);
    const payable =
      data.employees.filter((e) => e.status === "Pending").reduce((s, e) => s + Number(e.salary || 0), 0) +
      data.affiliates.filter((a) => a.payment === "Pending").reduce((s, a) => s + Number(a.commission || 0), 0);
    const lowStock = data.inventory.filter((i) => Number(i.quantity) <= Number(i.reorder));
    const activeParcels = data.orders.filter((o) => o.status === "Pending" || o.status === "Shipped").length;
    return { revenue, cogs, grossProfit, salaries, commissions, totalExpenses, netProfit, receivable, payable, lowStock, activeParcels, totalBalance };
  }, [data]);

  if (!authChecked) {
    return (
      <div style={{ background: COLORS.bg, minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textDim, fontFamily: "Inter, sans-serif" }}>
        Loading Munshi...
      </div>
    );
  }

  if (!user) {
    return <Login onLoggedIn={setUser} />;
  }

  if (!ready) {
    return (
      <div style={{ background: COLORS.bg, minHeight: 500, display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.textDim, fontFamily: "Inter, sans-serif" }}>
        Loading your data...
      </div>
    );
  }

  return (
    <div style={{ background: COLORS.bg, minHeight: 640, display: "flex", fontFamily: "'Inter', sans-serif", color: COLORS.text, borderRadius: 10, overflow: "hidden", border: `1px solid ${COLORS.border}` }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; }
        .mn-num { font-family: 'Space Grotesk', sans-serif; }
        .mn-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .mn-scroll::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 4px; }
        .mn-input {
          background: ${COLORS.surface2}; border: 1px solid ${COLORS.border}; color: ${COLORS.text};
          padding: 8px 10px; border-radius: 6px; font-size: 13px; font-family: inherit; width: 100%;
        }
        .mn-input:focus { outline: none; border-color: ${COLORS.accent}; }
        .mn-btn {
          display: inline-flex; align-items: center; gap: 6px; background: ${COLORS.accent}; color: #241804;
          border: none; padding: 8px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
          font-family: inherit;
        }
        .mn-btn:hover { filter: brightness(1.08); }
        .mn-btn-ghost {
          display: inline-flex; align-items: center; gap: 6px; background: transparent; color: ${COLORS.textDim};
          border: 1px solid ${COLORS.border}; padding: 7px 12px; border-radius: 6px; font-size: 13px; cursor: pointer;
          font-family: inherit;
        }
        .mn-btn-ghost:hover { color: ${COLORS.text}; border-color: ${COLORS.textDim}; }
        .mn-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .mn-table th { text-align: left; color: ${COLORS.textFaint}; font-weight: 500; font-size: 11.5px; letter-spacing: 0.02em; padding: 0 12px 8px; border-bottom: 1px solid ${COLORS.border}; }
        .mn-table td { padding: 11px 12px; border-bottom: 1px solid ${COLORS.borderSoft}; }
        .mn-table tr:last-child td { border-bottom: none; }
        select.mn-input { appearance: none; }
        .mn-spin { animation: mn-spin 1s linear infinite; }
        @keyframes mn-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      <Sidebar tab={tab} setTab={setTab} metrics={metrics} role={role} user={user} onLogout={logout} onSync={runSync} syncing={syncing} />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar tab={tab} role={role} />
        <div className="mn-scroll" style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
          {tab === "dashboard" && <Dashboard data={data} metrics={metrics} setTab={setTab} role={role} />}
          {tab === "pos" && <POS data={data} update={update} notify={notify} />}
          {tab === "inventory" && <Inventory items={data.inventory} update={(fn) => update("inventory", fn)} notify={notify} role={role} />}
          {tab === "orders" && <Orders orders={data.orders} accounts={data.accounts || []} update={(fn) => update("orders", fn)} updateAccounts={(fn) => update("accounts", fn)} notify={notify} role={role} />}
          {tab === "employees" && <Employees employees={data.employees} accounts={data.accounts || []} update={(fn) => update("employees", fn)} updateAccounts={(fn) => update("accounts", fn)} notify={notify} role={role} />}
          {tab === "reports" && <Reports data={data} />}
          {tab === "finance" && role === "owner" && <Finance data={data} metrics={metrics} />}
          {tab === "accounts" && role === "owner" && <Accounts accounts={data.accounts || []} update={(fn) => update("accounts", fn)} notify={notify} />}
          {tab === "expenses" && role === "owner" && <Expenses expenses={data.expenses || []} accounts={data.accounts || []} update={(fn) => update("expenses", fn)} updateAccounts={(fn) => update("accounts", fn)} notify={notify} />}
          {tab === "affiliates" && role === "owner" && <Affiliates affiliates={data.affiliates} accounts={data.accounts || []} update={(fn) => update("affiliates", fn)} updateAccounts={(fn) => update("accounts", fn)} notify={notify} />}
          {tab === "team" && role === "owner" && <Team notify={notify} currentUserId={user.id} />}
        </div>
      </div>

      {toast && (
        <div style={{ position: "absolute", bottom: 20, right: 20, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, color: COLORS.text, padding: "10px 16px", borderRadius: 8, fontSize: 13 }}>
          {toast}
        </div>
      )}
    </div>
  );
}

function Sidebar({ tab, setTab, metrics, role, user, onLogout, onSync, syncing }) {
  const alerts = metrics.lowStock.length;
  const visibleNav = NAV.filter((n) => !n.ownerOnly || role === "owner");
  return (
    <div style={{ width: 208, background: COLORS.surface, borderRight: `1px solid ${COLORS.border}`, padding: "20px 14px", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 8px", marginBottom: 16 }}>
        <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 17, color: COLORS.text, lineHeight: 1.2 }}>Zaira's Collection</div>
        <div style={{ fontSize: 11.5, color: COLORS.textFaint, marginTop: 2 }}>Business Manager</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: "8px 10px", marginBottom: 12 }}>
        {role === "owner" ? <ShieldCheck size={14} color={COLORS.accent} /> : <User size={14} color={COLORS.info} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{user?.name}</div>
          <div style={{ fontSize: 10.5, color: COLORS.textFaint }}>{role === "owner" ? "Owner" : "Staff"}</div>
        </div>
        <button onClick={onLogout} title="Log out" style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer", padding: 2 }}>
          <LogOut size={14} />
        </button>
      </div>
      {role === "owner" && (
        <button
          onClick={onSync} disabled={syncing} className="mn-btn-ghost"
          style={{ width: "100%", justifyContent: "center", marginBottom: 18, opacity: syncing ? 0.6 : 1 }}
        >
          <RefreshCw size={13} className={syncing ? "mn-spin" : ""} /> {syncing ? "Syncing..." : "Sync WooCommerce"}
        </button>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {visibleNav.map((n) => {
          const Icon = n.icon;
          const active = tab === n.id;
          const showAlert = n.id === "inventory" && alerts > 0;
          return (
            <button
              key={n.id}
              onClick={() => setTab(n.id)}
              style={{
                display: "flex", alignItems: "center", gap: 10, padding: "9px 10px", borderRadius: 7,
                background: active ? COLORS.surface2 : "transparent",
                border: "none", cursor: "pointer", textAlign: "left", width: "100%",
                color: active ? COLORS.text : COLORS.textDim, fontSize: 13.5, fontFamily: "inherit",
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon size={16} style={{ flexShrink: 0, color: active ? COLORS.accent : COLORS.textFaint }} />
              <span style={{ flex: 1 }}>{n.label}</span>
              {showAlert && (
                <span style={{ background: COLORS.negative, color: "#fff", fontSize: 10.5, fontWeight: 600, borderRadius: 10, padding: "1px 6px" }}>
                  {alerts}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div style={{ marginTop: "auto", padding: "12px 10px", borderTop: `1px solid ${COLORS.borderSoft}`, fontSize: 11.5, color: COLORS.textFaint }}>
        {role === "staff" ? "Staff view — cost, finance & profit hidden." : "Owner view — full access."} Data saves automatically.
      </div>
    </div>
  );
}

function TopBar({ tab, role }) {
  const label = NAV.find((n) => n.id === tab)?.label || "";
  const date = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <div style={{ padding: "18px 28px", borderBottom: `1px solid ${COLORS.border}`, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h2 style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 19, fontWeight: 600, margin: 0 }}>{label}</h2>
        <Badge text={role === "owner" ? "Owner view" : "Staff view"} tone={role === "owner" ? "accent" : "info"} />
      </div>
      <span style={{ fontSize: 12.5, color: COLORS.textFaint }}>{date}</span>
    </div>
  );
}

function StatCard({ label, value, sub, tone }) {
  const toneColor = tone === "positive" ? COLORS.positive : tone === "negative" ? COLORS.negative : COLORS.text;
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: "16px 18px" }}>
      <div style={{ fontSize: 12, color: COLORS.textDim, marginBottom: 8 }}>{label}</div>
      <div className="mn-num" style={{ fontSize: 23, fontWeight: 600, color: toneColor }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: COLORS.textFaint, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Badge({ text, tone }) {
  const map = {
    positive: [COLORS.positiveDim, COLORS.positive],
    negative: [COLORS.negativeDim, COLORS.negative],
    info: [COLORS.infoDim, COLORS.info],
    accent: [COLORS.accentDim, COLORS.accent],
  };
  const [bg, fg] = map[tone] || [COLORS.surface2, COLORS.textDim];
  return (
    <span style={{ background: bg, color: fg, fontSize: 11.5, fontWeight: 600, padding: "3px 9px", borderRadius: 5, whiteSpace: "nowrap" }}>
      {text}
    </span>
  );
}

const orderStatusTone = { Pending: "accent", Shipped: "info", Delivered: "positive", Returned: "negative" };
const paymentTone = { Paid: "positive", Partial: "accent", Pending: "negative" };

function Dashboard({ data, metrics, setTab }) {
  const recentOrders = [...data.orders].slice(-5).reverse();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12 }}>
        <StatCard label="Total revenue" value={fmt(metrics.revenue)} />
        <StatCard label="Net profit" value={fmt(metrics.netProfit)} tone={metrics.netProfit >= 0 ? "positive" : "negative"} />
        <StatCard label="Cash & bank balance" value={fmt(metrics.totalBalance)} sub="Across all accounts" />
        <StatCard label="Pending to receive" value={fmt(metrics.receivable)} tone="negative" sub="From customers" />
        <StatCard label="Pending to pay" value={fmt(metrics.payable)} tone="negative" sub="Salaries + commissions" />
        <StatCard label="Active parcels" value={metrics.activeParcels} sub="In transit or pending" />
        <StatCard label="Low stock items" value={metrics.lowStock.length} tone={metrics.lowStock.length ? "negative" : undefined} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
          <SectionHeading title="Recent orders" action={() => setTab("orders")} />
          {recentOrders.length === 0 ? (
            <EmptyRow text="No orders yet." />
          ) : (
            <table className="mn-table">
              <thead><tr><th>Order</th><th>Customer</th><th>Amount</th><th>Status</th><th>Payment</th></tr></thead>
              <tbody>
                {recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td>{o.orderNo}</td>
                    <td>{o.customer}</td>
                    <td className="mn-num">{fmt(o.sell)}</td>
                    <td><Badge text={o.status} tone={orderStatusTone[o.status]} /></td>
                    <td><Badge text={paymentStatusOf(o)} tone={paymentTone[paymentStatusOf(o)]} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
          <SectionHeading title="Low stock alerts" action={() => setTab("inventory")} />
          {metrics.lowStock.length === 0 ? (
            <EmptyRow text="Sab kuch stock mein hai." />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {metrics.lowStock.map((i) => (
                <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                  <AlertTriangle size={14} color={COLORS.negative} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{i.name}</span>
                  <span className="mn-num" style={{ color: COLORS.negative }}>{i.quantity} left</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, action, actionLabel }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
      <h3 style={{ fontSize: 14.5, fontWeight: 600, margin: 0 }}>{title}</h3>
      {action && (
        <button onClick={action} style={{ background: "none", border: "none", color: COLORS.textFaint, fontSize: 12, display: "flex", alignItems: "center", gap: 2, cursor: "pointer", fontFamily: "inherit" }}>
          {actionLabel || "View all"} <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

function EmptyRow({ text }) {
  return <div style={{ color: COLORS.textFaint, fontSize: 13, padding: "20px 0", textAlign: "center" }}>{text}</div>;
}

function Panel({ title, count, onAdd, addLabel, children, extra }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 13, color: COLORS.textDim }}>{count}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {extra}
          <button className="mn-btn" onClick={onAdd}><Plus size={14} /> {addLabel}</button>
        </div>
      </div>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, overflow: "hidden" }}>
        {children}
      </div>
    </div>
  );
}

function AddForm({ fields, onCancel, onSave, title, initialValues }) {
  const [vals, setVals] = useState(() =>
    Object.fromEntries(fields.map((f) => [f.key, initialValues?.[f.key] ?? f.default ?? ""]))
  );
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const submit = () => {
    for (const f of fields) {
      if (f.required && !String(vals[f.key]).trim()) return;
    }
    onSave(vals);
  };

  // Resizes/compresses the picked image in the browser and turns it into a
  // base64 data URL, which is stored directly in the existing `image` text
  // column — no file storage server needed for a small product catalog.
  const handleImageFile = (key, file) => {
    if (!file) return;
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        const maxDim = 600;
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        set(key, canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={{ padding: 18, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surface2 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</span>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer" }}><X size={16} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10 }}>
        {fields.map((f) => (
          <div key={f.key}>
            <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>{f.label}</label>
            {f.type === "select" ? (
              <select className="mn-input" value={vals[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : f.type === "file" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Thumb url={vals[f.key]} />
                <input
                  type="file" accept="image/*"
                  onChange={(e) => handleImageFile(f.key, e.target.files[0])}
                  style={{ fontSize: 11, color: COLORS.textDim, maxWidth: 130 }}
                />
              </div>
            ) : (
              <input
                className="mn-input"
                type={f.type || "text"}
                value={vals[f.key]}
                placeholder={f.placeholder || ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <button className="mn-btn" onClick={submit}>Save</button>
        <button className="mn-btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Thumb({ url }) {
  const [broken, setBroken] = useState(false);
  return (
    <div style={{ width: 34, height: 34, borderRadius: 6, overflow: "hidden", background: COLORS.surface2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      {url && !broken ? (
        <img src={url} onError={() => setBroken(true)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : (
        <ImageIcon size={14} color={COLORS.textFaint} />
      )}
    </div>
  );
}

function Inventory({ items, update, notify, role }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [q, setQ] = useState("");
  const isOwner = role === "owner";
  const filtered = items.filter((i) => (i.name + i.sku + i.category).toLowerCase().includes(q.toLowerCase()));
  const editingItem = items.find((i) => i.id === editingId);

  const baseFields = [
    { key: "name", label: "Item name", required: true },
    { key: "sku", label: "SKU", required: true },
    { key: "category", label: "Category", type: "select", options: ["Unstitched", "Stitched", "Best Sellers", "New Arrivals", "Summer", "Winter", "Sale"] },
    { key: "image", label: "Photo (optional)", type: "file" },
    { key: "quantity", label: "Quantity", type: "number", default: 0 },
    { key: "reorder", label: "Reorder level", type: "number", default: 5 },
    ...(isOwner ? [{ key: "cost", label: "Cost price (Rs)", type: "number", default: 0 }] : []),
    { key: "price", label: "Selling price (Rs)", type: "number", default: 0 },
  ];

  return (
    <Panel
      title="Inventory" addLabel="Add item" onAdd={() => setAdding(true)}
      count={`${items.length} items`}
      extra={<SearchBox value={q} onChange={setQ} />}
    >
      {adding && (
        <AddForm
          title="New inventory item" fields={baseFields} onCancel={() => setAdding(false)}
          onSave={(v) => {
            update((list) => [...list, { id: genId(), ...v, quantity: Number(v.quantity), reorder: Number(v.reorder), cost: Number(v.cost || 0), price: Number(v.price) }]);
            setAdding(false);
            notify("Item added");
          }}
        />
      )}
      {editingItem && (
        <AddForm
          title={`Edit — ${editingItem.name}`} fields={baseFields} initialValues={editingItem} onCancel={() => setEditingId(null)}
          onSave={(v) => {
            update((list) => list.map((x) => x.id === editingId
              ? { ...x, ...v, quantity: Number(v.quantity), reorder: Number(v.reorder), cost: isOwner ? Number(v.cost || 0) : x.cost, price: Number(v.price) }
              : x
            ));
            setEditingId(null);
            notify("Item updated");
          }}
        />
      )}
      {filtered.length === 0 ? <EmptyRow text="Koi item nahi mila." /> : (
        <table className="mn-table">
          <thead><tr><th></th><th>Item</th><th>SKU</th><th>Category</th><th>Qty</th>{isOwner && <th>Cost</th>}<th>Price</th><th></th></tr></thead>
          <tbody>
            {filtered.map((i) => {
              const low = Number(i.quantity) <= Number(i.reorder);
              return (
                <tr key={i.id}>
                  <td><Thumb url={i.image} /></td>
                  <td>{i.name}</td>
                  <td style={{ color: COLORS.textFaint }}>{i.sku}</td>
                  <td style={{ color: COLORS.textDim }}>{i.category}</td>
                  <td className="mn-num" style={{ color: low ? COLORS.negative : COLORS.text }}>{i.quantity}{low && " ⚠"}</td>
                  {isOwner && <td className="mn-num">{fmt(i.cost)}</td>}
                  <td className="mn-num">{fmt(i.price)}</td>
                  <td style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <button onClick={() => setEditingId(i.id)} title="Edit" style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer", padding: 2 }}>
                      <Pencil size={14} />
                    </button>
                    {isOwner && <DeleteBtn onClick={() => update((list) => list.filter((x) => x.id !== i.id))} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function PaymentEditor({ order, accounts, onSave, onClose }) {
  const [amountPaid, setAmountPaid] = useState(order.amountPaid || 0);
  const [dueDate, setDueDate] = useState(order.dueDate || "");
  const [accountId, setAccountId] = useState((accounts && accounts[0] && accounts[0].id) || "");
  const due = Math.max(0, Number(order.sell || 0) - Number(amountPaid || 0));
  const delta = Number(amountPaid || 0) - Number(order.amountPaid || 0);
  return (
    <div style={{ position: "absolute", zIndex: 10, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 12, width: 230, boxShadow: "0 8px 20px rgba(0,0,0,0.35)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Record payment</span>
        <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer" }}><X size={14} /></button>
      </div>
      <label style={{ fontSize: 10.5, color: COLORS.textFaint, display: "block", marginBottom: 3 }}>Total bill: {fmt(order.sell)}</label>
      <label style={{ fontSize: 10.5, color: COLORS.textFaint, display: "block", marginBottom: 3, marginTop: 6 }}>Amount received (Rs)</label>
      <input className="mn-input" type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button className="mn-btn-ghost" style={{ fontSize: 11, padding: "5px 8px" }} onClick={() => setAmountPaid(0)}>Mark udhar</button>
        <button className="mn-btn-ghost" style={{ fontSize: 11, padding: "5px 8px" }} onClick={() => setAmountPaid(order.sell)}>Mark full paid</button>
      </div>
      <div style={{ fontSize: 11, color: due > 0 ? COLORS.negative : COLORS.positive, margin: "8px 0" }}>
        {due > 0 ? `Due: ${fmt(due)}` : "Fully paid"}
      </div>
      {due > 0 && (
        <>
          <label style={{ fontSize: 10.5, color: COLORS.textFaint, display: "block", marginBottom: 3 }}>Due date (optional)</label>
          <input className="mn-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </>
      )}
      {delta > 0 && accounts && accounts.length > 0 && (
        <>
          <label style={{ fontSize: 10.5, color: COLORS.textFaint, display: "block", marginBottom: 3, marginTop: 8 }}>Received into account</label>
          <select className="mn-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </>
      )}
      <button className="mn-btn" style={{ width: "100%", justifyContent: "center", marginTop: 10 }} onClick={() => onSave({ amountPaid: Number(amountPaid) || 0, dueDate: due > 0 ? dueDate : "" }, delta > 0 ? accountId : null, delta)}>Save</button>
    </div>
  );
}

function Orders({ orders, accounts, update, updateAccounts, notify, role }) {
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const isOwner = role === "owner";
  const fields = [
    { key: "orderNo", label: "Order No", default: "ORD-" + Math.floor(1000 + Math.random() * 9000), required: true },
    { key: "customer", label: "Customer name", required: true },
    { key: "product", label: "Product" },
    { key: "qty", label: "Qty", type: "number", default: 1 },
    { key: "sell", label: "Sale amount (Rs)", type: "number", default: 0 },
    ...(isOwner ? [{ key: "cost", label: "Cost amount (Rs)", type: "number", default: 0 }] : []),
    { key: "courier", label: "Courier", type: "select", options: ["Leopards", "TCS", "M&P", "Trax", "PostEx", "Other"] },
    { key: "tracking", label: "Tracking No" },
    { key: "status", label: "Status", type: "select", options: ["Pending", "Shipped", "Delivered", "Returned"] },
    { key: "amountPaid", label: "Amount received now (Rs)", type: "number", default: 0 },
    { key: "method", label: "Payment method", type: "select", options: ["COD", "Bank Transfer", "JazzCash", "EasyPaisa"] },
  ];

  const cycleStatus = (o) => {
    const order = ["Pending", "Shipped", "Delivered", "Returned"];
    const next = order[(order.indexOf(o.status) + 1) % order.length];
    update((list) => list.map((x) => (x.id === o.id ? { ...x, status: next } : x)));
  };
  const savePayment = (o, patch, accountId, delta) => {
    update((list) => list.map((x) => (x.id === o.id ? { ...x, ...patch } : x)));
    if (accountId && delta > 0 && updateAccounts) {
      updateAccounts((list) => list.map((a) => (a.id === accountId ? { ...a, balance: Number(a.balance || 0) + delta } : a)));
    }
    setEditingId(null);
  };

  return (
    <Panel title="Orders & parcels" addLabel="Add order" onAdd={() => setAdding(true)} count={`${orders.length} orders`}>
      {adding && (
        <AddForm
          title="New order" fields={fields} onCancel={() => setAdding(false)}
          onSave={(v) => {
            update((list) => [...list, { id: genId(), ...v, qty: Number(v.qty), sell: Number(v.sell), cost: Number(v.cost || 0), amountPaid: Number(v.amountPaid || 0), dueDate: "", date: todayISO() }]);
            setAdding(false);
            notify("Order added");
          }}
        />
      )}
      {orders.length === 0 ? <EmptyRow text="Abhi tak koi order nahi." /> : (
        <table className="mn-table">
          <thead><tr><th>Order</th><th>Customer</th><th>Product</th><th>Amount</th><th>Courier / Tracking</th><th>Status</th><th>Payment</th>{isOwner && <th></th>}</tr></thead>
          <tbody>
            {orders.map((o) => {
              const pStatus = paymentStatusOf(o);
              const due = amountDueOf(o);
              return (
                <tr key={o.id}>
                  <td>{o.orderNo}</td>
                  <td>{o.customer}</td>
                  <td style={{ color: COLORS.textDim }}>{o.product}{o.qty ? ` ×${o.qty}` : ""}</td>
                  <td className="mn-num">{fmt(o.sell)}</td>
                  <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{o.courier || "—"}{o.tracking ? ` · ${o.tracking}` : ""}</td>
                  <td><button onClick={() => cycleStatus(o)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}><Badge text={o.status} tone={orderStatusTone[o.status]} /></button></td>
                  <td style={{ position: "relative" }}>
                    <button onClick={() => setEditingId(editingId === o.id ? null : o.id)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}>
                      <Badge text={pStatus} tone={paymentTone[pStatus]} />
                      {due > 0 && <div style={{ fontSize: 10.5, color: COLORS.textFaint, marginTop: 3 }}>Due {fmt(due)}{o.dueDate ? ` · ${o.dueDate}` : ""}</div>}
                    </button>
                    {editingId === o.id && (
                      <PaymentEditor order={o} accounts={accounts || []} onClose={() => setEditingId(null)} onSave={(patch, accountId, delta) => savePayment(o, patch, accountId, delta)} />
                    )}
                  </td>
                  {isOwner && <td><DeleteBtn onClick={() => update((list) => list.filter((x) => x.id !== o.id))} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Employees({ employees, accounts, update, updateAccounts, notify, role }) {
  const [adding, setAdding] = useState(false);
  const isOwner = role === "owner";
  const fields = [
    { key: "name", label: "Name", required: true },
    { key: "role", label: "Role" },
    { key: "salary", label: "Monthly salary (Rs)", type: "number", default: 0 },
    { key: "phone", label: "Phone" },
    { key: "joined", label: "Join date", type: "date", default: todayISO() },
    { key: "status", label: "This month's salary", type: "select", options: ["Pending", "Paid"] },
  ];
  const markPaid = (e, accountId) => {
    if (accountId && updateAccounts) updateAccounts((list) => list.map((a) => (a.id === accountId ? { ...a, balance: Number(a.balance || 0) - Number(e.salary || 0) } : a)));
    update((list) => list.map((x) => (x.id === e.id ? { ...x, status: "Paid", paidFrom: accountId || "" } : x)));
  };
  const markPending = (e) => {
    if (e.paidFrom && updateAccounts) updateAccounts((list) => list.map((a) => (a.id === e.paidFrom ? { ...a, balance: Number(a.balance || 0) + Number(e.salary || 0) } : a)));
    update((list) => list.map((x) => (x.id === e.id ? { ...x, status: "Pending", paidFrom: "" } : x)));
  };

  return (
    <Panel title="Employees" addLabel="Add employee" onAdd={() => setAdding(true)} count={`${employees.length} employees`}>
      {adding && (
        <AddForm
          title="New employee" fields={fields} onCancel={() => setAdding(false)}
          onSave={(v) => {
            update((list) => [...list, { id: genId(), ...v, salary: Number(v.salary), paidFrom: "" }]);
            setAdding(false);
            notify("Employee added");
          }}
        />
      )}
      {employees.length === 0 ? <EmptyRow text="Koi employee add nahi hua." /> : (
        <table className="mn-table">
          <thead><tr><th>Name</th><th>Role</th>{isOwner && <th>Salary</th>}<th>Phone</th><th>Joined</th>{isOwner && <th>This month</th>}{isOwner && <th></th>}</tr></thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td style={{ color: COLORS.textDim }}>{e.role}</td>
                {isOwner && <td className="mn-num">{fmt(e.salary)}</td>}
                <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{e.phone}</td>
                <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{e.joined}</td>
                {isOwner && (
                  <td>
                    {e.status === "Paid" ? (
                      <button onClick={() => markPending(e)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}><Badge text="Paid" tone="positive" /></button>
                    ) : (
                      <select className="mn-input" style={{ fontSize: 11, padding: "4px 6px", width: 130 }} value="" onChange={(ev) => { if (ev.target.value) markPaid(e, ev.target.value); }}>
                        <option value="">Pay from...</option>
                        {(accounts || []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    )}
                  </td>
                )}
                {isOwner && <td><DeleteBtn onClick={() => update((list) => list.filter((x) => x.id !== e.id))} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Affiliates({ affiliates, accounts, update, updateAccounts, notify }) {
  const [adding, setAdding] = useState(false);
  const fields = [
    { key: "name", label: "Affiliate / partner", required: true },
    { key: "platform", label: "Platform", type: "select", options: ["Website", "Instagram", "TikTok", "Facebook", "Pinterest", "WhatsApp", "Other"] },
    { key: "rate", label: "Commission rate (%)", type: "number", default: 10 },
    { key: "sales", label: "Sales generated (Rs)", type: "number", default: 0 },
    { key: "commission", label: "Commission owed (Rs)", type: "number", default: 0 },
    { key: "status", label: "Status", type: "select", options: ["Active", "Inactive"] },
  ];
  const markPaid = (a, accountId) => {
    if (accountId && updateAccounts) updateAccounts((list) => list.map((x) => (x.id === accountId ? { ...x, balance: Number(x.balance || 0) - Number(a.commission || 0) } : x)));
    update((list) => list.map((x) => (x.id === a.id ? { ...x, payment: "Paid", paidFrom: accountId || "" } : x)));
  };
  const markPending = (a) => {
    if (a.paidFrom && updateAccounts) updateAccounts((list) => list.map((x) => (x.id === a.paidFrom ? { ...x, balance: Number(x.balance || 0) + Number(a.commission || 0) } : x)));
    update((list) => list.map((x) => (x.id === a.id ? { ...x, payment: "Pending", paidFrom: "" } : x)));
  };

  return (
    <Panel title="Affiliates" addLabel="Add affiliate" onAdd={() => setAdding(true)} count={`${affiliates.length} partners`}>
      {adding && (
        <AddForm
          title="New affiliate" fields={fields} onCancel={() => setAdding(false)}
          onSave={(v) => {
            update((list) => [...list, { id: genId(), ...v, rate: Number(v.rate), sales: Number(v.sales), commission: Number(v.commission), payment: "Pending", paidFrom: "" }]);
            setAdding(false);
            notify("Affiliate added");
          }}
        />
      )}
      {affiliates.length === 0 ? <EmptyRow text="Koi affiliate add nahi hua." /> : (
        <>
          <table className="mn-table">
            <thead><tr><th>Partner</th><th>Platform</th><th>Rate</th><th>Sales</th><th>Commission</th><th>Net profit</th><th>Status</th><th>Payment</th><th></th></tr></thead>
            <tbody>
              {affiliates.map((a) => {
                const netProfit = Number(a.sales || 0) - Number(a.commission || 0);
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td style={{ color: COLORS.textDim }}>{a.platform}</td>
                    <td className="mn-num">{a.rate}%</td>
                    <td className="mn-num">{fmt(a.sales)}</td>
                    <td className="mn-num">{fmt(a.commission)}</td>
                    <td className="mn-num" style={{ color: netProfit >= 0 ? COLORS.positive : COLORS.negative }}>{fmt(netProfit)}</td>
                    <td><Badge text={a.status} tone={a.status === "Active" ? "info" : undefined} /></td>
                    <td>
                      {a.payment === "Paid" ? (
                        <button onClick={() => markPending(a)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}><Badge text="Paid" tone="positive" /></button>
                      ) : (
                        <select className="mn-input" style={{ fontSize: 11, padding: "4px 6px", width: 130 }} value="" onChange={(ev) => { if (ev.target.value) markPaid(a, ev.target.value); }}>
                          <option value="">Pay from...</option>
                          {(accounts || []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td><DeleteBtn onClick={() => update((list) => list.filter((x) => x.id !== a.id))} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(() => {
            const totalSales = affiliates.reduce((s, a) => s + Number(a.sales || 0), 0);
            const totalCommission = affiliates.reduce((s, a) => s + Number(a.commission || 0), 0);
            const totalNet = totalSales - totalCommission;
            return (
              <div style={{ display: "flex", gap: 24, padding: "12px 18px", borderTop: `1px solid ${COLORS.borderSoft}`, fontSize: 12.5 }}>
                <span style={{ color: COLORS.textFaint }}>Total sales: <b style={{ color: COLORS.text }}>{fmt(totalSales)}</b></span>
                <span style={{ color: COLORS.textFaint }}>Total commission: <b style={{ color: COLORS.text }}>{fmt(totalCommission)}</b></span>
                <span style={{ color: COLORS.textFaint }}>Net profit: <b style={{ color: totalNet >= 0 ? COLORS.positive : COLORS.negative }}>{fmt(totalNet)}</b></span>
              </div>
            );
          })()}
        </>
      )}
    </Panel>
  );
}

function Team({ notify, currentUserId }) {
  const [users, setUsers] = useState(null); // null = loading
  const [adding, setAdding] = useState(false);

  const load = () => {
    listUsers()
      .then(setUsers)
      .catch((err) => notify(`Couldn't load team: ${err.message}`));
  };
  useEffect(load, []);

  const fields = [
    { key: "name", label: "Full name", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "password", label: "Temporary password", required: true },
    { key: "role", label: "Access level", type: "select", options: ["staff", "owner"], default: "staff" },
  ];

  const addUser = (v) => {
    createUser(v)
      .then((created) => {
        setUsers((list) => [...(list || []), created]);
        setAdding(false);
        notify(`${created.name} can now log in`);
      })
      .catch((err) => notify(`Couldn't add: ${err.message}`));
  };

  const remove = (u) => {
    if (!window.confirm(`Remove ${u.name}'s login? They won't be able to sign in anymore.`)) return;
    removeUser(u.id)
      .then(() => {
        setUsers((list) => list.filter((x) => x.id !== u.id));
        notify(`${u.name} removed`);
      })
      .catch((err) => notify(`Couldn't remove: ${err.message}`));
  };

  return (
    <Panel title="Team" addLabel="Add teammate" onAdd={() => setAdding(true)} count={users ? `${users.length} logins` : "Loading..."}>
      {adding && (
        <AddForm
          title="New login" fields={fields} onCancel={() => setAdding(false)}
          onSave={addUser}
        />
      )}
      {!users ? (
        <EmptyRow text="Loading team..." />
      ) : users.length === 0 ? (
        <EmptyRow text="No teammates added yet." />
      ) : (
        <table className="mn-table">
          <thead><tr><th>Name</th><th>Email</th><th>Access</th><th>Added</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td style={{ color: COLORS.textDim }}>{u.email}</td>
                <td><Badge text={u.role === "owner" ? "Owner" : "Staff"} tone={u.role === "owner" ? "accent" : "info"} /></td>
                <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{String(u.created_at).slice(0, 10)}</td>
                <td>{u.id !== currentUserId && <DeleteBtn onClick={() => remove(u)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div style={{ padding: "12px 18px", fontSize: 11.5, color: COLORS.textFaint, borderTop: `1px solid ${COLORS.borderSoft}` }}>
        Staff logins see Inventory, Orders, POS, Employees, and Reports — cost, salary, profit, finance, accounts, expenses, affiliates, and delete buttons stay hidden. Owner logins see everything.
      </div>
    </Panel>
  );
}

function RowLine({ label, value, bold, negative }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: bold ? 13.5 : 12.5, fontWeight: bold ? 700 : 400, color: negative ? COLORS.negative : COLORS.text, padding: "3px 0" }}>
      <span>{label}</span><span className="mn-num">{fmt(value)}</span>
    </div>
  );
}

function ReceiptView({ receipt, onNew }) {
  const due = Math.max(0, receipt.sell - receipt.amountPaid);
  return (
    <div style={{ maxWidth: 380, margin: "0 auto" }}>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 22 }}>
        <div style={{ textAlign: "center", marginBottom: 14 }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontWeight: 700, fontSize: 17 }}>Zaira's Collection</div>
          <div style={{ fontSize: 11, color: COLORS.textFaint }}>zairascollection.com</div>
        </div>
        <div style={{ fontSize: 12, color: COLORS.textDim, display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <span>{receipt.orderNo}</span><span>{receipt.date}</span>
        </div>
        <div style={{ fontSize: 12, marginBottom: 10 }}>Customer: {receipt.customer}{receipt.phone ? ` · ${receipt.phone}` : ""}</div>
        <div style={{ borderTop: `1px dashed ${COLORS.border}`, borderBottom: `1px dashed ${COLORS.border}`, padding: "10px 0", margin: "10px 0" }}>
          {receipt.items.map((it) => (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 6 }}>
              <span>{it.name} ×{it.qty}</span>
              <span className="mn-num">{fmt(it.price * it.qty)}</span>
            </div>
          ))}
        </div>
        <RowLine label="Subtotal" value={receipt.subtotal} />
        {receipt.discount > 0 && <RowLine label="Discount" value={-receipt.discount} />}
        <RowLine label="Total" value={receipt.sell} bold />
        <RowLine label="Amount paid" value={receipt.amountPaid} />
        {due > 0 && <RowLine label="Balance due" value={due} negative />}
        {receipt.method && <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 8 }}>Paid via {receipt.method}</div>}
        <div style={{ fontSize: 11, color: COLORS.textFaint, marginTop: 12, textAlign: "center" }}>Shukriya! Dobara tashreef laayen.</div>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "center" }}>
        <button className="mn-btn" onClick={() => window.print()}><Printer size={14} /> Print</button>
        <button className="mn-btn-ghost" onClick={onNew}>New bill</button>
      </div>
    </div>
  );
}

function POS({ data, update, notify }) {
  const [cart, setCart] = useState([]);
  const [search, setSearch] = useState("");
  const [scanCode, setScanCode] = useState("");
  const [customer, setCustomer] = useState("");
  const [phone, setPhone] = useState("");
  const [discount, setDiscount] = useState(0);
  const [mode, setMode] = useState("Paid");
  const [partialAmount, setPartialAmount] = useState(0);
  const [dueDate, setDueDate] = useState("");
  const [method, setMethod] = useState("COD");
  const [status, setStatus] = useState("Delivered");
  const [accountId, setAccountId] = useState((data.accounts && data.accounts[0] && data.accounts[0].id) || "");
  const [receipt, setReceipt] = useState(null);

  const items = data.inventory.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()));

  const addToCart = (item) => {
    setCart((c) => {
      const found = c.find((x) => x.id === item.id);
      if (found) return c.map((x) => (x.id === item.id ? { ...x, qty: x.qty + 1 } : x));
      return [...c, { id: item.id, name: item.name, price: Number(item.price), cost: Number(item.cost), qty: 1 }];
    });
  };
  const handleScan = (e) => {
    if (e.key !== "Enter") return;
    const code = scanCode.trim().toLowerCase();
    if (!code) return;
    const match = data.inventory.find((i) => (i.sku || "").toLowerCase() === code);
    if (match) {
      addToCart(match);
      notify(`${match.name} added`);
    } else {
      notify("SKU not found");
    }
    setScanCode("");
  };
  const changeQty = (id, delta) => {
    setCart((c) => c.map((x) => (x.id === id ? { ...x, qty: Math.max(1, x.qty + delta) } : x)).filter((x) => x.qty > 0));
  };
  const removeItem = (id) => setCart((c) => c.filter((x) => x.id !== id));

  const subtotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
  const costTotal = cart.reduce((s, c) => s + c.cost * c.qty, 0);
  const total = Math.max(0, subtotal - Number(discount || 0));

  const generateBill = () => {
    if (cart.length === 0) return;
    const orderNo = "INV-" + Math.floor(1000 + Math.random() * 9000);
    const productsSummary = cart.map((c) => `${c.name} x${c.qty}`).join(", ");
    const totalQty = cart.reduce((s, c) => s + c.qty, 0);
    const amountPaid = mode === "Paid" ? total : mode === "Partial" ? Number(partialAmount) || 0 : 0;
    const newOrder = {
      id: genId(), orderNo, customer: customer || "Walk-in customer", phone, product: productsSummary,
      qty: totalQty, sell: total, cost: costTotal, courier: "In-store", tracking: "", status,
      amountPaid, dueDate: amountPaid < total ? dueDate : "", method, date: todayISO(),
    };
    update("orders", (list) => [...list, newOrder]);
    update("inventory", (list) => list.map((inv) => {
      const c = cart.find((x) => x.id === inv.id);
      if (!c) return inv;
      return { ...inv, quantity: Math.max(0, Number(inv.quantity) - c.qty) };
    }));
    if (amountPaid > 0 && accountId) {
      update("accounts", (list) => list.map((a) => (a.id === accountId ? { ...a, balance: Number(a.balance || 0) + amountPaid } : a)));
    }
    setReceipt({ ...newOrder, items: cart, discount: Number(discount || 0), subtotal });
    setCart([]); setCustomer(""); setPhone(""); setDiscount(0); setPartialAmount(0); setDueDate("");
    notify("Bill generated");
  };

  if (receipt) return <ReceiptView receipt={receipt} onNew={() => setReceipt(null)} />;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, alignItems: "start" }}>
      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
        <SectionHeading title="Select products" />
        <div style={{ position: "relative", marginBottom: 10 }}>
          <ScanLine size={14} style={{ position: "absolute", left: 9, top: 9, color: COLORS.accent }} />
          <input
            className="mn-input" style={{ paddingLeft: 30 }}
            placeholder="Scan barcode or type SKU + Enter"
            value={scanCode}
            onChange={(e) => setScanCode(e.target.value)}
            onKeyDown={handleScan}
          />
        </div>
        <SearchBox value={search} onChange={setSearch} />
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6, maxHeight: 380, overflowY: "auto" }} className="mn-scroll">
          {items.length === 0 ? <EmptyRow text="Koi item nahi mila." /> : items.map((i) => (
            <button key={i.id} onClick={() => addToCart(i)} style={{ display: "flex", alignItems: "center", gap: 10, background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 8, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
              <Thumb url={i.image} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: COLORS.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{i.name}</div>
                <div style={{ fontSize: 11, color: COLORS.textFaint }}>{i.sku} · {i.quantity} in stock</div>
              </div>
              <div className="mn-num" style={{ fontSize: 13, color: COLORS.accent }}>{fmt(i.price)}</div>
              <Plus size={14} color={COLORS.textFaint} />
            </button>
          ))}
        </div>
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
        <SectionHeading title="Bill" />
        {cart.length === 0 ? <EmptyRow text="Cart khali hai — product select karein." /> : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
            {cart.map((c) => (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</span>
                <button onClick={() => changeQty(c.id, -1)} style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 4, width: 20, height: 20, color: COLORS.text, cursor: "pointer" }}><Minus size={11} /></button>
                <span className="mn-num" style={{ width: 18, textAlign: "center" }}>{c.qty}</span>
                <button onClick={() => changeQty(c.id, 1)} style={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 4, width: 20, height: 20, color: COLORS.text, cursor: "pointer" }}><Plus size={11} /></button>
                <span className="mn-num" style={{ width: 70, textAlign: "right" }}>{fmt(c.price * c.qty)}</span>
                <button onClick={() => removeItem(c.id)} style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer" }}><X size={13} /></button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
          <input className="mn-input" placeholder="Customer name" value={customer} onChange={(e) => setCustomer(e.target.value)} />
          <input className="mn-input" placeholder="Phone (optional)" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>

        <RowLine label="Subtotal" value={subtotal} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
          <span style={{ fontSize: 12.5 }}>Discount (Rs)</span>
          <input className="mn-input" type="number" style={{ width: 90, textAlign: "right" }} value={discount} onChange={(e) => setDiscount(e.target.value)} />
        </div>
        <RowLine label="Total" value={total} bold />

        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Payment</label>
          <div style={{ display: "flex", gap: 6 }}>
            {["Paid", "Partial", "Pending"].map((m) => (
              <button key={m} onClick={() => setMode(m)} style={{ flex: 1, padding: "7px 4px", borderRadius: 6, fontSize: 12, fontFamily: "inherit", fontWeight: 600, cursor: "pointer", border: `1px solid ${mode === m ? COLORS.accent : COLORS.border}`, background: mode === m ? COLORS.accentDim : "transparent", color: mode === m ? COLORS.accent : COLORS.textDim }}>
                {m === "Pending" ? "Udhar" : m}
              </button>
            ))}
          </div>
        </div>

        {mode === "Partial" && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Amount received now (Rs)</label>
            <input className="mn-input" type="number" value={partialAmount} onChange={(e) => setPartialAmount(e.target.value)} />
          </div>
        )}
        {(mode === "Partial" || mode === "Pending") && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Due date (optional)</label>
            <input className="mn-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
          <select className="mn-input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {["COD", "Bank Transfer", "JazzCash", "EasyPaisa"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <select className="mn-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            {["Delivered", "Pending", "Shipped"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>

        {mode !== "Pending" && (data.accounts || []).length > 0 && (
          <div style={{ marginTop: 10 }}>
            <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Receive into account</label>
            <select className="mn-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}

        <button className="mn-btn" style={{ width: "100%", justifyContent: "center", marginTop: 14 }} onClick={generateBill} disabled={cart.length === 0}>
          <Receipt size={14} /> Generate bill
        </button>
      </div>
    </div>
  );
}

function Accounts({ accounts, update, notify }) {
  const [adding, setAdding] = useState(false);
  const fields = [
    { key: "name", label: "Account name", required: true, placeholder: "e.g. Meezan Bank" },
    { key: "type", label: "Type", type: "select", options: ["Cash", "Bank", "JazzCash", "EasyPaisa", "Other"] },
    { key: "balance", label: "Opening balance (Rs)", type: "number", default: 0 },
  ];
  const total = accounts.reduce((s, a) => s + Number(a.balance || 0), 0);
  return (
    <Panel title="Accounts" addLabel="Add account" onAdd={() => setAdding(true)} count={`${accounts.length} accounts · Total ${fmt(total)}`}>
      {adding && (
        <AddForm
          title="New account" fields={fields} onCancel={() => setAdding(false)}
          onSave={(v) => {
            update((list) => [...list, { id: genId(), ...v, balance: Number(v.balance) }]);
            setAdding(false);
            notify("Account added");
          }}
        />
      )}
      {accounts.length === 0 ? <EmptyRow text="Koi account add nahi hua." /> : (
        <table className="mn-table">
          <thead><tr><th>Account</th><th>Type</th><th>Balance</th><th></th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td><Badge text={a.type} tone="info" /></td>
                <td className="mn-num" style={{ color: Number(a.balance) < 0 ? COLORS.negative : COLORS.text }}>{fmt(a.balance)}</td>
                <td><DeleteBtn onClick={() => update((list) => list.filter((x) => x.id !== a.id))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Expenses({ expenses, accounts, update, updateAccounts, notify }) {
  const [adding, setAdding] = useState(false);
  const total = expenses.reduce((s, x) => s + Number(x.amount || 0), 0);
  return (
    <Panel title="Expenses" addLabel="Add expense" onAdd={() => setAdding(true)} count={`${expenses.length} expenses · Total ${fmt(total)}`}>
      {adding && (
        <div style={{ padding: 18, borderBottom: `1px solid ${COLORS.border}`, background: COLORS.surface2 }}>
          <ExpenseForm
            accounts={accounts || []}
            onCancel={() => setAdding(false)}
            onSave={(v) => {
              update((list) => [...list, { id: genId(), ...v, amount: Number(v.amount) }]);
              if (v.accountId) updateAccounts((list) => list.map((a) => (a.id === v.accountId ? { ...a, balance: Number(a.balance || 0) - Number(v.amount) } : a)));
              setAdding(false);
              notify("Expense added");
            }}
          />
        </div>
      )}
      {expenses.length === 0 ? <EmptyRow text="Koi expense record nahi." /> : (
        <table className="mn-table">
          <thead><tr><th>Expense</th><th>Category</th><th>Amount</th><th>Account</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {expenses.map((x) => (
              <tr key={x.id}>
                <td>{x.title}</td>
                <td style={{ color: COLORS.textDim }}>{x.category}</td>
                <td className="mn-num" style={{ color: COLORS.negative }}>{fmt(x.amount)}</td>
                <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{accountName(accounts || [], x.accountId)}</td>
                <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{x.date}</td>
                <td><DeleteBtn onClick={() => update((list) => list.filter((y) => y.id !== x.id))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function ExpenseForm({ accounts, onCancel, onSave }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("Rent");
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayISO());
  const [accountId, setAccountId] = useState((accounts[0] && accounts[0].id) || "");
  const submit = () => {
    if (!title.trim() || !amount) return;
    onSave({ title, category, amount, date, accountId });
  };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>New expense</span>
        <button onClick={onCancel} style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer" }}><X size={16} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: 10 }}>
        <div>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Expense</label>
          <input className="mn-input" placeholder="e.g. Shop rent" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Category</label>
          <select className="mn-input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {["Rent", "Utilities (Bijli/Gas/Internet)", "Marketing/Ads", "Packaging/Shipping", "Staff Advance", "Miscellaneous", "Other"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Amount (Rs)</label>
          <input className="mn-input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Date</label>
          <input className="mn-input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: COLORS.textFaint, display: "block", marginBottom: 4 }}>Paid from</label>
          <select className="mn-input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <button className="mn-btn" onClick={submit}>Save</button>
        <button className="mn-btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Finance({ data, metrics }) {
  const pendingReceivables = data.orders.filter((o) => o.status !== "Returned" && amountDueOf(o) > 0);
  const pendingSalaries = data.employees.filter((e) => e.status === "Pending");
  const pendingCommissions = data.affiliates.filter((a) => a.payment === "Pending");

  const ledger = useMemo(() => {
    const map = {};
    data.orders.forEach((o) => {
      if (o.status === "Returned") return;
      const due = amountDueOf(o);
      if (due <= 0) return;
      if (!map[o.customer]) map[o.customer] = { customer: o.customer, due: 0, nextDue: null };
      map[o.customer].due += due;
      if (o.dueDate && (!map[o.customer].nextDue || o.dueDate < map[o.customer].nextDue)) {
        map[o.customer].nextDue = o.dueDate;
      }
    });
    return Object.values(map).sort((a, b) => b.due - a.due);
  }, [data.orders]);

  const Row = ({ label, value, tone, big }) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${COLORS.borderSoft}` }}>
      <span style={{ fontSize: big ? 14 : 13, color: big ? COLORS.text : COLORS.textDim, fontWeight: big ? 600 : 400 }}>{label}</span>
      <span className="mn-num" style={{ fontSize: big ? 17 : 14, fontWeight: 600, color: tone === "positive" ? COLORS.positive : tone === "negative" ? COLORS.negative : COLORS.text }}>{fmt(value)}</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12 }}>
        <StatCard label="Revenue" value={fmt(metrics.revenue)} />
        <StatCard label="Cost of goods" value={fmt(metrics.cogs)} />
        <StatCard label="Gross profit" value={fmt(metrics.grossProfit)} tone={metrics.grossProfit >= 0 ? "positive" : "negative"} />
        <StatCard label="Net profit" value={fmt(metrics.netProfit)} tone={metrics.netProfit >= 0 ? "positive" : "negative"} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
          <SectionHeading title="Profit and loss" />
          <Row label="Revenue (delivered/shipped orders)" value={metrics.revenue} tone="positive" />
          <Row label="Cost of goods sold" value={-metrics.cogs} tone="negative" />
          <Row label="Gross profit" value={metrics.grossProfit} big />
          <Row label="Salaries" value={-metrics.salaries} tone="negative" />
          <Row label="Affiliate commissions" value={-metrics.commissions} tone="negative" />
          <Row label="Other expenses" value={-metrics.totalExpenses} tone="negative" />
          <Row label="Net profit" value={metrics.netProfit} big tone={metrics.netProfit >= 0 ? "positive" : "negative"} />
        </div>

        <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
          <SectionHeading title="Payments overview" />
          <Row label="Pending from customers" value={metrics.receivable} tone="negative" />
          <Row label="Pending salaries + commissions" value={metrics.payable} tone="negative" />
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 6 }}>
            {pendingReceivables.length === 0 && pendingSalaries.length === 0 && pendingCommissions.length === 0 ? (
              <EmptyRow text="Koi pending payment nahi." />
            ) : (
              <>
                {pendingReceivables.map((o) => <PendingLine key={o.id} label={`${o.customer} — ${o.orderNo}${o.dueDate ? ` (due ${o.dueDate})` : ""}`} value={amountDueOf(o)} tag="Receive" />)}
                {pendingSalaries.map((e) => <PendingLine key={e.id} label={`${e.name} — salary`} value={e.salary} tag="Pay" />)}
                {pendingCommissions.map((a) => <PendingLine key={a.id} label={`${a.name} — commission`} value={a.commission} tag="Pay" />)}
              </>
            )}
          </div>
        </div>
      </div>

      <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
        <SectionHeading title="Customer ledger (Khata)" />
        {ledger.length === 0 ? (
          <EmptyRow text="Koi udhar / partial payment pending nahi." />
        ) : (
          <table className="mn-table">
            <thead><tr><th>Customer</th><th>Amount due</th><th>Next due date</th></tr></thead>
            <tbody>
              {ledger.map((l) => (
                <tr key={l.customer}>
                  <td>{l.customer}</td>
                  <td className="mn-num" style={{ color: COLORS.negative }}>{fmt(l.due)}</td>
                  <td style={{ color: COLORS.textFaint, fontSize: 12 }}>{l.nextDue || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PendingLine({ label, value, tag }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
      <span style={{ color: COLORS.textDim }}>{tag === "Receive" ? "↓ " : "↑ "}{label}</span>
      <span className="mn-num" style={{ color: COLORS.textFaint }}>{fmt(value)}</span>
    </div>
  );
}

function SearchBox({ value, onChange }) {
  return (
    <div style={{ position: "relative" }}>
      <Search size={14} style={{ position: "absolute", left: 9, top: 9, color: COLORS.textFaint }} />
      <input
        className="mn-input"
        style={{ paddingLeft: 30, width: 180 }}
        placeholder="Search..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function DeleteBtn({ onClick }) {
  return (
    <button onClick={onClick} style={{ background: "none", border: "none", color: COLORS.textFaint, cursor: "pointer", padding: 4 }}>
      <Trash2 size={14} />
    </button>
  );
}

function ChartCard({ title, children, height = 260 }) {
  return (
    <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 9, padding: 18 }}>
      <SectionHeading title={title} />
      <div style={{ width: "100%", height }}>{children}</div>
    </div>
  );
}

function Reports({ data }) {
  const byDate = useMemo(() => {
    const map = {};
    data.orders.forEach((o) => {
      if (o.status === "Returned") return;
      const d = o.date || todayISO();
      if (!map[d]) map[d] = { date: d, revenue: 0, cost: 0 };
      map[d].revenue += Number(o.sell || 0);
      map[d].cost += Number(o.cost || 0);
    });
    return Object.values(map)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({ ...r, profit: r.revenue - r.cost }));
  }, [data.orders]);

  const statusCounts = useMemo(() => {
    const order = ["Pending", "Shipped", "Delivered", "Returned"];
    return order.map((s) => ({ status: s, count: data.orders.filter((o) => o.status === s).length }));
  }, [data.orders]);

  const stockByCategory = useMemo(() => {
    const map = {};
    data.inventory.forEach((i) => {
      const cat = i.category || "Other";
      map[cat] = (map[cat] || 0) + Number(i.quantity || 0) * Number(i.cost || 0);
    });
    return Object.entries(map).map(([category, value]) => ({ category, value }));
  }, [data.inventory]);

  const hasOrders = data.orders.length > 0;
  const hasInventory = data.inventory.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ChartCard title="Revenue & profit trend">
        {!hasOrders ? <EmptyRow text="Chart k liye orders add karein." /> : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={byDate}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.borderSoft} />
              <XAxis dataKey="date" tick={{ fill: COLORS.textFaint, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
              <YAxis tick={{ fill: COLORS.textFaint, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} tickFormatter={(v) => (v >= 1000 ? `${v / 1000}k` : v)} />
              <Tooltip contentStyle={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontSize: 12 }} labelStyle={{ color: COLORS.text }} formatter={(v) => fmt(v)} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="revenue" name="Revenue" stroke={COLORS.info} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="profit" name="Profit" stroke={COLORS.positive} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <ChartCard title="Orders by status" height={240}>
          {!hasOrders ? <EmptyRow text="Koi order nahi." /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusCounts}>
                <CartesianGrid strokeDasharray="3 3" stroke={COLORS.borderSoft} />
                <XAxis dataKey="status" tick={{ fill: COLORS.textFaint, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: COLORS.textFaint, fontSize: 11 }} axisLine={{ stroke: COLORS.border }} tickLine={false} />
                <Tooltip contentStyle={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontSize: 12 }} />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {statusCounts.map((s, idx) => <Cell key={s.status} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        <ChartCard title="Stock value by category" height={240}>
          {!hasInventory ? <EmptyRow text="Koi inventory nahi." /> : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={stockByCategory} dataKey="value" nameKey="category" cx="50%" cy="50%" outerRadius={80} label={(e) => e.category}>
                  {stockByCategory.map((_, idx) => <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: COLORS.surface2, border: `1px solid ${COLORS.border}`, borderRadius: 6, fontSize: 12 }} formatter={(v) => fmt(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>
    </div>
  );
}
